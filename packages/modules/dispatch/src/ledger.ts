// Para yazımı TEK kapıdan: SECURITY DEFINER post_ledger_txn / ensure_ledger_account.
// dispatch başka modül import etmez (boundary kuralı) — SQL fonksiyonları doğrudan çağrılır.
import type { Db } from "@teachernow/db";

export type OwnerType = "school" | "teacher" | "platform";

export interface LedgerEntryInput {
  accountId: string;
  /** pg bigint'i string döndürür; string de kabul edilir. */
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

/** Para etkili işlemler için audit izi (actor_kind 'system'). */
export async function auditSlotAction(
  db: Db,
  slot: { id: string; school_id: string },
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_kind, school_id, action, entity_type, entity_id, after)
     VALUES ('system', $1, $2, 'booking_slot', $3, $4::jsonb)`,
    [slot.school_id, action, slot.id, JSON.stringify(after)],
  );
}
