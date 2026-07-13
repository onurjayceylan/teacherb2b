// P1-D (docs/denetim-3-rol-tur2.md): Wise fonlamasının ÇİFT-KAYIT modeli (kurucu kararı: B).
// Kurucu kendi bankasından Wise'a payout float'u aktardığında BUNU ledger'a yazar:
//   [wise_clearing −X, platform_capital +X]
// Payout ödemesi wise_clearing'e +X yazdığından, fonlama −X yazınca:
//   −SUM(wise_clearing) = (toplam fonlama − toplam ödenen) = Wise'ın GERÇEK bakiyesi.
// external-reconciler zaten −SUM(wise_clearing) hesaplar → değişmeden ANLAMLI hâle gelir
// (yalnız gerçek anomali alarm verir; fonlama modellenmediği için çıkan sahte fark biter).
import type { Db } from "@teachernow/db";
import { ensureAccount, postTxn } from "./ledger.js";

export interface RecordWiseFundingInput {
  amountCents: number;
  note?: string;
  createdBy?: string | null;
  /**
   * İstemcinin fonlama formuna özel idempotency anahtarı. Verilirse aynı anahtarla ikinci
   * çağrı YENİ ledger txn YAZMAZ — mevcut olayı aynen döner (çift-tık/yeniden gönderim
   * mutabakat baseline'ını şişirmez). Verilmezse her çağrı ayrı fiziksel transfer sayılır.
   */
  idempotencyKey?: string;
}

export interface RecordWiseFundingResult {
  fundingId: string;
  txnId: string;
  /** true → bu idempotency anahtarı daha önce kaydedilmişti; ledger'a DOKUNULMADI. */
  alreadyRecorded: boolean;
}

/**
 * "Wise'a $X yatırdım" olayını kaydeder: wise_funding_event satırı + ledger txn. Ledger
 * idempotency anahtarı olay id'sine bağlanır (aynı olay iki kez ledger'a yazılamaz); ayrıca
 * istemci idempotencyKey'i verirse fat-finger çift-gönderim de sunucuda deduplike edilir.
 * recordWiseFunding çağıranın TEK transaction'ında koşar → olay+txn ya birlikte commit olur
 * ya da birlikte rollback; dedup çakışması "önceki çağrı tam commit oldu" demektir.
 */
export async function recordWiseFunding(
  db: Db,
  input: RecordWiseFundingInput,
): Promise<RecordWiseFundingResult> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(`recordWiseFunding: tutar pozitif tam sayı olmalı (${input.amountCents})`);
  }

  // Önce olay satırı: ledger txn'inin ref hedefi + admin tarihçesi. idempotencyKey varsa
  // benzersizlik üstünde ON CONFLICT DO NOTHING → çakışmada satır dönmez, mevcut olayı döneriz.
  const dedupKey = input.idempotencyKey ?? null;
  const ev = await db.query<{ id: string }>(
    `INSERT INTO wise_funding_event (amount_cents, note, created_by, dedup_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [input.amountCents, input.note ?? null, input.createdBy ?? null, dedupKey],
  );

  if (ev.rows.length === 0) {
    // dedup_key çakıştı → fonlama zaten kaydedilmiş. Ledger'a DOKUNMA, mevcut olayı dön.
    const existing = await db.query<{ id: string; txn_id: string | null }>(
      "SELECT id, txn_id FROM wise_funding_event WHERE dedup_key = $1",
      [dedupKey],
    );
    const row = existing.rows[0];
    if (!row?.txn_id) {
      // Tek-transaction modelinde olay+txn birlikte commit olur → txn_id daima dolu olmalı.
      throw new Error("recordWiseFunding: dedup çakışması ama mevcut olayın txn_id'si yok");
    }
    return { fundingId: row.id, txnId: row.txn_id, alreadyRecorded: true };
  }

  const fundingId = ev.rows[0]!.id;

  const wiseId = await ensureAccount(db, "platform", null, "wise_clearing");
  const capitalId = await ensureAccount(db, "platform", null, "platform_capital");
  const { txnId } = await postTxn(db, {
    key: `wise_funding:${fundingId}`, // olay başına tek txn (idempotent)
    type: "wise_funding",
    refType: "wise_funding",
    refId: fundingId,
    entries: [
      { accountId: wiseId, amountCents: -input.amountCents }, // gerçek bakiyeyi ARTIRIR (−SUM)
      { accountId: capitalId, amountCents: input.amountCents }, // enjekte edilen sermaye
    ],
  });

  await db.query("UPDATE wise_funding_event SET txn_id = $1 WHERE id = $2", [txnId, fundingId]);
  return { fundingId, txnId, alreadyRecorded: false };
}

export interface WiseFundingRow {
  id: string;
  amountCents: number;
  note: string | null;
  createdAt: Date;
}

/** Fonlama tarihçesi (admin listesi): son N kayıt, en yeni önce. */
export async function listWiseFundings(db: Db, limit = 20): Promise<WiseFundingRow[]> {
  const res = await db.query<{ id: string; amount_cents: string; note: string | null; created_at: Date }>(
    `SELECT id, amount_cents, note, created_at FROM wise_funding_event
      ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    amountCents: Number(r.amount_cents),
    note: r.note,
    createdAt: r.created_at,
  }));
}
