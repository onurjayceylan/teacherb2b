import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { getCachedBalance, isPaymentsFrozen, postTxn, setPaymentsFrozen } from "../src/index.js";
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

test("kill-switch: payments_frozen iken postTxn patlar, açılınca geçer", async () => {
  await tdb.pool.withPlatform((db) => setPaymentsFrozen(db, true, "test dondurma"));
  expect(await tdb.pool.withPlatform((db) => isPaymentsFrozen(db))).toBe(true);

  await expect(
    tdb.pool.withPlatform((db) =>
      postTxn(db, {
        idempotencyKey: "frozen-1",
        type: "topup",
        entries: [
          { accountId: cash, amountCents: 1_000 },
          { accountId: clearing, amountCents: -1_000 },
        ],
      }),
    ),
  ).rejects.toThrow(/payments_frozen/);

  await tdb.pool.withPlatform((db) => setPaymentsFrozen(db, false));
  expect(await tdb.pool.withPlatform((db) => isPaymentsFrozen(db))).toBe(false);

  const result = await tdb.pool.withPlatform((db) =>
    postTxn(db, {
      idempotencyKey: "frozen-1",
      type: "topup",
      entries: [
        { accountId: cash, amountCents: 1_000 },
        { accountId: clearing, amountCents: -1_000 },
      ],
    }),
  );
  expect(result.created).toBe(true);

  const balance = await tdb.pool.withPlatform((db) => getCachedBalance(db, cash));
  expect(balance).toBe(1_000);
});
