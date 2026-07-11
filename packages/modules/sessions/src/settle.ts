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

export interface SettleSessionResult {
  alreadySettled: boolean;
  txnId: string;
}

export async function settleSession(
  pool: ActorPool,
  sessionId: string,
): Promise<SettleSessionResult> {
  return pool.withPlatform(async (db) => {
    const sessionRes = await db.query<{
      id: string;
      slot_id: string;
      school_id: string;
      teacher_id: string;
      status: string;
      settle_txn_id: string | null;
    }>(
      `SELECT id, slot_id, school_id, teacher_id, status, settle_txn_id
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
      price_cents: string;
      teacher_pay_cents: string;
      hold_txn_id: string | null;
      hold_released_txn_id: string | null;
    }>(
      `SELECT id, school_id, status, price_cents, teacher_pay_cents,
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

    const price = Number(slot.price_cents); // pg bigint → string
    const teacherPay = Number(slot.teacher_pay_cents);
    const platformCut = price - teacherPay; // DB CHECK: teacher_pay <= price → negatif olamaz

    const holdId = await ensureAccount(db, "school", slot.school_id, "wallet_hold");
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

    await db.query(
      `UPDATE class_session
          SET status = 'settled', settle_txn_id = $2, updated_at = now()
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
