import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, migrate, type TestDb } from "../src/index.js";

describe("migration runner", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.drop();
  });

  it("ikinci koşu idempotent — yeni migration uygulamaz", async () => {
    const applied = await migrate(t.url);
    expect(applied).toEqual([]);
  });

  it("çekirdek nesneler yerinde (fonksiyonlar + kill-switch satırı)", async () => {
    await t.pool.withPlatform(async (db) => {
      const fns = await db.query(
        `SELECT proname FROM pg_proc WHERE proname IN
         ('post_ledger_txn','ensure_ledger_account','ledger_invariant_violations','app_school_ids')`,
      );
      expect(fns.rows.length).toBe(4);
      const flag = await db.query(`SELECT value FROM system_flag WHERE key = 'payments_frozen'`);
      expect(flag.rows[0]?.value).toBe(false);
    });
  });

  it("invariant nöbetçisi taze DB'de temiz", async () => {
    const rows = await t.pool.withPlatform(async (db) => {
      const r = await db.query(`SELECT * FROM ledger_invariant_violations()`);
      return r.rows;
    });
    expect(rows).toEqual([]);
  });
});
