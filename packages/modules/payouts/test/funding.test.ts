// P1-D: Wise fonlaması çift-kayıt. recordWiseFunding [wise_clearing −X, platform_capital +X]
// yazar; olay satırı + txn linki oluşur; invariant temiz kalır. Mutabakat ÖZDEŞLİĞİ:
// −SUM(wise_clearing) = (toplam fonlama − toplam ödenen) = Wise'ın gerçek bakiyesi.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type Db, type TestDb } from "@teachernow/db";
import { listWiseFundings, recordWiseFunding } from "../src/index.js";

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

/** clearing bacak toplamı (track_balance dışı — tek doğru kaynak entry toplamı). */
async function clearingSum(db: Db, kind: string): Promise<number> {
  const res = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(e.amount_cents), 0) AS total
       FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id
      WHERE a.owner_type = 'platform' AND a.kind = $1`,
    [kind],
  );
  return Number(res.rows[0]!.total);
}

/** Bir payout ödemesinin wise_clearing etkisini taklit eder: +X (results.ts deseni). */
async function simulatePayout(db: Db, amountCents: number): Promise<void> {
  const wise = await db.query<{ id: string }>(
    "SELECT ensure_ledger_account('platform', NULL, 'wise_clearing') AS id",
  );
  const counter = await db.query<{ id: string }>(
    "SELECT ensure_ledger_account('platform', NULL, 'adjustment_reserve') AS id",
  );
  await db.query("SELECT * FROM post_ledger_txn($1, 'adjustment', 'test', $2, $3::jsonb)", [
    `test:payout:${randomUUID()}`,
    randomUUID(),
    JSON.stringify([
      { account_id: wise.rows[0]!.id, amount_cents: amountCents },
      { account_id: counter.rows[0]!.id, amount_cents: -amountCents },
    ]),
  ]);
}

async function invariantClean(): Promise<boolean> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query("SELECT * FROM ledger_invariant_violations()");
    return (res.rowCount ?? 0) === 0;
  });
}

test("recordWiseFunding: [wise_clearing −X, platform_capital +X] + olay satırı + txn linki", async () => {
  const result = await tdb.pool.withPlatform((db) =>
    recordWiseFunding(db, { amountCents: 50_000, note: "İlk Wise float'ı" }),
  );
  expect(result.fundingId).toBeTruthy();
  expect(result.txnId).toBeTruthy();

  await tdb.pool.withPlatform(async (db) => {
    // wise_clearing −50000, platform_capital +50000
    expect(await clearingSum(db, "wise_clearing")).toBe(-50_000);
    expect(await clearingSum(db, "platform_capital")).toBe(50_000);
    // Olay satırı txn'e bağlandı
    const ev = await db.query<{ amount_cents: string; txn_id: string; note: string }>(
      "SELECT amount_cents, txn_id, note FROM wise_funding_event WHERE id = $1",
      [result.fundingId],
    );
    expect(ev.rows[0]!.txn_id).toBe(result.txnId);
    expect(Number(ev.rows[0]!.amount_cents)).toBe(50_000);
    expect(ev.rows[0]!.note).toBe("İlk Wise float'ı");
  });
  expect(await invariantClean()).toBe(true);
});

test("mutabakat özdeşliği: −SUM(wise_clearing) = fonlama − ödenen (Wise gerçek bakiyesi)", async () => {
  // Önceki testte 50000 fonlandı. Şimdi 12000 ödeme + 8000 ek fonlama:
  await tdb.pool.withPlatform((db) => simulatePayout(db, 12_000)); // wise_clearing += 12000
  await tdb.pool.withPlatform((db) => recordWiseFunding(db, { amountCents: 8_000 })); // += −8000

  const expectedRealBalance = 50_000 + 8_000 - 12_000; // 46000
  await tdb.pool.withPlatform(async (db) => {
    const sum = await clearingSum(db, "wise_clearing"); // −50000 + 12000 − 8000 = −46000
    expect(sum).toBe(-46_000);
    expect(-sum).toBe(expectedRealBalance); // reconciler'ın ledgerBalanceCents'i = 46000
  });
  expect(await invariantClean()).toBe(true);
});

test("listWiseFundings: tarihçe en yeni önce; geçersiz tutar reddedilir", async () => {
  const rows = await tdb.pool.withPlatform((db) => listWiseFundings(db));
  expect(rows.length).toBe(2); // 50000 + 8000
  expect(rows.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([8_000, 50_000]);

  await expect(
    tdb.pool.withPlatform((db) => recordWiseFunding(db, { amountCents: 0 })),
  ).rejects.toThrow(/pozitif tam sayı/);
  await expect(
    tdb.pool.withPlatform((db) => recordWiseFunding(db, { amountCents: -100 })),
  ).rejects.toThrow(/pozitif tam sayı/);
});

test("idempotency: aynı anahtarla ikinci çağrı ledger'a DOKUNMAZ, mevcut olayı döner", async () => {
  const before = await tdb.pool.withPlatform((db) => clearingSum(db, "wise_clearing"));
  const key = `funding-test-${randomUUID()}`;

  const first = await tdb.pool.withPlatform((db) =>
    recordWiseFunding(db, { amountCents: 3_000, idempotencyKey: key }),
  );
  expect(first.alreadyRecorded).toBe(false);
  const afterFirst = await tdb.pool.withPlatform((db) => clearingSum(db, "wise_clearing"));
  expect(afterFirst).toBe(before - 3_000); // fonlama −X

  // Aynı anahtar tekrar (çift-tık): yeni txn YOK, aynı olay/txn, bakiye DEĞİŞMEZ.
  const second = await tdb.pool.withPlatform((db) =>
    recordWiseFunding(db, { amountCents: 3_000, idempotencyKey: key }),
  );
  expect(second.alreadyRecorded).toBe(true);
  expect(second.fundingId).toBe(first.fundingId);
  expect(second.txnId).toBe(first.txnId);
  expect(await tdb.pool.withPlatform((db) => clearingSum(db, "wise_clearing"))).toBe(afterFirst);

  // Anahtarsız çağrılar her seferinde ayrı olay (geriye uyumluluk).
  const a = await tdb.pool.withPlatform((db) => recordWiseFunding(db, { amountCents: 1_000 }));
  const b = await tdb.pool.withPlatform((db) => recordWiseFunding(db, { amountCents: 1_000 }));
  expect(a.fundingId).not.toBe(b.fundingId);
  expect(a.alreadyRecorded).toBe(false);
  expect(b.alreadyRecorded).toBe(false);
  expect(await invariantClean()).toBe(true);
});
