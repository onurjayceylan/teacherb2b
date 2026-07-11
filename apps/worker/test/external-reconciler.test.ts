// Dış mutabakat iskeleti: (1) anahtar/snapshot yokken her iki taraf sessizce atlanır;
// (2) manuel Wise snapshot'ı + sahte ledger farkı → alarm; (3) aynı gün ikinci koşu
// alarmı TEKRAR YAZMAZ (24 saat dedupe); (4) fark kapanınca alarm üretilmez;
// (5) Stripe tarafı enjekte fetcher'la snapshot yazar ve farkı alarmlar.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { runExternalReconciler } from "../src/external-reconciler.js";

let tdb: TestDb;

beforeAll(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  tdb = await createTestDb();
});

afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  await tdb.drop();
});

/** clearing hesabına bacak toplar (karşı bacak bank_clearing) — sahte ledger durumu. */
async function postClearing(kind: "stripe_clearing" | "wise_clearing", amountCents: number): Promise<void> {
  await tdb.pool.withPlatform(async (db) => {
    const target = await db.query<{ id: string }>(
      "SELECT ensure_ledger_account('platform', NULL, $1) AS id",
      [kind],
    );
    const counter = await db.query<{ id: string }>(
      "SELECT ensure_ledger_account('platform', NULL, 'adjustment_reserve') AS id",
    );
    await db.query("SELECT * FROM post_ledger_txn($1, 'adjustment', 'test_seed', $2, $3::jsonb)", [
      `test:recon:${randomUUID()}`,
      randomUUID(),
      JSON.stringify([
        { account_id: target.rows[0]!.id, amount_cents: amountCents },
        { account_id: counter.rows[0]!.id, amount_cents: -amountCents },
      ]),
    ]);
  });
}

async function insertWiseSnapshot(balanceCents: number): Promise<void> {
  await tdb.pool.withPlatform((db) =>
    db.query(
      `INSERT INTO external_balance_snapshot (provider, balance_cents, currency, source, note)
       VALUES ('wise', $1, 'USD', 'manual', 'test')`,
      [balanceCents],
    ),
  );
}

async function mismatchAuditCount(provider: string): Promise<number> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
        WHERE action = 'sentinel_warning'
          AND after->>'check' = 'external_balance_mismatch'
          AND after->>'provider' = $1`,
      [provider],
    );
    return Number(res.rows[0]!.n);
  });
}

async function snapshotCount(provider: string, source: string): Promise<number> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM external_balance_snapshot WHERE provider = $1 AND source = $2",
      [provider, source],
    );
    return Number(res.rows[0]!.n);
  });
}

test("anahtar/snapshot yok: iki taraf da atlanır, snapshot/alarm yazılmaz", async () => {
  const result = await runExternalReconciler(tdb.pool);
  expect(result.stripe).toEqual({ provider: "stripe", skipped: true, alarmed: false });
  expect(result.wise).toEqual({ provider: "wise", skipped: true, alarmed: false });
  expect(await snapshotCount("stripe", "api")).toBe(0);
  expect(await mismatchAuditCount("stripe")).toBe(0);
  expect(await mismatchAuditCount("wise")).toBe(0);
});

test("manuel Wise snapshot + sahte ledger farkı → alarm; ikinci koşu 24h dedupe'a takılır", async () => {
  // Ledger: wise_clearing toplamı +2000 → beklenen Wise bakiyesi -2000;
  // kurucu 5000 girdi → fark 7000.
  await postClearing("wise_clearing", 2_000);
  await insertWiseSnapshot(5_000);

  const result = await runExternalReconciler(tdb.pool);
  expect(result.wise).toEqual({
    provider: "wise",
    skipped: false,
    snapshotBalanceCents: 5_000,
    ledgerBalanceCents: -2_000,
    diffCents: 7_000,
    alarmed: true,
  });
  expect(await mismatchAuditCount("wise")).toBe(1);

  // Aynı gün ikinci koşu: durum yine raporlanır ama audit satırı ÇOĞALMAZ
  const again = await runExternalReconciler(tdb.pool);
  expect(again.wise.alarmed).toBe(true);
  expect(await mismatchAuditCount("wise")).toBe(1);
});

test("fark kapanınca alarm üretilmez (mevcut dedupe satırı da artmaz)", async () => {
  // wise_clearing toplamını -5000'e çek: 2000 + (-7000) = -5000 → beklenen bakiye 5000
  await postClearing("wise_clearing", -7_000);

  const result = await runExternalReconciler(tdb.pool);
  expect(result.wise).toEqual({
    provider: "wise",
    skipped: false,
    snapshotBalanceCents: 5_000,
    ledgerBalanceCents: 5_000,
    diffCents: 0,
    alarmed: false,
  });
  expect(await mismatchAuditCount("wise")).toBe(1); // önceki testten kalan tek satır
});

test("stripe: enjekte fetcher'la api snapshot'ı yazılır; fark alarmlanır, eşitlikte alarmlanmaz", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_recon";

  // Ledger: stripe_clearing -30000 (Stripe'ta 30000 duruyor olmalı); API 30000 diyor → fark 0
  await postClearing("stripe_clearing", -30_000);
  const clean = await runExternalReconciler(tdb.pool, {
    fetchStripeBalance: async () => 30_000,
  });
  expect(clean.stripe).toEqual({
    provider: "stripe",
    skipped: false,
    snapshotBalanceCents: 30_000,
    ledgerBalanceCents: 30_000,
    diffCents: 0,
    alarmed: false,
  });
  expect(await snapshotCount("stripe", "api")).toBe(1);
  expect(await mismatchAuditCount("stripe")).toBe(0);

  // API 29000 diyor → fark -1000 → alarm
  const drift = await runExternalReconciler(tdb.pool, {
    fetchStripeBalance: async () => 29_000,
  });
  expect(drift.stripe.alarmed).toBe(true);
  expect(drift.stripe.diffCents).toBe(-1_000);
  expect(await snapshotCount("stripe", "api")).toBe(2);
  expect(await mismatchAuditCount("stripe")).toBe(1);

  delete process.env.STRIPE_SECRET_KEY;
});
