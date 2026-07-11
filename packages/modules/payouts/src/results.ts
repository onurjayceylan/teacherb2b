// Wise sonuç dosyası mutabakatı — paranın LEDGER'A İŞLEDİĞİ tek yer.
// paid: CAS submitted→paid + post_ledger_txn (key 'payout_paid:<payoutId>') ile
//   [teacher_payable -amount, wise_clearing +amount]; external_ref tek-sefer yazılır.
// failed: CAS submitted→failed + failure_reason; LEDGER'A DOKUNULMAZ — alacak
//   teacher_payable'da korunur, sonraki batch aynı alacağı yeniden toplar.
// Replay güvenliği iki katmanlı: CAS (zaten paid/failed satır 'warnings'e düşer) +
// post_ledger_txn idempotency key'i (aynı key ikinci kez ASLA bakiye değiştirmez).
import type { ActorPool } from "@teachernow/db";
import { ensureAccount, postTxn } from "./ledger.js";

export interface ImportResultRow {
  idempotencyKey: string;
  externalRef: string;
  status: "paid" | "failed";
  failureReason?: string;
}

export interface ImportResultsResult {
  paid: number;
  failed: number;
  warnings: string[];
}

/**
 * TEK platform transaction'ında sonuç satırlarını işler. Eşleşmeyen, batch dışı
 * ya da submitted olmayan (zaten paid/failed, henüz pending...) satırlar warnings'e
 * yazılır — dosyanın kalanı işlenmeye devam eder.
 */
export async function importResults(
  pool: ActorPool,
  batchId: string,
  rows: ImportResultRow[],
): Promise<ImportResultsResult> {
  return pool.withPlatform(async (db) => {
    const result: ImportResultsResult = { paid: 0, failed: 0, warnings: [] };

    for (const row of rows) {
      // Satır kilidi: aynı payout'a eşzamanlı iki import serileşir.
      const found = await db.query<{
        id: string;
        teacher_id: string;
        amount_cents: string;
        status: string;
      }>(
        `SELECT id, teacher_id, amount_cents, status
           FROM payout
          WHERE provider_idempotency_key = $1 AND batch_id = $2
          FOR UPDATE`,
        [row.idempotencyKey, batchId],
      );
      const payout = found.rows[0];
      if (!payout) {
        result.warnings.push(`eşleşmeyen satır: ${row.idempotencyKey}`);
        continue;
      }
      if (payout.status !== "submitted") {
        // zaten paid (replay) / failed / pending — hiçbir şey işlenmez, yalnız raporlanır
        result.warnings.push(
          `payout submitted değil (${payout.status}): ${row.idempotencyKey}`,
        );
        continue;
      }

      if (row.status === "paid") {
        // Önce para: alacak eğitmenden düşer, Wise clearing'e biner. Idempotency
        // anahtarı payout'a sabit → aynı dosyanın replay'i çift düşüm yapamaz.
        const payableId = await ensureAccount(db, "teacher", payout.teacher_id, "teacher_payable");
        const wiseId = await ensureAccount(db, "platform", null, "wise_clearing");
        const { txnId } = await postTxn(db, {
          key: `payout_paid:${payout.id}`,
          type: "payout_paid",
          refType: "payout",
          refId: payout.id,
          entries: [
            { accountId: payableId, amountCents: `-${payout.amount_cents}` },
            { accountId: wiseId, amountCents: payout.amount_cents },
          ],
        });
        const updated = await db.query(
          `UPDATE payout
              SET status = 'paid', external_ref = $2, paid_txn_id = $3,
                  paid_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'submitted'`,
          [payout.id, row.externalRef, txnId],
        );
        if ((updated.rowCount ?? 0) !== 1) {
          // FOR UPDATE altında imkânsız olmalı — yine de para/durum ayrışmasına izin verme
          throw new Error(`importResults: paid CAS başarısız (payout=${payout.id})`);
        }
        result.paid += 1;
      } else {
        // failed TERMİNAL: ledger'a dokunulmaz, yeniden deneme YENİ batch'in payout'udur.
        const updated = await db.query(
          `UPDATE payout
              SET status = 'failed', failure_reason = $2, updated_at = now()
            WHERE id = $1 AND status = 'submitted'`,
          [payout.id, row.failureReason ?? null],
        );
        if ((updated.rowCount ?? 0) !== 1) {
          throw new Error(`importResults: failed CAS başarısız (payout=${payout.id})`);
        }
        result.failed += 1;
      }
    }

    return result;
  });
}
