import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { deriveBalance, getCachedBalance, postReversal, postTxn } from "../src/index.js";
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

test("postReversal bakiyeyi geri alır; aynı txn'e ikinci reversal unique ihlaliyle patlar", async () => {
  const original = await tdb.pool.withPlatform((db) =>
    postTxn(db, {
      idempotencyKey: "topup-rev-1",
      type: "topup",
      entries: [
        { accountId: cash, amountCents: 7_500 },
        { accountId: clearing, amountCents: -7_500 },
      ],
    }),
  );
  expect(await tdb.pool.withPlatform((db) => getCachedBalance(db, cash))).toBe(7_500);

  const reversal = await tdb.pool.withPlatform((db) =>
    postReversal(db, {
      ofTxnId: original.txnId,
      idempotencyKey: "reversal-1",
      reasonCode: "ops_error",
    }),
  );
  expect(reversal.created).toBe(true);

  expect(await tdb.pool.withPlatform((db) => getCachedBalance(db, cash))).toBe(0);
  expect(await tdb.pool.withPlatform((db) => deriveBalance(db, cash))).toBe(0);
  expect(await tdb.pool.withPlatform((db) => deriveBalance(db, clearing))).toBe(0);

  // Aynı orijinal txn'e ikinci reversal (farklı idempotency key) → partial unique index ihlali.
  await expect(
    tdb.pool.withPlatform((db) =>
      postReversal(db, {
        ofTxnId: original.txnId,
        idempotencyKey: "reversal-2",
        reasonCode: "ops_error",
      }),
    ),
  ).rejects.toThrow(/ledger_txn_single_reversal|duplicate key/);

  // İkinci deneme hiçbir bakiye izi bırakmadı.
  expect(await tdb.pool.withPlatform((db) => getCachedBalance(db, cash))).toBe(0);
});
