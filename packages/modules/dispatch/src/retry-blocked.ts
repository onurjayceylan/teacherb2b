// P0-B (denetim-3-rol-tur2): bakiye yüklenince bloke slotların OTOMATİK açılışı.
// Sihirbazın "bakiye yüklenince otomatik denenir" vaadinin kod yolu budur —
// backfill-sweeper her koşumda önce bunu çağırır. Gelecekteki
// 'blocked_insufficient_funds' slotları okul+starts_at sırasıyla tarar
// (idx_slot_blocked_retry kısmi indeksi; sıra = "bakiye önce en yakın derse").
// Her slot KENDİ platform transaction'ında denenir: hold materializer'la AYNI
// idempotency anahtarından ('hold:slot:<id>' — postSlotHold) geçer, çift hold
// yapısal imkânsızdır. Bakiye yetmezse (23514) transaction geri sarılır, okulun
// KALAN bloke slotları atlanır (daha yakın ders fonlanamadıysa uzağı hiç deneme).
// Kill-switch (P0001, payments_frozen) para yolunu kapatır: koşu durur, kalanlar
// stillBlocked sayılır — mevcut para yollarındaki davranışın aynısı.
import type { ActorPool, Db } from "@teachernow/db";
import { auditSlotAction } from "./ledger.js";
import { offerNext } from "./matcher.js";
import { postSlotHold } from "./materializer.js";
import { getSlotForUpdate, type SlotRow } from "./slots.js";

export interface RetryBlockedResult {
  /** hold açılıp scheduled'a çekilen slot sayısı */
  retried: number;
  /** bakiye yetmediği (ya da kill-switch yüzünden) bloke kalan slot sayısı */
  stillBlocked: number;
  /** açılan slotlardan hemen teklif de çıkanların sayısı */
  offered: number;
}

export interface RetryBlockedOptions {
  now?: Date;
}

export async function retryBlockedSlots(
  pool: ActorPool,
  opts: RetryBlockedOptions = {},
): Promise<RetryBlockedResult> {
  const now = opts.now ?? new Date();

  // Adaylar tek okumayla toplanır; karar her slotun kendi tx'inde kilit altında
  // tazeden verilir (bu arada slot iptal edilmiş / zaten açılmış olabilir).
  const candidates = await pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string; school_id: string }>(
      `SELECT id, school_id FROM booking_slot
        WHERE status = 'blocked_insufficient_funds' AND starts_at > $1
        ORDER BY school_id, starts_at`,
      [now],
    );
    return res.rows;
  });

  const result: RetryBlockedResult = { retried: 0, stillBlocked: 0, offered: 0 };
  const skipSchools = new Set<string>();
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    if (skipSchools.has(candidate.school_id)) {
      result.stillBlocked += 1;
      continue;
    }
    try {
      const outcome = await pool.withPlatform((db) => retrySlot(db, candidate.id, now));
      if (outcome === "skipped") continue; // yarışta durum değişmiş — sayılmaz
      result.retried += 1;
      if (outcome === "offered") result.offered += 1;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23514") {
        // school_cash min_zero CHECK: bakiye bu slota yetmedi → transaction geri
        // sarıldı (slot bloke kaldı); okulun kalan bloke slotlarını bu koşuda atla.
        skipSchools.add(candidate.school_id);
        result.stillBlocked += 1;
        continue;
      }
      if (code === "P0001") {
        // payments_frozen kill-switch: para yolu kapalı — koşunun kalanına dokunma.
        result.stillBlocked += candidates.length - i;
        break;
      }
      throw err;
    }
  }
  return result;
}

export interface ExpireBlockedResult {
  /** geçmiş-tarihli olduğu için 'expired_blocked'a çekilen slot sayısı */
  expired: number;
}

/**
 * Geçmiş-tarihli (starts_at <= now) 'blocked_insufficient_funds' slotları terminal
 * 'expired_blocked'a çeker: ders günü geçti, bakiye geç geldi → ders artık YAPILAMAZ, slot
 * sonsuza dek stranded kalmasın. Bloke slotta HOLD YOKTUR → para OYNAMAZ; yine de defensive
 * olarak yalnız hold_txn_id IS NULL olanlar kapatılır (beklenmedik biçimde hold'lu bir bloke
 * slot varsa DOKUNULMAZ — elle incelenir, para stranded edilmez). Her kapanış audit'lenir.
 */
export async function expirePastBlockedSlots(
  pool: ActorPool,
  opts: RetryBlockedOptions = {},
): Promise<ExpireBlockedResult> {
  const now = opts.now ?? new Date();
  return pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string; school_id: string }>(
      `UPDATE booking_slot
          SET status = 'expired_blocked', updated_at = now()
        WHERE status = 'blocked_insufficient_funds'
          AND starts_at <= $1
          AND hold_txn_id IS NULL
        RETURNING id, school_id`,
      [now],
    );
    for (const row of res.rows) {
      await db.query(
        `INSERT INTO audit_log (actor_kind, school_id, action, entity_type, entity_id, after)
         VALUES ('system', $1, 'slot_expired_blocked', 'booking_slot', $2, $3::jsonb)`,
        [row.school_id, row.id, JSON.stringify({ reason: "past_dated_blocked" })],
      );
    }
    return { expired: res.rows.length };
  });
}

type RetryOutcome = "offered" | "unblocked" | "skipped";

async function retrySlot(db: Db, slotId: string, now: Date): Promise<RetryOutcome> {
  const slot = await getSlotForUpdate(db, slotId);
  if (!slot || slot.status !== "blocked_insufficient_funds") return "skipped";
  if (slot.starts_at.getTime() <= now.getTime()) return "skipped";

  // Hold materializer'ın kapısından (aynı anahtar deseni) — 23514/P0001 çağırana fırlar.
  const holdTxnId = await postSlotHold(db, slot);
  // blocked_insufficient_funds → scheduled geçişi DB whitelist'inde (0016).
  await db.query(`UPDATE booking_slot SET status = 'scheduled', updated_at = now() WHERE id = $1`, [
    slot.id,
  ]);
  await auditSlotAction(db, slot, "slot_unblocked", {
    hold_txn_id: holdTxnId,
    price_cents: slot.price_cents,
    occurrence_key: slot.occurrence_key,
  });

  // Teklifi hemen dene; aday yoksa sorun değil — backfill-sweeper scheduled slotları
  // zaten tarıyor.
  const scheduled: SlotRow = { ...slot, status: "scheduled", hold_txn_id: holdTxnId };
  const next = await offerNext(db, scheduled, { now });
  return next ? "offered" : "unblocked";
}
