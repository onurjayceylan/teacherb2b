// SETTLE — para döngüsünün kapanışı: dispatch'in slot açılışında aldığı hold
// (wallet_hold'da slot.price_cents durur) tek transaction'da bölüşülür:
//   wallet_hold  -price
//   teacher_payable +teacher_pay
//   platform_revenue +(price - teacher_pay)
// school_cash'e DOKUNULMAZ — hold alınırken okul kasasından zaten düşülmüştü.
// İdempotency anahtarı sabit ('settle:session:<id>') + oturum satırı FOR UPDATE →
// eşzamanlı iki settle serileşir, ikincisi alreadySettled görür.
import type { ActorPool } from "@teachernow/db";
import { ensureAccount, postTxn } from "./ledger.js";

/** Settled sonuç: para hareket etti (ya da replay'de aynı txn'e işaret edildi). */
export interface SettleSessionSettled {
  alreadySettled: boolean;
  txnId: string;
  reviewRequired?: false;
  reason?: undefined;
}

/** İnsan-onay sonucu: PARA HAREKETİ YOK — ders review kuyruğuna düştü. */
export interface SettleSessionReview {
  alreadySettled?: false;
  txnId?: undefined;
  reviewRequired: true;
  reason: string;
}

/** Geriye uyumlu union: {txnId} | {alreadySettled} | {reviewRequired, reason}. */
export type SettleSessionResult = SettleSessionSettled | SettleSessionReview;

export interface SettleSessionOptions {
  /**
   * Admin onayı: review guard'larını (erken start / kısa ders) atlayıp settle eder
   * ve review_required bayrağını false'a çeker. Varsayılan false.
   */
  force?: boolean;
}

/** Erken başlatma guard eşiği: started_at < slot.starts_at - 15 dk → insan onayı. */
const EARLY_START_GRACE_MS = 15 * 60_000;

export async function settleSession(
  pool: ActorPool,
  sessionId: string,
  opts: SettleSessionOptions = {},
): Promise<SettleSessionResult> {
  const force = opts.force ?? false;
  return pool.withPlatform(async (db) => {
    const sessionRes = await db.query<{
      id: string;
      slot_id: string;
      school_id: string;
      teacher_id: string;
      status: string;
      settle_txn_id: string | null;
      started_at: Date | null;
      dosage_min: number | null;
      review_required: boolean;
    }>(
      `SELECT id, slot_id, school_id, teacher_id, status, settle_txn_id,
              started_at, dosage_min, review_required
         FROM class_session WHERE id = $1 FOR UPDATE`,
      [sessionId],
    );
    const session = sessionRes.rows[0];
    if (!session) throw new Error(`settleSession: oturum bulunamadı: ${sessionId}`);
    if (session.status === "settled") {
      if (!session.settle_txn_id) {
        throw new Error(`settleSession: settled oturumda settle_txn_id yok (${sessionId})`);
      }
      return { alreadySettled: true, txnId: session.settle_txn_id };
    }
    if (session.status !== "ended") {
      throw new Error(`settleSession: yalnız 'ended' oturum settle edilir (${session.status})`);
    }

    // Slot satırı FOR UPDATE: aynı slota eşzamanlı para işlemi (iptal vb.) serileşir.
    const slotRes = await db.query<{
      id: string;
      school_id: string;
      status: string;
      starts_at: Date;
      ends_at: Date;
      price_cents: string;
      teacher_pay_cents: string;
      hold_txn_id: string | null;
      hold_released_txn_id: string | null;
    }>(
      `SELECT id, school_id, status, starts_at, ends_at, price_cents, teacher_pay_cents,
              hold_txn_id, hold_released_txn_id
         FROM booking_slot WHERE id = $1 FOR UPDATE`,
      [session.slot_id],
    );
    const slot = slotRes.rows[0];
    if (!slot) throw new Error(`settleSession: slot bulunamadı: ${session.slot_id}`);
    if (slot.status !== "scheduled") {
      throw new Error(`settleSession: slot 'scheduled' değil (${slot.status})`);
    }
    if (!slot.hold_txn_id || slot.hold_released_txn_id) {
      throw new Error(`settleSession: slotta tüketilecek hold yok (slot=${slot.id})`);
    }

    // İnsan-onay guard'ları (para-güven bulgusu): şüpheli ders OTOMATİK settle edilmez.
    // (a) erken başlatma — startSession penceresi bunu artık engelliyor; guard eski/yarış
    //     verileri için kalır. (b) kısa ders — dosaj planlanan sürenin yarısından az.
    if (!force) {
      const dosageMin = session.dosage_min ?? 0;
      const plannedMin = Math.round(
        (slot.ends_at.getTime() - slot.starts_at.getTime()) / 60_000,
      );
      const reasons: string[] = [];
      // review_reason eğitmen panelinde gösterilir → eğitmen-yüzlü metin İngilizce.
      if (
        session.started_at &&
        session.started_at.getTime() < slot.starts_at.getTime() - EARLY_START_GRACE_MS
      ) {
        reasons.push(
          `early start: started at ${session.started_at.toISOString()} (scheduled ${slot.starts_at.toISOString()})`,
        );
      }
      if (dosageMin < plannedMin * 0.5) {
        reasons.push(`short lesson: ${dosageMin} min (planned ${plannedMin} min)`);
      }
      if (reasons.length > 0) {
        const reason = reasons.join(" / ");
        await db.query(
          `UPDATE class_session
              SET review_required = true, review_reason = $2, updated_at = now()
            WHERE id = $1`,
          [sessionId, reason],
        );
        // Aynı oturum için tekrarlanan settle denemeleri audit'i şişirmesin.
        if (!session.review_required) {
          await db.query(
            `INSERT INTO audit_log (actor_kind, school_id, action, entity_type, entity_id, after)
             VALUES ('system', $1, 'settle_review_required', 'class_session', $2, $3::jsonb)`,
            [
              slot.school_id,
              sessionId,
              JSON.stringify({
                reason,
                dosage_min: dosageMin,
                planned_min: plannedMin,
                started_at: session.started_at,
                slot_starts_at: slot.starts_at,
              }),
            ],
          );
        }
        return { reviewRequired: true, reason };
      }
    }

    const price = Number(slot.price_cents); // pg bigint → string
    const teacherPay = Number(slot.teacher_pay_cents);
    const platformCut = price - teacherPay; // DB CHECK: teacher_pay <= price → negatif olamaz

    const holdId = await ensureAccount(db, "school", slot.school_id, "wallet_hold");
    // Alacak session.teacher_id'ye yazılır. Bunun güncel confirmed eğitmen olması
    // ensureSessionForSlot'un start ANINDA yaptığı senkron'a dayanır (teklif-tekrarında
    // 'created' oturum eski eğitmende kalabilirdi) — 'ended'e ancak o senkronlu start'tan
    // geçilir, o yüzden settle burada yeniden senkron aramaz.
    const payableId = await ensureAccount(db, "teacher", session.teacher_id, "teacher_payable");
    const revenueId = await ensureAccount(db, "platform", null, "platform_revenue");

    const { txnId } = await postTxn(db, {
      key: `settle:session:${sessionId}`,
      type: "session_settle",
      refType: "class_session",
      refId: sessionId,
      entries: [
        { accountId: holdId, amountCents: -price },
        { accountId: payableId, amountCents: teacherPay },
        { accountId: revenueId, amountCents: platformCut },
      ].filter((e) => e.amountCents !== 0), // sıfır bacak ledger CHECK'ine takılır
    });

    // force=true insan onayıdır: settle ile birlikte review bayrağı da kapanır
    // (review_reason iz olarak kalır).
    await db.query(
      `UPDATE class_session
          SET status = 'settled', settle_txn_id = $2, review_required = false, updated_at = now()
        WHERE id = $1`,
      [sessionId, txnId],
    );
    await db.query(
      "UPDATE booking_slot SET status = 'completed', updated_at = now() WHERE id = $1",
      [slot.id],
    );
    await db.query(
      `INSERT INTO audit_log (actor_kind, school_id, action, entity_type, entity_id, after)
       VALUES ('system', $1, 'session_settled', 'class_session', $2, $3::jsonb)`,
      [
        slot.school_id,
        sessionId,
        JSON.stringify({
          txn_id: txnId,
          slot_id: slot.id,
          price_cents: price,
          teacher_pay_cents: teacherPay,
          platform_cents: platformCut,
        }),
      ],
    );

    return { alreadySettled: false, txnId };
  });
}
