// P1-B (denetim-3-rol-tur2): rejectSettle SONRASI paranın çözüm yolu.
// Reddedilen ders 'ended'+hold'lu ve slot 'scheduled' kalıyordu — okulun parası tanımsız
// süre kilitliydi. Admin kararıyla: hold OKULA TAM iade edilir (hold_release), slot
// 'voided_review' terminal durumuna çekilir (0016 whitelist: scheduled→voided_review),
// eğitmene 'teacher_payment_adjusted' (kind='review_rejected') bildirimi AYNI
// transaction'da düşer. Ders hiç ücretlendirilmez — eğitmen bacağı zaten doğmamıştı.
// İdempotenlik: ikinci çağrıda slot artık 'scheduled' olmadığı için anlamlı hata döner;
// para bacağının anahtarı da sabittir ('void_review:slot:<id>') — çift iade yapısal imkânsız.
import type { ActorPool } from "@teachernow/db";
import { ensureAccount, postTxn } from "./ledger.js";

export interface VoidRejectedSessionInput {
  sessionId: string;
}

export interface VoidRejectedSessionResult {
  /** okula iade edilen tutar (slot fiyatının tamamı) */
  refundCents: number;
  /** hold_release txn'ının id'si (slot.hold_released_txn_id'ye de yazılır) */
  txnId: string;
}

export async function voidRejectedSession(
  pool: ActorPool,
  input: VoidRejectedSessionInput,
): Promise<VoidRejectedSessionResult> {
  return pool.withPlatform(async (db) => {
    const sessionRes = await db.query<{
      id: string;
      slot_id: string;
      school_id: string;
      teacher_id: string;
      status: string;
      settle_txn_id: string | null;
      review_rejected_at: Date | null;
    }>(
      `SELECT id, slot_id, school_id, teacher_id, status, settle_txn_id, review_rejected_at
         FROM class_session WHERE id = $1 FOR UPDATE`,
      [input.sessionId],
    );
    const session = sessionRes.rows[0];
    if (!session) {
      throw new Error(`voidRejectedSession: oturum bulunamadı: ${input.sessionId}`);
    }
    if (session.status !== "ended") {
      throw new Error(
        `voidRejectedSession: yalnız 'ended' oturum void edilebilir (${session.status})`,
      );
    }
    if (session.settle_txn_id) {
      throw new Error(
        `voidRejectedSession: oturum settle edilmiş — void edilemez (txn=${session.settle_txn_id})`,
      );
    }
    if (!session.review_rejected_at) {
      throw new Error(
        `voidRejectedSession: oturumun settle reddi yok (review_rejected_at boş)`,
      );
    }

    // Slot FOR UPDATE: aynı slotun parasına dokunan akışlarla (settle/iptal) serileşir.
    const slotRes = await db.query<{
      id: string;
      school_id: string;
      status: string;
      starts_at: Date;
      price_cents: string;
      hold_txn_id: string | null;
      hold_released_txn_id: string | null;
    }>(
      `SELECT id, school_id, status, starts_at, price_cents, hold_txn_id, hold_released_txn_id
         FROM booking_slot WHERE id = $1 FOR UPDATE`,
      [session.slot_id],
    );
    const slot = slotRes.rows[0];
    if (!slot) throw new Error(`voidRejectedSession: slot bulunamadı: ${session.slot_id}`);
    if (slot.status !== "scheduled") {
      // İkinci void denemesi buraya düşer (slot 'voided_review') — para OYNAMAZ.
      throw new Error(
        `voidRejectedSession: slot 'scheduled' değil (${slot.status}) — zaten çözülmüş olabilir`,
      );
    }
    if (!slot.hold_txn_id || slot.hold_released_txn_id) {
      throw new Error(`voidRejectedSession: slotta iade edilecek hold yok (slot=${slot.id})`);
    }

    // Hold okula TAM iade — dispatch'in erken iptal hold-release entry deseniyle aynı:
    // [wallet_hold -price, school_cash +price].
    const price = Number(slot.price_cents); // pg bigint → string
    const holdId = await ensureAccount(db, "school", slot.school_id, "wallet_hold");
    const cashId = await ensureAccount(db, "school", slot.school_id, "school_cash");
    const { txnId } = await postTxn(db, {
      key: `void_review:slot:${slot.id}`,
      type: "hold_release",
      refType: "booking_slot",
      refId: slot.id,
      entries: [
        { accountId: holdId, amountCents: -price },
        { accountId: cashId, amountCents: price },
      ],
    });

    await db.query(
      `UPDATE booking_slot
          SET status = 'voided_review', hold_released_txn_id = $2, updated_at = now()
        WHERE id = $1`,
      [slot.id, txnId],
    );
    await db.query(
      `INSERT INTO audit_log (actor_kind, school_id, action, entity_type, entity_id, after)
       VALUES ('system', $1, 'session_voided_review', 'class_session', $2, $3::jsonb)`,
      [
        slot.school_id,
        session.id,
        JSON.stringify({
          slot_id: slot.id,
          release_txn_id: txnId,
          refund_cents: price,
          review_rejected_at: session.review_rejected_at.toISOString(),
        }),
      ],
    );

    // Eğitmene ödeme yapılmayacağı bilgisi AYNI transaction'da outbox'a düşer
    // (şablon eğitmen-yüzlü — dispatcher tarafında İngilizce).
    const teacherRes = await db.query<{ email: string; timezone: string }>(
      "SELECT email, timezone FROM teacher WHERE id = $1",
      [session.teacher_id],
    );
    const teacher = teacherRes.rows[0];
    if (!teacher) {
      throw new Error(`voidRejectedSession: eğitmen bulunamadı: ${session.teacher_id}`);
    }
    const schoolRes = await db.query<{ name: string }>("SELECT name FROM school WHERE id = $1", [
      slot.school_id,
    ]);
    await db.query(
      `INSERT INTO notification_outbox (recipient_email, template, payload)
       VALUES ($1, 'teacher_payment_adjusted', $2::jsonb)`,
      [
        teacher.email,
        JSON.stringify({
          kind: "review_rejected",
          lessonStartsAt: slot.starts_at.toISOString(),
          teacherTimezone: teacher.timezone,
          schoolName: schoolRes.rows[0]?.name ?? "",
        }),
      ],
    );

    return { refundCents: price, txnId };
  });
}
