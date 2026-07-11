// Materializer: aktif dosaj planlarını ufuk penceresi içinde booking_slot'a döker.
// İdempotenlik anahtarı UNIQUE(plan_id, occurrence_key) — ikinci koşu aynı satırı
// ON CONFLICT DO NOTHING ile atlar. Her occurrence KENDİ platform transaction'ında
// işlenir: bir okulun bakiye sorunu diğer planların materializasyonunu durdurmaz.
import type { ActorPool, Db } from "@teachernow/db";
import { DateTime } from "luxon";
import { occurrenceToUtc } from "./time.js";
import { ensureAccount, postTxn, auditSlotAction } from "./ledger.js";
import { offerNext } from "./matcher.js";
import type { SlotRow } from "./slots.js";

export interface MaterializeFailedPlan {
  planId: string;
  error: string;
}

export interface MaterializeResult {
  created: number;
  blocked: number;
  skipped: number;
  /**
   * Plan-başına yalıtılmış hatalar (geriye uyumlu ekleme: yalnız hata varsa dolu).
   * blocked_insufficient_funds buraya GİRMEZ — o bir hata değil, beklenen sonuçtur.
   */
  failedPlans?: MaterializeFailedPlan[];
}

export interface MaterializeOptions {
  horizonWeeks?: number;
  now?: Date;
}

/**
 * Slot için okul kasasından hold alır ([school_cash -price, wallet_hold +price]) ve
 * booking_slot.hold_txn_id'yi doldurur. İdempotency anahtarı 'hold:slot:<id>' —
 * materializer VE retryBlockedSlots (P0-B) AYNI kapıyı kullanır; anahtar sabit olduğu
 * için çift hold post_ledger_txn seviyesinde yapısal imkânsızdır. Yetersiz bakiye
 * (23514) / kill-switch (P0001) hataları çağırana fırlar — çağıran transaction'ı geri sarar.
 */
export async function postSlotHold(
  db: Db,
  slot: { id: string; school_id: string; price_cents: string },
): Promise<string> {
  const cashId = await ensureAccount(db, "school", slot.school_id, "school_cash");
  const holdId = await ensureAccount(db, "school", slot.school_id, "wallet_hold");
  const { txnId } = await postTxn(db, {
    key: `hold:slot:${slot.id}`,
    type: "hold",
    refType: "booking_slot",
    refId: slot.id,
    entries: [
      { accountId: cashId, amountCents: `-${slot.price_cents}` },
      { accountId: holdId, amountCents: slot.price_cents },
    ],
  });
  await db.query(`UPDATE booking_slot SET hold_txn_id = $2, updated_at = now() WHERE id = $1`, [
    slot.id,
    txnId,
  ]);
  return txnId;
}

interface PlanRow {
  id: string;
  school_id: string;
  class_group_id: string;
  pool_id: string;
  weekday: number;
  start_minute: number;
  duration_min: number;
  school_tz: string;
  price_cents: string;
  teacher_pay_cents: string;
  start_date: string;
  weeks: number;
}

/** Planın okul-lokal occurrence tarihlerini (YYYY-MM-DD) üretir; exception'ları düşer. */
function occurrenceDates(plan: PlanRow, skipDates: ReadonlySet<string>): string[] {
  const start = DateTime.fromISO(plan.start_date, { zone: plan.school_tz });
  if (!start.isValid) {
    // start_date DB'de date kolonu — geçersizlik pratikte bozuk school_tz demektir.
    throw new Error(
      `materializer: geçersiz start_date/school_tz: ${plan.start_date} (${plan.school_tz})`,
    );
  }
  // start_date'ten itibaren plan.weekday'e denk gelen İLK tarih (ISO: luxon 1..7 → 0..6)
  const offsetDays = (plan.weekday - (start.weekday - 1) + 7) % 7;
  const dates: string[] = [];
  for (let week = 0; week < plan.weeks; week += 1) {
    const occurrence = start.plus({ days: offsetDays + week * 7 });
    const iso = occurrence.toISODate();
    if (iso && !skipDates.has(iso)) dates.push(iso);
  }
  return dates;
}

/**
 * Aktif planları gezer; now..now+horizon penceresine düşen occurrence'lar için slot açar,
 * okul kasasından hold alır ve eğitmen teklifini başlatır. Hold açılamazsa (yetersiz
 * bakiye / kill-switch) slot 'blocked_insufficient_funds' olarak yazılır — para izi YOK.
 */
export async function materializePlans(
  pool: ActorPool,
  opts: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const horizonWeeks = opts.horizonWeeks ?? 4;
  const now = opts.now ?? new Date();
  const horizonEnd = new Date(now.getTime() + horizonWeeks * 7 * 24 * 60 * 60_000);

  const { plans, skipsByPlan } = await pool.withPlatform(async (db) => {
    const planRes = await db.query<PlanRow>(
      `SELECT id, school_id, class_group_id, pool_id, weekday, start_minute, duration_min,
              school_tz, price_cents, teacher_pay_cents, start_date::text AS start_date, weeks
         FROM dosage_plan
        WHERE status = 'active'
        ORDER BY created_at`,
    );
    const skipRes = await db.query<{ plan_id: string; skip_date: string }>(
      `SELECT plan_id, skip_date::text AS skip_date FROM plan_exception`,
    );
    const byPlan = new Map<string, Set<string>>();
    for (const row of skipRes.rows) {
      const set = byPlan.get(row.plan_id) ?? new Set<string>();
      set.add(row.skip_date);
      byPlan.set(row.plan_id, set);
    }
    return { plans: planRes.rows, skipsByPlan: byPlan };
  });

  const result: MaterializeResult = { created: 0, blocked: 0, skipped: 0 };
  const failedPlans: MaterializeFailedPlan[] = [];
  for (const plan of plans) {
    // Plan-başına yalıtım: tek planın hatası (bozuk tz, FK, beklenmedik DB hatası)
    // koşunun kalanını düşürmez. Patlayan occurrence'ın kendi transaction'ı zaten
    // geri sarıldı; audit izi AYRI transaction'da yazılır ve diğer planlara geçilir.
    try {
      const skips = skipsByPlan.get(plan.id) ?? new Set<string>();
      for (const dateISO of occurrenceDates(plan, skips)) {
        const window = occurrenceToUtc(
          dateISO,
          plan.start_minute,
          plan.duration_min,
          plan.school_tz,
        );
        if (window.startsAt < now || window.startsAt > horizonEnd) continue;

        // Her occurrence tek transaction: slot + hold + teklif birlikte görünür olur.
        const outcome = await pool.withPlatform((db) =>
          materializeOccurrence(db, plan, dateISO, window.startsAt, window.endsAt, now),
        );
        result[outcome] += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await pool.withPlatform((db) =>
        db.query(
          `INSERT INTO audit_log (actor_kind, school_id, action, entity_type, entity_id, after)
           VALUES ('system', $1, 'materializer_plan_failed', 'dosage_plan', $2, $3::jsonb)`,
          [plan.school_id, plan.id, JSON.stringify({ plan_id: plan.id, error: message })],
        ),
      );
      failedPlans.push({ planId: plan.id, error: message });
    }
  }
  if (failedPlans.length > 0) result.failedPlans = failedPlans;
  return result;
}

async function materializeOccurrence(
  db: Db,
  plan: PlanRow,
  dateISO: string,
  startsAt: Date,
  endsAt: Date,
  now: Date,
): Promise<"created" | "blocked" | "skipped"> {
  // SAVEPOINT INSERT'ten ÖNCE alınır: hold patlarsa slot da geri sarılır ve
  // 'blocked_insufficient_funds' statüsüyle TEMİZ yeniden yazılır (scheduled→blocked
  // geçişi DB whitelist'inde yok — bilinçli: blocked yalnız doğum anında yazılabilir).
  await db.query("SAVEPOINT occurrence");
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO booking_slot
       (school_id, plan_id, class_group_id, pool_id, occurrence_key,
        starts_at, ends_at, price_cents, teacher_pay_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (plan_id, occurrence_key) DO NOTHING
     RETURNING id`,
    [
      plan.school_id,
      plan.id,
      plan.class_group_id,
      plan.pool_id,
      dateISO,
      startsAt,
      endsAt,
      plan.price_cents,
      plan.teacher_pay_cents,
    ],
  );
  const slotRow = inserted.rows[0];
  if (!slotRow) {
    await db.query("RELEASE SAVEPOINT occurrence");
    return "skipped"; // idempotent: bu occurrence zaten materialize edilmiş
  }
  const slotId = slotRow.id;

  let holdTxnId: string;
  try {
    holdTxnId = await postSlotHold(db, {
      id: slotId,
      school_id: plan.school_id,
      price_cents: plan.price_cents,
    });
    await db.query("RELEASE SAVEPOINT occurrence");
  } catch (err) {
    const code = (err as { code?: string }).code;
    // 23514: school_cash min_zero CHECK (yetersiz bakiye); P0001: payments_frozen kill-switch
    if (code !== "23514" && code !== "P0001") throw err;
    await db.query("ROLLBACK TO SAVEPOINT occurrence");
    // Slot aynı id ile, hold'suz ve doğrudan 'blocked' statüsüyle yeniden yazılır.
    await db.query(
      `INSERT INTO booking_slot
         (id, school_id, plan_id, class_group_id, pool_id, occurrence_key,
          starts_at, ends_at, price_cents, teacher_pay_cents, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'blocked_insufficient_funds')
       ON CONFLICT (plan_id, occurrence_key) DO NOTHING`,
      [
        slotId,
        plan.school_id,
        plan.id,
        plan.class_group_id,
        plan.pool_id,
        dateISO,
        startsAt,
        endsAt,
        plan.price_cents,
        plan.teacher_pay_cents,
      ],
    );
    await auditSlotAction(
      db,
      { id: slotId, school_id: plan.school_id },
      "slot_blocked_insufficient_funds",
      { occurrence_key: dateISO, price_cents: plan.price_cents },
    );
    return "blocked";
  }

  const slot: SlotRow = {
    id: slotId,
    school_id: plan.school_id,
    plan_id: plan.id,
    class_group_id: plan.class_group_id,
    pool_id: plan.pool_id,
    occurrence_key: dateISO,
    starts_at: startsAt,
    ends_at: endsAt,
    price_cents: plan.price_cents,
    teacher_pay_cents: plan.teacher_pay_cents,
    status: "scheduled",
    hold_txn_id: holdTxnId,
    hold_released_txn_id: null,
  };
  await auditSlotAction(db, slot, "slot_hold_created", {
    hold_txn_id: holdTxnId,
    price_cents: plan.price_cents,
    occurrence_key: dateISO,
  });
  // Eğitmen teklifini hemen başlat; aday yoksa slot scheduled kalır (sorun değil).
  await offerNext(db, slot, { now });
  return "created";
}
