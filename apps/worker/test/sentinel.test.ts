import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { ensureAccount, postTxn } from "@teachernow/ledger";
import { runInvariantSentinel } from "../src/sentinel.js";

let tdb: TestDb;
let cash: string;
let clearing: string;

beforeAll(async () => {
  tdb = await createTestDb();
  const accounts = await tdb.pool.withPlatform(async (db) => {
    const org = await db.query<{ id: string }>(
      "INSERT INTO organization (name) VALUES ('Sentinel Org') RETURNING id",
    );
    const orgId = org.rows[0]?.id;
    if (!orgId) throw new Error("organization insert başarısız");
    const school = await db.query<{ id: string }>(
      "INSERT INTO school (organization_id, name) VALUES ($1, 'Sentinel School') RETURNING id",
      [orgId],
    );
    const schoolId = school.rows[0]?.id;
    if (!schoolId) throw new Error("school insert başarısız");
    return {
      cash: await ensureAccount(db, { ownerType: "school", ownerId: schoolId, kind: "school_cash" }),
      clearing: await ensureAccount(db, { ownerType: "platform", ownerId: null, kind: "stripe_clearing" }),
    };
  });
  cash = accounts.cash;
  clearing = accounts.clearing;
});

afterAll(async () => {
  await tdb.drop();
});

async function paymentsFrozen(): Promise<boolean> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ value: boolean }>(
      "SELECT value FROM system_flag WHERE key = 'payments_frozen'",
    );
    return res.rows[0]?.value ?? false;
  });
}

test("temiz DB: ihlal yok, kill-switch devreye girmez, flag false kalır", async () => {
  const result = await runInvariantSentinel(tdb.pool);
  expect(result.violations).toEqual([]);
  expect(result.engagedKillSwitch).toBe(false);
  expect(await paymentsFrozen()).toBe(false);
});

test("bakiye drift'i: sentinel yakalar, flag'i açar, audit yazar; post_ledger_txn artık patlar", async () => {
  // Cache'i kasten kaydır — rollere UPDATE grant'i yok, yalnız owner yapabilir.
  await tdb.pool.withOwner((db) =>
    db.query("UPDATE ledger_account SET balance_cents = 777 WHERE id = $1", [cash]),
  );

  const result = await runInvariantSentinel(tdb.pool);
  expect(result.engagedKillSwitch).toBe(true);
  const drift = result.violations.find((v) => v.checkName === "balance_cache_drift");
  expect(drift).toBeDefined();
  expect(drift?.detail).toContain(cash);

  expect(await paymentsFrozen()).toBe(true);

  const audit = await tdb.pool.withPlatform((db) =>
    db.query<{ actor_kind: string; entity_type: string }>(
      "SELECT actor_kind, entity_type FROM audit_log WHERE action = 'kill_switch_engaged'",
    ),
  );
  expect(audit.rows.length).toBe(1);
  expect(audit.rows[0]?.actor_kind).toBe("system");
  expect(audit.rows[0]?.entity_type).toBe("system_flag");

  await expect(
    tdb.pool.withPlatform((db) =>
      postTxn(db, {
        idempotencyKey: "sentinel-frozen-1",
        type: "topup",
        entries: [
          { accountId: cash, amountCents: 1_000 },
          { accountId: clearing, amountCents: -1_000 },
        ],
      }),
    ),
  ).rejects.toThrow(/payments_frozen/);
});

test("2 saattir 'received' bekleyen webhook: sentinel webhook_stuck raporlar", async () => {
  await tdb.pool.withPlatform((db) =>
    db.query(
      `INSERT INTO webhook_event (provider, event_id, kind, received_at)
       VALUES ('stripe', 'evt_stuck_1', 'payment_intent.succeeded', now() - interval '2 hours')`,
    ),
  );

  const result = await runInvariantSentinel(tdb.pool);
  const stuck = result.violations.filter((v) => v.checkName === "webhook_stuck");
  expect(stuck.length).toBe(1);
  expect(stuck[0]?.detail).toContain("evt_stuck_1");
  expect(result.engagedKillSwitch).toBe(true);
});
