// Top-up yaşam döngüsü: kart (Stripe ile settle) + banka havalesi (admin settle).
import { randomBytes } from "node:crypto";
import type { Db } from "@teachernow/db";
import { ensureAccount, postTxn } from "./ledger.js";
import { enqueueNotification } from "./notifications.js";

export interface CreateCardTopupInput {
  schoolId: string;
  amountCents: number;
  createdBy?: string;
}

/** Okul bağlamında çağrılır; Stripe referansları sonradan attachStripeRefs ile bağlanır. */
export async function createCardTopup(db: Db, input: CreateCardTopupInput): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO topup_attempt (school_id, method, amount_cents, status, created_by)
     VALUES ($1, 'card', $2, 'initiated', $3)
     RETURNING id`,
    [input.schoolId, input.amountCents, input.createdBy ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error("createCardTopup: topup_attempt INSERT satır dönmedi");
  return row.id;
}

export interface AttachStripeRefsInput {
  topupId: string;
  checkoutId?: string;
  paymentIntentId?: string;
}

export async function attachStripeRefs(db: Db, input: AttachStripeRefsInput): Promise<void> {
  const res = await db.query(
    `UPDATE topup_attempt
        SET stripe_checkout_id    = COALESCE($2, stripe_checkout_id),
            stripe_payment_intent = COALESCE($3, stripe_payment_intent),
            updated_at            = now()
      WHERE id = $1`,
    [input.topupId, input.checkoutId ?? null, input.paymentIntentId ?? null],
  );
  if (res.rowCount === 0) {
    throw new Error(`attachStripeRefs: topup bulunamadı: ${input.topupId}`);
  }
}

export interface CreateBankTopupInput {
  schoolId: string;
  amountCents: number;
  bankAccountId?: string;
  createdBy?: string;
}

/** Okulun dekontuna yazacağı referans kodu üretir; admin bu kodla eşleştirip settle eder. */
export async function createBankTopup(
  db: Db,
  input: CreateBankTopupInput,
): Promise<{ id: string; referenceCode: string }> {
  const referenceCode = `TN-${randomBytes(4).toString("hex").toUpperCase()}`;
  const res = await db.query<{ id: string }>(
    `INSERT INTO topup_attempt
       (school_id, method, amount_cents, status, bank_reference_code, bank_account_id, created_by)
     VALUES ($1, 'bank_transfer', $2, 'pending_review', $3, $4, $5)
     RETURNING id`,
    [input.schoolId, input.amountCents, referenceCode, input.bankAccountId ?? null, input.createdBy ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error("createBankTopup: topup_attempt INSERT satır dönmedi");
  return { id: row.id, referenceCode };
}

export interface AdminSettleBankTopupInput {
  topupId: string;
  fxSourceCurrency?: string;
  fxSourceAmount?: number;
}

export interface SettleResult {
  alreadySettled: boolean;
  txnId?: string;
}

/** Platform bağlamında çağrılır: cleared-funds onayı → ledger post + topup settle + audit. */
export async function adminSettleBankTopup(
  db: Db,
  input: AdminSettleBankTopupInput,
): Promise<SettleResult> {
  const found = await db.query<{
    id: string;
    school_id: string;
    amount_cents: string;
    currency: string;
    status: string;
    bank_reference_code: string | null;
  }>(
    `SELECT id, school_id, amount_cents, currency, status, bank_reference_code
       FROM topup_attempt WHERE id = $1 FOR UPDATE`,
    [input.topupId],
  );
  const topup = found.rows[0];
  if (!topup) throw new Error(`adminSettleBankTopup: topup bulunamadı: ${input.topupId}`);
  if (topup.status === "settled") return { alreadySettled: true };

  const cashId = await ensureAccount(db, "school", topup.school_id, "school_cash", topup.currency);
  const clearingId = await ensureAccount(db, "platform", null, "bank_clearing", topup.currency);
  const { txnId } = await postTxn(db, {
    key: `topup:${topup.id}`,
    type: "topup",
    refType: "topup_attempt",
    refId: topup.id,
    entries: [
      { accountId: cashId, amountCents: topup.amount_cents },
      { accountId: clearingId, amountCents: `-${topup.amount_cents}` },
    ],
  });

  await db.query(
    `UPDATE topup_attempt
        SET status = 'settled', settled_txn_id = $2, settled_at = now(),
            fx_source_currency = COALESCE($3, fx_source_currency),
            fx_source_amount   = COALESCE($4, fx_source_amount),
            updated_at = now()
      WHERE id = $1`,
    [topup.id, txnId, input.fxSourceCurrency ?? null, input.fxSourceAmount ?? null],
  );

  await db.query(
    `INSERT INTO audit_log (actor_kind, school_id, action, entity_type, entity_id, after)
     VALUES ('platform_admin', $1, 'bank_topup_settled', 'topup_attempt', $2, $3::jsonb)`,
    [topup.school_id, topup.id, JSON.stringify({ status: "settled", settled_txn_id: txnId })],
  );

  // Okulun owner/admin kullanıcıları AYNI transaction'da haberdar edilir
  // (outbox deseni — dispatch'in school_sla_escalated alıcı çözümüyle aynı).
  const members = await db.query<{ email: string; school_name: string }>(
    `SELECT u.email, s.name AS school_name
       FROM school_user su
       JOIN app_user u ON u.id = su.user_id
       JOIN school s ON s.id = su.school_id
      WHERE su.school_id = $1 AND su.role IN ('owner', 'admin')
      ORDER BY u.email`,
    [topup.school_id],
  );
  for (const member of members.rows) {
    await enqueueNotification(db, {
      recipientEmail: member.email,
      template: "school_topup_settled",
      payload: {
        schoolName: member.school_name,
        amountCents: Number(topup.amount_cents),
        referenceCode: topup.bank_reference_code,
      },
    });
  }

  return { alreadySettled: false, txnId };
}
