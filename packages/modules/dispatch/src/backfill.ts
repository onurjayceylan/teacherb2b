// Backfill SLA süpürücüsü — eğitmensiz kalmış gelecekteki slotların güvenlik ağı:
//   (a) cancelled_teacher + derse slaHours'tan ÇOK var → yeniden teklif (aday çıkarsa
//       slot scheduled'a döner; hold'a DOKUNULMAZ — para durumu drop anında çözülmüştü).
//   (b) scheduled + canlı ataması yok + derse slaHours'tan çok var → sıradaki adaya teklif.
//   (c) derse slaHours ya da daha az kaldı ve hâlâ eğitmen yok → ESCALATE: slot escalated,
//       hold varsa okula tam iade (SLA sözü) + audit ('sla_escalated') — insan devreye girer.
// Her slot KENDİ platform transaction'ında işlenir: bir slotun hatası süpürücüyü durdurmaz;
// slot satırı FOR UPDATE ile kilitlenip koşullar tazeden doğrulanır (iptal/kabul yarışı).
import type { ActorPool, Db } from "@teachernow/db";
import { auditSlotAction } from "./ledger.js";
import { releaseHold } from "./cancellations.js";
import { offerNext } from "./matcher.js";
import { enqueueNotification } from "./notifications.js";
import { getSlotForUpdate, type SlotRow } from "./slots.js";

const HOUR_MS = 60 * 60_000;

export interface SweepBackfillOptions {
  now?: Date;
  /** derse bu kadar saat kala hâlâ eğitmen yoksa escalate (varsayılan 2) */
  slaHours?: number;
  /** açılan tekliflerin TTL'i (varsayılan 20 dk) */
  offerTtlMinutes?: number;
}

export interface SweepBackfillResult {
  /** scheduled slotlara açılan yeni teklif sayısı */
  offered: number;
  /** cancelled_teacher'dan scheduled'a döndürülen slot sayısı */
  reoffered: number;
  /** escalated'a çekilen (insan eskalasyonu) slot sayısı */
  escalated: number;
}

type SweepOutcome = keyof SweepBackfillResult | null;

export async function sweepBackfill(
  pool: ActorPool,
  opts: SweepBackfillOptions = {},
): Promise<SweepBackfillResult> {
  const now = opts.now ?? new Date();
  const slaHours = opts.slaHours ?? 2;
  const ttlMinutes = opts.offerTtlMinutes ?? 20;
  const slaCutoff = new Date(now.getTime() + slaHours * HOUR_MS);

  // Aday slotlar tek okumayla toplanır; karar her slotun kendi tx'inde tazeden verilir.
  const slotIds = await pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `SELECT id FROM booking_slot
        WHERE status IN ('scheduled', 'cancelled_teacher')
          AND starts_at > $1
          AND NOT EXISTS (
            SELECT 1 FROM assignment a
             WHERE a.slot_id = booking_slot.id AND a.status IN ('offered', 'confirmed'))
        ORDER BY starts_at`,
      [now],
    );
    return res.rows.map((r) => r.id);
  });

  const result: SweepBackfillResult = { offered: 0, reoffered: 0, escalated: 0 };
  for (const slotId of slotIds) {
    const outcome = await pool.withPlatform((db) =>
      sweepSlot(db, slotId, now, slaCutoff, slaHours, ttlMinutes),
    );
    if (outcome) result[outcome] += 1;
  }
  return result;
}

async function sweepSlot(
  db: Db,
  slotId: string,
  now: Date,
  slaCutoff: Date,
  slaHours: number,
  ttlMinutes: number,
): Promise<SweepOutcome> {
  const slot = await getSlotForUpdate(db, slotId);
  if (!slot) return null;
  // Koşullar kilit altında tazeden: ilk okuma ile bu tx arasında slot iptal edilmiş,
  // başlamış ya da teklif almış olabilir.
  if (slot.status !== "scheduled" && slot.status !== "cancelled_teacher") return null;
  if (slot.starts_at.getTime() <= now.getTime()) return null;
  const live = await db.query(
    `SELECT 1 FROM assignment WHERE slot_id = $1 AND status IN ('offered', 'confirmed')`,
    [slot.id],
  );
  if ((live.rowCount ?? 0) > 0) return null;

  // (c) SLA penceresi: derse slaHours ya da daha az kaldı → insan eskalasyonu.
  if (slot.starts_at.getTime() <= slaCutoff.getTime()) {
    // cancelled_teacher→escalated whitelist'te VAR — önce scheduled'a çekmek gerekmez.
    await db.query(
      `UPDATE booking_slot SET status = 'escalated', updated_at = now() WHERE id = $1`,
      [slot.id],
    );
    // Hold varsa SLA sözü gereği okula tam iade (cancelled_teacher yolunda çoğu kez
    // drop anında iade edilmiştir — o zaman hold_released_txn_id dolu, dokunulmaz).
    let releaseTxnId: string | null = null;
    if (slot.hold_txn_id && !slot.hold_released_txn_id) {
      releaseTxnId = await releaseHold(db, slot, "sla_escalated");
    }
    await auditSlotAction(db, slot, "sla_escalated", {
      occurrence_key: slot.occurrence_key,
      sla_hours: slaHours,
      prior_status: slot.status,
      release_txn_id: releaseTxnId,
    });
    // Okulun owner/admin kullanıcıları AYNI transaction'da haberdar edilir (outbox).
    await enqueueEscalationNotifications(db, slot, releaseTxnId ? Number(slot.price_cents) : 0);
    return "escalated";
  }

  // (a)/(b) Ders hâlâ uzakta: sıradaki adaya teklif aç. Aday yoksa slot OLDUĞU GİBİ
  // kalır (cancelled_teacher scheduled'a çekilmez — sonraki süpürüş yeniden dener).
  const next = await offerNext(db, slot, { now, offerTtlMinutes: ttlMinutes });
  if (!next) return null;

  if (slot.status === "cancelled_teacher") {
    await db.query(
      `UPDATE booking_slot SET status = 'scheduled', updated_at = now() WHERE id = $1`,
      [slot.id],
    );
    await auditSlotAction(db, slot, "slot_backfill_reoffered", {
      occurrence_key: slot.occurrence_key,
      next_teacher_id: next.teacherId,
    });
    return "reoffered";
  }
  return "offered";
}

/** Escalate edilen slotun okulundaki her owner/admin'e 'school_sla_escalated' kaydı. */
async function enqueueEscalationNotifications(
  db: Db,
  slot: SlotRow,
  refundedCents: number,
): Promise<void> {
  const ctx = await db.query<{ school_name: string; class_name: string }>(
    `SELECT s.name AS school_name, cg.name AS class_name
       FROM school s
       JOIN class_group cg ON cg.id = $2
      WHERE s.id = $1`,
    [slot.school_id, slot.class_group_id],
  );
  const admins = await db.query<{ email: string }>(
    `SELECT u.email
       FROM school_user su
       JOIN app_user u ON u.id = su.user_id
      WHERE su.school_id = $1 AND su.role IN ('owner', 'admin')
      ORDER BY u.email`,
    [slot.school_id],
  );
  for (const admin of admins.rows) {
    await enqueueNotification(db, {
      recipientEmail: admin.email,
      template: "school_sla_escalated",
      payload: {
        schoolName: ctx.rows[0]?.school_name ?? "",
        slotStartsAt: slot.starts_at.toISOString(),
        className: ctx.rows[0]?.class_name ?? "",
        refundedCents,
      },
    });
  }
}
