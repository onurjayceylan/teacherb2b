// Para yazımı TEK kapıdan: SECURITY DEFINER post_ledger_txn / ensure_ledger_account.
// sessions başka modül import etmez (boundary kuralı: yalnız @teachernow/db) —
// SQL fonksiyonları doğrudan çağrılır; ters kayıt da 7 parametreli formla buradan atılır.
import type { Db } from "@teachernow/db";

export type OwnerType = "school" | "teacher" | "platform";

export interface LedgerEntryInput {
  accountId: string;
  /** pg bigint'i string döndürür; ikisi de kabul edilir. */
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
  /** Ters kayıt: orijinal txn id (ledger_txn_single_reversal tek reversal'ı zorlar). */
  reversesTxnId?: string;
  /** reversesTxnId verildiyse zorunlu (DB CHECK). */
  reasonCode?: string;
}

export async function postTxn(
  db: Db,
  input: PostTxnInput,
): Promise<{ txnId: string; created: boolean }> {
  const entriesJson = JSON.stringify(
    input.entries.map((e) => ({ account_id: e.accountId, amount_cents: e.amountCents })),
  );
  const res = await db.query<{ txn_id: string; created: boolean }>(
    "SELECT * FROM post_ledger_txn($1, $2, $3, $4, $5::jsonb, $6, $7)",
    [
      input.key,
      input.type,
      input.refType,
      input.refId,
      entriesJson,
      input.reversesTxnId ?? null,
      input.reasonCode ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`postTxn: post_ledger_txn satır dönmedi (key=${input.key})`);
  return { txnId: row.txn_id, created: row.created };
}
