// Okul itirazı: karar Faz-1'de insanda (kurucu). Para düzeltmesi DAİMA ters kayıtla —
// settle txn'inin negatif kopyası reverses_txn_id + reason_code ile atılır (hold geri
// doğar), ardından hold okula iade edilir. Eğitmen alacağı clawback ters kayıtta doğal
// olarak düşer (teacher_payable eksiye inebilir — payout netting'i S5 konusu).
import type { ActorPool, Db } from "@teachernow/db";
import { ensureAccount, postTxn } from "./ledger.js";

export interface OpenDisputeInput {
  sessionId: string;
  schoolId: string;
  reason: string;
  createdBy?: string;
}

/** İtiraz yalnız settled oturuma açılır (para düzeltmesi = mevcut settle'ın tersi). */
export async function openDispute(db: Db, input: OpenDisputeInput): Promise<string> {
  const res = await db.query<{ status: string; school_id: string }>(
    "SELECT status, school_id FROM class_session WHERE id = $1",
    [input.sessionId],
  );
  const session = res.rows[0];
  if (!session) throw new Error(`openDispute: oturum bulunamadı: ${input.sessionId}`);
  if (session.status !== "settled") {
    throw new Error(`openDispute: yalnız settled oturuma itiraz açılır (${session.status})`);
  }
  if (session.school_id !== input.schoolId) {
    throw new Error(`openDispute: oturum bu okula ait değil (session=${input.sessionId})`);
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO session_dispute (session_id, school_id, reason, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.sessionId, input.schoolId, input.reason, input.createdBy ?? null],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("openDispute: dispute yazılamadı");
  return row.id;
}

export interface ResolveDisputeInput {
  disputeId: string;
  decision: "rejected" | "refund";
  note: string;
}

/**
 * Karar okulun owner/admin kullanıcılarına 'school_dispute_resolved' outbox kaydı olarak
 * AYNI transaction'da düşer (dispatch'in school_sla_escalated alıcı deseni). Boundary:
 * sessions dispatch'i import edemez — outbox INSERT'i burada yereldir. outcome sözlüğü:
 * 'released' = itiraz reddedildi (ödeme eğitmende kalır), 'refunded' = ücret iade edildi.
 */
async function enqueueDisputeResolvedNotifications(
  db: Db,
  input: {
    schoolId: string;
    sessionId: string;
    outcome: "released" | "refunded";
    refundedCents?: number;
  },
): Promise<void> {
  const ctx = await db.query<{ starts_at: Date; school_name: string }>(
    `SELECT sl.starts_at, s.name AS school_name
       FROM class_session cs
       JOIN booking_slot sl ON sl.id = cs.slot_id
       JOIN school s ON s.id = cs.school_id
      WHERE cs.id = $1`,
    [input.sessionId],
  );
  const info = ctx.rows[0];
  const admins = await db.query<{ email: string }>(
    `SELECT u.email
       FROM school_user su
       JOIN app_user u ON u.id = su.user_id
      WHERE su.school_id = $1 AND su.role IN ('owner', 'admin')
      ORDER BY u.email`,
    [input.schoolId],
  );
  for (const admin of admins.rows) {
    await db.query(
      `INSERT INTO notification_outbox (recipient_email, template, payload)
       VALUES ($1, 'school_dispute_resolved', $2::jsonb)`,
      [
        admin.email,
        JSON.stringify({
          outcome: input.outcome,
          slotStartsAt: info?.starts_at.toISOString() ?? "",
          schoolName: info?.school_name ?? "",
          ...(input.refundedCents !== undefined ? { refundedCents: input.refundedCents } : {}),
        }),
      ],
    );
  }
}

export type ResolveDisputeResult =
  | { status: "rejected" }
  | { status: "resolved_refund"; refundTxnId: string; releaseTxnId: string };

/**
 * TEK platform transaction'ında karar:
 *  - rejected: yalnız durum + not + resolved_at.
 *  - refund: (1) settle entry'lerinin NEGATİF kopyası (reverses_txn_id=settle_txn_id,
 *    reason_code='dispute') → hold geri doğar, eğitmen alacağı geri alınır;
 *    (2) hold okula iade: [wallet_hold -price, school_cash +price].
 * İdempotency anahtarları sabit; dispute satırı FOR UPDATE → çifte karar imkânsız.
 */
export async function resolveDispute(
  pool: ActorPool,
  input: ResolveDisputeInput,
): Promise<ResolveDisputeResult> {
  return pool.withPlatform(async (db) => {
    const disputeRes = await db.query<{
      id: string;
      session_id: string;
      school_id: string;
      status: string;
    }>(
      "SELECT id, session_id, school_id, status FROM session_dispute WHERE id = $1 FOR UPDATE",
      [input.disputeId],
    );
    const dispute = disputeRes.rows[0];
    if (!dispute) throw new Error(`resolveDispute: dispute bulunamadı: ${input.disputeId}`);
    if (dispute.status !== "open") {
      throw new Error(`resolveDispute: dispute açık değil (${dispute.status})`);
    }

    if (input.decision === "rejected") {
      await db.query(
        `UPDATE session_dispute
            SET status = 'rejected', resolution_note = $2, resolved_at = now()
          WHERE id = $1`,
        [dispute.id, input.note],
      );
      await db.query(
        `INSERT INTO audit_log (actor_kind, school_id, action, entity_type, entity_id, after)
         VALUES ('system', $1, 'dispute_rejected', 'session_dispute', $2, $3::jsonb)`,
        [dispute.school_id, dispute.id, JSON.stringify({ session_id: dispute.session_id })],
      );
      await enqueueDisputeResolvedNotifications(db, {
        schoolId: dispute.school_id,
        sessionId: dispute.session_id,
        outcome: "released",
      });
      return { status: "rejected" };
    }

    // ---- refund ----
    const sessionRes = await db.query<{
      slot_id: string;
      status: string;
      settle_txn_id: string | null;
    }>(
      "SELECT slot_id, status, settle_txn_id FROM class_session WHERE id = $1 FOR UPDATE",
      [dispute.session_id],
    );
    const session = sessionRes.rows[0];
    if (!session) throw new Error(`resolveDispute: oturum bulunamadı: ${dispute.session_id}`);
    if (session.status !== "settled" || !session.settle_txn_id) {
      throw new Error(`resolveDispute: oturum settle edilmemiş (${session.status})`);
    }

    // Slot FOR UPDATE: aynı slotun parasına dokunan diğer akışlarla serileşir.
    const slotRes = await db.query<{ id: string; school_id: string; price_cents: string }>(
      "SELECT id, school_id, price_cents FROM booking_slot WHERE id = $1 FOR UPDATE",
      [session.slot_id],
    );
    const slot = slotRes.rows[0];
    if (!slot) throw new Error(`resolveDispute: slot bulunamadı: ${session.slot_id}`);

    // (1) Settle'ın negatif kopyası — @teachernow/ledger import edilmez (boundary);
    // orijinal bacaklar SELECT edilip ters çevrilir, reversal işareti txn'e yazılır.
    const entriesRes = await db.query<{ account_id: string; amount_cents: string }>(
      "SELECT account_id, amount_cents FROM ledger_entry WHERE txn_id = $1 ORDER BY id",
      [session.settle_txn_id],
    );
    if (entriesRes.rows.length === 0) {
      throw new Error(`resolveDispute: settle txn bacakları bulunamadı (${session.settle_txn_id})`);
    }
    const { txnId: refundTxnId } = await postTxn(db, {
      key: `dispute_refund:session:${dispute.session_id}`,
      type: "dispute_refund",
      refType: "class_session",
      refId: dispute.session_id,
      entries: entriesRes.rows.map((e) => ({
        accountId: e.account_id,
        amountCents: -Number(e.amount_cents),
      })),
      reversesTxnId: session.settle_txn_id,
      reasonCode: "dispute",
    });

    // (2) Geri doğan hold okula iade edilir.
    const price = Number(slot.price_cents);
    const holdId = await ensureAccount(db, "school", slot.school_id, "wallet_hold");
    const cashId = await ensureAccount(db, "school", slot.school_id, "school_cash");
    const { txnId: releaseTxnId } = await postTxn(db, {
      key: `dispute_release:session:${dispute.session_id}`,
      type: "dispute_release",
      refType: "class_session",
      refId: dispute.session_id,
      entries: [
        { accountId: holdId, amountCents: -price },
        { accountId: cashId, amountCents: price },
      ],
    });

    await db.query(
      `UPDATE session_dispute
          SET status = 'resolved_refund', resolution_note = $2, refund_txn_id = $3,
              resolved_at = now()
        WHERE id = $1`,
      [dispute.id, input.note, refundTxnId],
    );
    await db.query(
      `INSERT INTO audit_log (actor_kind, school_id, action, entity_type, entity_id, after)
       VALUES ('system', $1, 'dispute_refund', 'session_dispute', $2, $3::jsonb)`,
      [
        dispute.school_id,
        dispute.id,
        JSON.stringify({
          session_id: dispute.session_id,
          refund_txn_id: refundTxnId,
          release_txn_id: releaseTxnId,
          price_cents: price,
        }),
      ],
    );
    await enqueueDisputeResolvedNotifications(db, {
      schoolId: dispute.school_id,
      sessionId: dispute.session_id,
      outcome: "refunded",
      refundedCents: price,
    });

    return { status: "resolved_refund", refundTxnId, releaseTxnId };
  });
}
