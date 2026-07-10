// @teachernow/ledger — SQL para çekirdeğinin (post_ledger_txn ailesi) ince TypeScript sarmalayıcısı.
// Tüm fonksiyonlar aktif bir transaction içindeki PoolClient bekler (ActorPool.with* içinden çağır).
import type { PoolClient } from "pg";

export type AccountOwnerType = "school" | "teacher" | "platform";

export type AccountKind =
  | "school_cash"
  | "school_promo"
  | "wallet_hold"
  | "school_receivable"
  | "teacher_payable"
  | "platform_revenue"
  | "stripe_clearing"
  | "bank_clearing"
  | "wise_clearing"
  | "fx_gain_loss"
  | "adjustment_reserve";

export interface EnsureAccountParams {
  ownerType: AccountOwnerType;
  /** platform hesaplarında null olmalı (DB CHECK bunu zorlar) */
  ownerId: string | null;
  kind: AccountKind;
  currency?: string;
}

export interface LedgerEntryInput {
  accountId: string;
  amountCents: number;
}

export interface PostTxnParams {
  idempotencyKey: string;
  type: string;
  refType?: string;
  refId?: string;
  entries: LedgerEntryInput[];
  reversesTxnId?: string;
  reasonCode?: string;
}

export interface PostTxnResult {
  txnId: string;
  created: boolean;
}

export interface PostReversalParams {
  ofTxnId: string;
  idempotencyKey: string;
  reasonCode: string;
}

export interface InvariantViolation {
  checkName: string;
  detail: string;
}

export async function ensureAccount(db: PoolClient, params: EnsureAccountParams): Promise<string> {
  const res = await db.query<{ id: string }>(
    "SELECT ensure_ledger_account($1, $2, $3, $4) AS id",
    [params.ownerType, params.ownerId, params.kind, params.currency ?? "USD"],
  );
  const row = res.rows[0];
  if (!row?.id) throw new Error("ensureAccount: hesap oluşturulamadı");
  return row.id;
}

export async function postTxn(db: PoolClient, params: PostTxnParams): Promise<PostTxnResult> {
  for (const e of params.entries) {
    // JSON'a girmeden yakala: float/aşırı büyük değerler sessiz hassasiyet kaybı yaratır
    if (!Number.isSafeInteger(e.amountCents)) {
      throw new Error(`postTxn: amountCents tam sayı olmalı (hesap ${e.accountId})`);
    }
  }
  const entriesJson = JSON.stringify(
    params.entries.map((e) => ({ account_id: e.accountId, amount_cents: e.amountCents })),
  );
  const res = await db.query<{ txn_id: string; created: boolean }>(
    "SELECT * FROM post_ledger_txn($1, $2, $3, $4, $5::jsonb, $6, $7)",
    [
      params.idempotencyKey,
      params.type,
      params.refType ?? null,
      params.refId ?? null,
      entriesJson,
      params.reversesTxnId ?? null,
      params.reasonCode ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error("postTxn: post_ledger_txn sonuç döndürmedi");
  return { txnId: row.txn_id, created: row.created };
}

export async function postReversal(db: PoolClient, params: PostReversalParams): Promise<PostTxnResult> {
  const res = await db.query<{ account_id: string; amount_cents: string }>(
    "SELECT account_id, amount_cents FROM ledger_entry WHERE txn_id = $1",
    [params.ofTxnId],
  );
  if (res.rows.length === 0) {
    throw new Error(`postReversal: txn bulunamadı ya da entry'si yok: ${params.ofTxnId}`);
  }
  const entries = res.rows.map((r) => {
    const amount = Number(r.amount_cents); // pg bigint'i string döndürür
    if (!Number.isSafeInteger(amount)) {
      throw new Error(`postReversal: amount_cents güvenli tam sayı aralığı dışında: ${r.amount_cents}`);
    }
    return { accountId: r.account_id, amountCents: -amount };
  });
  return postTxn(db, {
    idempotencyKey: params.idempotencyKey,
    type: "reversal",
    entries,
    reversesTxnId: params.ofTxnId,
    reasonCode: params.reasonCode,
  });
}

export async function getCachedBalance(db: PoolClient, accountId: string): Promise<number> {
  const res = await db.query<{ balance_cents: string }>(
    "SELECT balance_cents FROM ledger_account WHERE id = $1",
    [accountId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`getCachedBalance: hesap yok: ${accountId}`);
  return Number(row.balance_cents);
}

export async function deriveBalance(db: PoolClient, accountId: string): Promise<number> {
  const res = await db.query<{ sum: string }>(
    "SELECT COALESCE(SUM(amount_cents), 0)::bigint AS sum FROM ledger_entry WHERE account_id = $1",
    [accountId],
  );
  return Number(res.rows[0]?.sum ?? 0);
}

export async function setPaymentsFrozen(db: PoolClient, frozen: boolean, detail?: string): Promise<void> {
  const res = await db.query(
    "UPDATE system_flag SET value = $1, detail = $2, updated_at = now() WHERE key = 'payments_frozen'",
    [frozen, detail ?? null],
  );
  if (res.rowCount !== 1) throw new Error("setPaymentsFrozen: payments_frozen satırı bulunamadı");
}

export async function isPaymentsFrozen(db: PoolClient): Promise<boolean> {
  const res = await db.query<{ value: boolean }>(
    "SELECT value FROM system_flag WHERE key = 'payments_frozen'",
  );
  const row = res.rows[0];
  if (!row) throw new Error("isPaymentsFrozen: payments_frozen satırı bulunamadı");
  return row.value;
}

export async function invariantViolations(db: PoolClient): Promise<InvariantViolation[]> {
  const res = await db.query<{ check_name: string; detail: string }>(
    "SELECT check_name, detail FROM ledger_invariant_violations()",
  );
  return res.rows.map((r) => ({ checkName: r.check_name, detail: r.detail }));
}
