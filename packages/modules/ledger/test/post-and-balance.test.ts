import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { deriveBalance, getCachedBalance, postTxn } from "../src/index.js";
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

describe("postTxn", () => {
  test("topup bakiyeyi artırır; aynı idempotency key replay no-op'tur", async () => {
    const first = await tdb.pool.withPlatform((db) =>
      postTxn(db, {
        idempotencyKey: "topup-1",
        type: "topup",
        refType: "topup_attempt",
        entries: [
          { accountId: cash, amountCents: 10_000 },
          { accountId: clearing, amountCents: -10_000 },
        ],
      }),
    );
    expect(first.created).toBe(true);

    const balance = await tdb.pool.withPlatform((db) => getCachedBalance(db, cash));
    expect(balance).toBe(10_000);
    const derived = await tdb.pool.withPlatform((db) => deriveBalance(db, cash));
    expect(derived).toBe(10_000);

    // Replay: aynı key, farklı miktar bile olsa mevcut txn döner ve bakiye değişmez.
    const replay = await tdb.pool.withPlatform((db) =>
      postTxn(db, {
        idempotencyKey: "topup-1",
        type: "topup",
        entries: [
          { accountId: cash, amountCents: 10_000 },
          { accountId: clearing, amountCents: -10_000 },
        ],
      }),
    );
    expect(replay.created).toBe(false);
    expect(replay.txnId).toBe(first.txnId);

    const balanceAfterReplay = await tdb.pool.withPlatform((db) => getCachedBalance(db, cash));
    expect(balanceAfterReplay).toBe(10_000);
    const derivedAfterReplay = await tdb.pool.withPlatform((db) => deriveBalance(db, cash));
    expect(derivedAfterReplay).toBe(10_000);
  });

  test("min_zero: cash bakiyesini aşan düşüm CHECK ile patlar", async () => {
    await expect(
      tdb.pool.withPlatform((db) =>
        postTxn(db, {
          idempotencyKey: "overdraft-1",
          type: "spend",
          entries: [
            { accountId: cash, amountCents: -999_999 },
            { accountId: clearing, amountCents: 999_999 },
          ],
        }),
      ),
    ).rejects.toThrow(/check constraint/i);

    // Başarısız transaction hiçbir iz bırakmaz.
    const balance = await tdb.pool.withPlatform((db) => getCachedBalance(db, cash));
    expect(balance).toBe(10_000);
  });

  test("dengesiz entries commit anında patlar", async () => {
    await expect(
      tdb.pool.withPlatform((db) =>
        postTxn(db, {
          idempotencyKey: "unbalanced-1",
          type: "topup",
          entries: [
            { accountId: cash, amountCents: 5_000 },
            { accountId: clearing, amountCents: -4_000 },
          ],
        }),
      ),
    ).rejects.toThrow(/dengesiz/);

    const balance = await tdb.pool.withPlatform((db) => getCachedBalance(db, cash));
    expect(balance).toBe(10_000);
    const derived = await tdb.pool.withPlatform((db) => deriveBalance(db, cash));
    expect(derived).toBe(10_000);
  });
});
