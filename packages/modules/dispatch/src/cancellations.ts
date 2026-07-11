// İptal/no-show matrisi (kurucu onaylı sayılar):
//   okul ≥24s önce  → tam iade (hold release)
//   okul <24s içinde → %50 kesinti: eğitmene pay'in yarısı, kalan platforma
//   eğitmen düşerse → önce anında re-offer; olmazsa tam iade
//   eğitmen gelmezse → %100 otomatik iade (SLA kredisi) + strike (3'te suspend)
// Her fonksiyon TEK withPlatform transaction'ında koşar; slot satırı FOR UPDATE ile
// kilitlenir → aynı slota eşzamanlı iki para işlemi serileşir. Durum geçişlerinin
// whitelist'i DB trigger'ında — buradaki UPDATE'ler whitelist dışına çıkamaz.
import type { ActorPool, Db } from "@teachernow/db";
import { ensureAccount, postTxn, auditSlotAction } from "./ledger.js";
import { enqueueNotification } from "./notifications.js";
import { getSlotForUpdate, type SlotRow } from "./slots.js";
import { offerNext } from "./matcher.js";

const HOUR_MS = 60 * 60_000;

/**
 * Hold'u okula tam iade eder: [wallet_hold -price, school_cash +price].
 * Hold'suz (blocked) slotta no-op. İdempotency anahtarı reason'ı içerir;
 * hold_released_txn_id doluysa ikinci release'e izin verilmez.
 * (backfill SLA escalate'i de aynı kapıyı kullanır — dispatch içi export.)
 */
export async function releaseHold(db: Db, slot: SlotRow, reason: string): Promise<string | null> {
  if (!slot.hold_txn_id) return null; // blocked slot: hiç hold açılmamış
  if (slot.hold_released_txn_id) {
    throw new Error(`releaseHold: hold zaten serbest bırakılmış (slot=${slot.id})`);
  }
  const cashId = await ensureAccount(db, "school", slot.school_id, "school_cash");
  const holdId = await ensureAccount(db, "school", slot.school_id, "wallet_hold");
  const { txnId } = await postTxn(db, {
    key: `hold_release:slot:${slot.id}:${reason}`,
    type: "hold_release",
    refType: "booking_slot",
    refId: slot.id,
    entries: [
      { accountId: holdId, amountCents: `-${slot.price_cents}` },
      { accountId: cashId, amountCents: slot.price_cents },
    ],
  });
  await db.query(
    `UPDATE booking_slot SET hold_released_txn_id = $2, updated_at = now() WHERE id = $1`,
    [slot.id, txnId],
  );
  await auditSlotAction(db, slot, "slot_hold_released", {
    reason,
    release_txn_id: txnId,
    price_cents: slot.price_cents,
  });
  return txnId;
}

interface LiveAssignment {
  teacherId: string;
  /** iptal ANINDAKİ durum: 'offered' | 'confirmed' */
  priorStatus: string;
}

/** Slottaki canlı atamayı (offered/confirmed) cancelled'a çeker; önceki durumu döndürür. */
async function cancelLiveAssignment(db: Db, slotId: string): Promise<LiveAssignment | null> {
  const live = await db.query<{ id: string; teacher_id: string; status: string }>(
    `SELECT id, teacher_id, status FROM assignment
      WHERE slot_id = $1 AND status IN ('offered', 'confirmed')
      FOR UPDATE`,
    [slotId],
  );
  const row = live.rows[0];
  if (!row) return null;
  await db.query(`UPDATE assignment SET status = 'cancelled', updated_at = now() WHERE id = $1`, [
    row.id,
  ]);
  return { teacherId: row.teacher_id, priorStatus: row.status };
}

/**
 * Okul iptalinden etkilenen ONAYLI eğitmene 'teacher_slot_cancelled' outbox kaydı —
 * iptalle AYNI transaction'da. Yalnız okul iptalinde çağrılır: teacherDrop'ta eğitmen
 * dersi kendisi bıraktığı için ona iptal maili ATILMAZ. Geç iptalde eğitmen payının
 * %50'si ödenir; şablon bunu lateCancel bayrağından söyler.
 */
async function enqueueTeacherCancelledNotification(
  db: Db,
  slot: SlotRow,
  teacherId: string,
  lateCancel: boolean,
): Promise<void> {
  const ctx = await db.query<{ email: string; timezone: string; school_name: string }>(
    `SELECT t.email, t.timezone, s.name AS school_name
       FROM teacher t
       JOIN school s ON s.id = $2
      WHERE t.id = $1`,
    [teacherId, slot.school_id],
  );
  const row = ctx.rows[0];
  if (!row) throw new Error(`cancelBySchool: eğitmen bulunamadı (teacher=${teacherId})`);
  await enqueueNotification(db, {
    recipientEmail: row.email,
    template: "teacher_slot_cancelled",
    payload: {
      slotStartsAt: slot.starts_at.toISOString(),
      schoolName: row.school_name,
      teacherTimezone: row.timezone,
      lateCancel,
    },
  });
}

export interface CancelBySchoolInput {
  slotId: string;
  now?: Date;
}

export interface CancelBySchoolResult {
  slotId: string;
  status: "cancelled_school_early" | "cancelled_school_late";
}

/**
 * Okul iptali. Yalnız 'scheduled' slotlarda; başlamış ders iptal edilemez.
 * ≥24 saat: tam iade. <24 saat: hold TEK transaction'da bölüşülür —
 * okula price-floor(price/2), eğitmene floor(teacher_pay/2), kalan platforma.
 */
export async function cancelBySchool(
  pool: ActorPool,
  input: CancelBySchoolInput,
): Promise<CancelBySchoolResult> {
  const now = input.now ?? new Date();
  return pool.withPlatform(async (db) => {
    const slot = await getSlotForUpdate(db, input.slotId);
    if (!slot) throw new Error(`cancelBySchool: slot bulunamadı: ${input.slotId}`);
    if (slot.status !== "scheduled") {
      throw new Error(`cancelBySchool: yalnız scheduled slot iptal edilebilir (${slot.status})`);
    }
    if (slot.starts_at.getTime() <= now.getTime()) {
      throw new Error("cancelBySchool: başlamış ders iptal edilemez");
    }

    const live = await cancelLiveAssignment(db, slot.id);

    const early = slot.starts_at.getTime() - now.getTime() >= 24 * HOUR_MS;
    if (early) {
      await releaseHold(db, slot, "school_early");
      await db.query(
        `UPDATE booking_slot SET status = 'cancelled_school_early', updated_at = now() WHERE id = $1`,
        [slot.id],
      );
      await auditSlotAction(db, slot, "slot_cancel_early", { occurrence_key: slot.occurrence_key });
      // Yalnız ONAYLI eğitmen haberdar edilir; henüz teklif aşamasındakine mail atılmaz.
      if (live?.priorStatus === "confirmed") {
        await enqueueTeacherCancelledNotification(db, slot, live.teacherId, false);
      }
      return { slotId: slot.id, status: "cancelled_school_early" };
    }

    // <24 saat: hold tek txn'de dağıtılır (release + kesinti birlikte, ara durum yok)
    if (!slot.hold_txn_id) {
      throw new Error(`cancelBySchool: scheduled slotta hold yok (slot=${slot.id})`);
    }
    const price = Number(slot.price_cents);
    const teacherPay = Number(slot.teacher_pay_cents);
    const half = Math.floor(price / 2);
    // Eğitmen payı yalnız ONAYLANMIŞ atamaya ödenir; eğitmensiz/yalnız teklifli
    // slotta kesintinin tamamı platforma kalır (eğitmen bacağı hiç doğmaz).
    const teacherId = live?.priorStatus === "confirmed" ? live.teacherId : null;
    const tpHalf = teacherId ? Math.floor(teacherPay / 2) : 0;

    const cashId = await ensureAccount(db, "school", slot.school_id, "school_cash");
    const holdId = await ensureAccount(db, "school", slot.school_id, "wallet_hold");
    const revenueId = await ensureAccount(db, "platform", null, "platform_revenue");
    const entries = [
      { accountId: holdId, amountCents: -price },
      { accountId: cashId, amountCents: price - half },
      { accountId: revenueId, amountCents: half - tpHalf },
    ];
    if (teacherId && tpHalf > 0) {
      const payableId = await ensureAccount(db, "teacher", teacherId, "teacher_payable");
      entries.push({ accountId: payableId, amountCents: tpHalf });
    }
    const { txnId } = await postTxn(db, {
      key: `late_cancel:slot:${slot.id}`,
      type: "late_cancel",
      refType: "booking_slot",
      refId: slot.id,
      entries: entries.filter((e) => e.amountCents !== 0), // sıfır bacak ledger CHECK'ine takılır
    });
    await db.query(
      `UPDATE booking_slot
          SET status = 'cancelled_school_late', hold_released_txn_id = $2, updated_at = now()
        WHERE id = $1`,
      [slot.id, txnId],
    );
    await auditSlotAction(db, slot, "slot_late_cancel", {
      txn_id: txnId,
      refund_cents: price - half,
      teacher_half_cents: tpHalf,
      platform_cents: half - tpHalf,
    });
    // Onaylı eğitmene iptal + %50 ödeme bilgisi (lateCancel) aynı transaction'da düşer.
    if (teacherId) {
      await enqueueTeacherCancelledNotification(db, slot, teacherId, true);
    }
    return { slotId: slot.id, status: "cancelled_school_late" };
  });
}

export interface TeacherDropInput {
  slotId: string;
}

export type TeacherDropResult =
  | { reoffered: true; teacherId: string }
  | { reoffered: false };

/**
 * Onaylı eğitmen dersi bırakır: atama dropped, slot cancelled_teacher, HEMEN re-offer.
 * Aday çıkarsa slot scheduled'a döner (hold'a DOKUNULMAZ); çıkmazsa hold iade edilir.
 * Bilinçli karar: bırakan eğitmene 'teacher_slot_cancelled' YAZILMAZ — dersi kendisi
 * bıraktı; iptal bildirimi yalnız okul iptalinden etkilenen eğitmene gider.
 */
export async function teacherDrop(
  pool: ActorPool,
  input: TeacherDropInput,
): Promise<TeacherDropResult> {
  return pool.withPlatform(async (db) => {
    const slot = await getSlotForUpdate(db, input.slotId);
    if (!slot) throw new Error(`teacherDrop: slot bulunamadı: ${input.slotId}`);
    if (slot.status !== "scheduled") {
      throw new Error(`teacherDrop: slot scheduled değil (${slot.status})`);
    }

    const dropped = await db.query(
      `UPDATE assignment
          SET status = 'dropped', updated_at = now()
        WHERE slot_id = $1 AND status = 'confirmed'`,
      [slot.id],
    );
    if (dropped.rowCount === 0) {
      throw new Error(`teacherDrop: slotta confirmed atama yok (slot=${input.slotId})`);
    }

    await db.query(
      `UPDATE booking_slot SET status = 'cancelled_teacher', updated_at = now() WHERE id = $1`,
      [slot.id],
    );

    // Anında backfill: dropped eğitmen findCandidates'te dışlanır (aynı slot).
    const next = await offerNext(db, slot);
    if (next) {
      await db.query(
        `UPDATE booking_slot SET status = 'scheduled', updated_at = now() WHERE id = $1`,
        [slot.id],
      );
      await auditSlotAction(db, slot, "slot_teacher_drop_reoffered", {
        next_teacher_id: next.teacherId,
      });
      return { reoffered: true, teacherId: next.teacherId };
    }

    await releaseHold(db, slot, "teacher_drop");
    await auditSlotAction(db, slot, "slot_teacher_drop_refunded", {
      occurrence_key: slot.occurrence_key,
    });
    return { reoffered: false };
  });
}

export interface TeacherNoShowInput {
  slotId: string;
}

export interface TeacherNoShowResult {
  strikeCount: number;
  suspended: boolean;
}

/**
 * Eğitmen no-show: okula %100 otomatik iade (SLA kredisi), atama cancelled,
 * eğitmene strike; 3. strike'ta suspend (yalnız 'active' durumundan).
 */
export async function teacherNoShow(
  pool: ActorPool,
  input: TeacherNoShowInput,
): Promise<TeacherNoShowResult> {
  return pool.withPlatform(async (db) => {
    const slot = await getSlotForUpdate(db, input.slotId);
    if (!slot) throw new Error(`teacherNoShow: slot bulunamadı: ${input.slotId}`);
    if (slot.status !== "scheduled") {
      throw new Error(`teacherNoShow: slot scheduled değil (${slot.status})`);
    }

    const cancelled = await db.query<{ teacher_id: string }>(
      `UPDATE assignment
          SET status = 'cancelled', updated_at = now()
        WHERE slot_id = $1 AND status = 'confirmed'
        RETURNING teacher_id`,
      [slot.id],
    );
    const teacherId = cancelled.rows[0]?.teacher_id;
    if (!teacherId) {
      throw new Error(`teacherNoShow: slotta confirmed atama yok (slot=${input.slotId})`);
    }

    await db.query(
      `UPDATE booking_slot SET status = 'no_show_teacher', updated_at = now() WHERE id = $1`,
      [slot.id],
    );
    await releaseHold(db, slot, "no_show_teacher");

    const struck = await db.query<{ strike_count: number; status: string }>(
      `UPDATE teacher
          SET strike_count = strike_count + 1, updated_at = now()
        WHERE id = $1
        RETURNING strike_count, status`,
      [teacherId],
    );
    const row = struck.rows[0];
    if (!row) throw new Error(`teacherNoShow: eğitmen bulunamadı: ${teacherId}`);

    let suspended = false;
    if (row.strike_count >= 3 && row.status === "active") {
      // teacher durum makinesi active→suspended geçişine izin verir
      await db.query(
        `UPDATE teacher SET status = 'suspended', updated_at = now() WHERE id = $1`,
        [teacherId],
      );
      suspended = true;
    }

    await auditSlotAction(db, slot, "slot_no_show_teacher", {
      teacher_id: teacherId,
      strike_count: row.strike_count,
      suspended,
      refund_cents: slot.price_cents,
    });
    return { strikeCount: row.strike_count, suspended };
  });
}
