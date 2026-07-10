// Ledger yazımı TEK kapıdan geçer: SECURITY DEFINER post_ledger_txn / ensure_ledger_account.
// Bu sarmalayıcılar tabloya doğrudan yazmaz; idempotency ve SUM=0 garantisi DB fonksiyonundadır.
import type { Db } from "@teachernow/db";

export type OwnerType = "school" | "teacher" | "platform";

export interface LedgerEntryInput {
  accountId: string;
  /** bigint güvenliği için string de kabul edilir (pg bigint'i string döndürür). */
  amountCents: number | string;
}

export async function ensureAccount(
  db: Db,
  ownerType: OwnerType,
  ownerId: string | null,
  kind: string,
  currency = "USD",
): Promise<string> {
  const res = await db.query<{ id: string }>(
    "SELECT ensure_ledger_account($1, $2, $3, $4) AS id",
    [ownerType, ownerId, kind, currency],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`ensureAccount: hesap yaratılamadı (kind=${kind})`);
  return row.id;
}

export interface PostTxnInput {
  key: string;
  type: string;
  refType: string;
  refId: string;
  entries: LedgerEntryInput[];
}

export async function postTxn(
  db: Db,
  input: PostTxnInput,
): Promise<{ txnId: string; created: boolean }> {
  const entriesJson = JSON.stringify(
    input.entries.map((e) => ({ account_id: e.accountId, amount_cents: e.amountCents })),
  );
  const res = await db.query<{ txn_id: string; created: boolean }>(
    "SELECT * FROM post_ledger_txn($1, $2, $3, $4, $5::jsonb)",
    [input.key, input.type, input.refType, input.refId, entriesJson],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`postTxn: post_ledger_txn satır dönmedi (key=${input.key})`);
  return { txnId: row.txn_id, created: row.created };
}
