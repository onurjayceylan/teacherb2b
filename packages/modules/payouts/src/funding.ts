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
}

export interface RecordWiseFundingResult {
  fundingId: string;
  txnId: string;
}

/**
 * "Wise'a $X yatırdım" olayını kaydeder: wise_funding_event satırı + ledger txn. Her çağrı
 * ayrı bir fiziksel transferi temsil eder (çift-tık koruması UI'ın işi); idempotency anahtarı
 * olay id'sine bağlanır, böylece aynı olay iki kez ledger'a yazılamaz.
 */
export async function recordWiseFunding(
  db: Db,
  input: RecordWiseFundingInput,
): Promise<RecordWiseFundingResult> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(`recordWiseFunding: tutar pozitif tam sayı olmalı (${input.amountCents})`);
  }

  // Önce olay satırı: ledger txn'inin ref hedefi + admin tarihçesi.
  const ev = await db.query<{ id: string }>(
    `INSERT INTO wise_funding_event (amount_cents, note, created_by)
     VALUES ($1, $2, $3) RETURNING id`,
    [input.amountCents, input.note ?? null, input.createdBy ?? null],
  );
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
  return { fundingId, txnId };
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
