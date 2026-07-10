import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { invariantViolations, postTxn } from "../src/index.js";
import { seedCashAndClearing, seedSchool } from "./helpers.js";

let tdb: TestDb;
let cash: string;
let clearing: string;

beforeAll(async () => {
  tdb = await createTestDb();
  const accounts = await tdb.pool.withPlatform(async (db) => {
    const schoolId = await seedSchool(db);
    return seedCashAndClearing(db, schoolId);
  });
  cash = accounts.cash;
  clearing = accounts.clearing;
});

afterAll(async () => {
  await tdb.drop();
});

test("invariantViolations temiz defterde boş; cache drift'te balance_cache_drift raporlar", async () => {
  await tdb.pool.withPlatform((db) =>
    postTxn(db, {
      idempotencyKey: "inv-topup-1",
      type: "topup",
      entries: [
        { accountId: cash, amountCents: 2_000 },
        { accountId: clearing, amountCents: -2_000 },
      ],
    }),
  );

  const clean = await tdb.pool.withPlatform((db) => invariantViolations(db));
  expect(clean).toEqual([]);

  // Cache'i kasten kaydır (yalnız owner yapabilir; rollere ledger_account UPDATE grant'i yok).
  await tdb.pool.withOwner((db) =>
    db.query("UPDATE ledger_account SET balance_cents = balance_cents + 123 WHERE id = $1", [cash]),
  );

  const drifted = await tdb.pool.withPlatform((db) => invariantViolations(db));
  expect(drifted.length).toBeGreaterThan(0);
  const drift = drifted.find((v) => v.checkName === "balance_cache_drift");
  expect(drift).toBeDefined();
  expect(drift?.detail).toContain(cash);
  expect(drift?.detail).toContain("cache=2123");
});
