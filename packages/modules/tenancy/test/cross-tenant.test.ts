// Cross-tenant izolasyon süiti: okul A bağlamı okul B'nin hiçbir verisine
// erişememeli (SELECT sızıntısı yok, UPDATE sessizce 0 satır, INSERT'te RLS patlar).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { createOrganization, createSchool, disableUser, upsertUserWithMembership } from "../src/index.js";

let testDb: TestDb;
let schoolA: string;
let schoolB: string;
let topupA: string;
let topupB: string;
let userA: string;

beforeAll(async () => {
  testDb = await createTestDb();
  await testDb.pool.withPlatform(async (db) => {
    const orgId = await createOrganization(db, { name: "Cross Tenant Org" });
    schoolA = await createSchool(db, { organizationId: orgId, name: "School A" });
    schoolB = await createSchool(db, { organizationId: orgId, name: "School B" });

    const memberA = await upsertUserWithMembership(db, {
      schoolId: schoolA,
      email: "admin-a@example.com",
      name: "Admin A",
      role: "admin",
    });
    userA = memberA.userId;
    await upsertUserWithMembership(db, {
      schoolId: schoolB,
      email: "admin-b@example.com",
      role: "owner",
    });

    for (const [schoolId, amount, out] of [
      [schoolA, 5000, "topupA"],
      [schoolB, 7000, "topupB"],
    ] as const) {
      const res = await db.query<{ id: string }>(
        "INSERT INTO topup_attempt (school_id, method, amount_cents) VALUES ($1, 'card', $2) RETURNING id",
        [schoolId, amount],
      );
      const id = res.rows[0]?.id;
      if (!id) throw new Error("seed: topup insert başarısız");
      if (out === "topupA") topupA = id;
      else topupB = id;
    }

    // Ledger: her okula cash hesabı + platform clearing; birer txn ile entry üret.
    const acct = async (owner: string | null, kind: string) => {
      const r = await db.query<{ id: string }>(
        "SELECT ensure_ledger_account($1, $2, $3) AS id",
        [owner === null ? "platform" : "school", owner, kind],
      );
      const id = r.rows[0]?.id;
      if (!id) throw new Error("seed: ensure_ledger_account başarısız");
      return id;
    };
    const cashA = await acct(schoolA, "school_cash");
    const cashB = await acct(schoolB, "school_cash");
    const clearing = await acct(null, "stripe_clearing");

    for (const [key, cash, amount] of [
      ["seed-topup-a", cashA, 1000],
      ["seed-topup-b", cashB, 2000],
    ] as const) {
      await db.query(
        "SELECT * FROM post_ledger_txn($1, 'topup_settle', 'topup_attempt', NULL, $2::jsonb)",
        [
          key,
          JSON.stringify([
            { account_id: cash, amount_cents: amount },
            { account_id: clearing, amount_cents: -amount },
          ]),
        ],
      );
    }
  });
});

afterAll(async () => {
  await testDb.drop();
});

describe("cross-tenant izolasyon", () => {
  it("withSchool([A]): school, topup_attempt ve ledger_entry yalnız A'yı gösterir", async () => {
    await testDb.pool.withSchool([schoolA], async (db) => {
      const schools = await db.query<{ id: string }>("SELECT id FROM school");
      expect(schools.rows.map((r) => r.id)).toEqual([schoolA]);

      const topups = await db.query<{ id: string; school_id: string }>(
        "SELECT id, school_id FROM topup_attempt",
      );
      expect(topups.rows.map((r) => r.id)).toEqual([topupA]);
      expect(topups.rows.every((r) => r.school_id === schoolA)).toBe(true);

      const entries = await db.query<{ school_id: string | null; amount_cents: string }>(
        "SELECT school_id, amount_cents FROM ledger_entry",
      );
      expect(entries.rows.length).toBe(1);
      expect(entries.rows[0]?.school_id).toBe(schoolA);
      expect(Number(entries.rows[0]?.amount_cents)).toBe(1000);

      const entriesB = await db.query(
        "SELECT 1 FROM ledger_entry WHERE school_id = $1",
        [schoolB],
      );
      expect(entriesB.rowCount).toBe(0);
    });
  });

  it("withSchool([A]) ile B'nin school satırına UPDATE 0 satır etkiler (sessiz izolasyon)", async () => {
    await testDb.pool.withSchool([schoolA], async (db) => {
      const res = await db.query("UPDATE school SET name = 'hacked' WHERE id = $1", [schoolB]);
      expect(res.rowCount).toBe(0);
    });
    // B'nin adı platform gözünden de değişmemiş olmalı.
    await testDb.pool.withPlatform(async (db) => {
      const res = await db.query<{ name: string }>("SELECT name FROM school WHERE id = $1", [schoolB]);
      expect(res.rows[0]?.name).toBe("School B");
    });
  });

  it("withSchool([A]) ile B adına topup INSERT RLS WITH CHECK ile reddedilir", async () => {
    await expect(
      testDb.pool.withSchool([schoolA], (db) =>
        db.query(
          "INSERT INTO topup_attempt (school_id, method, amount_cents) VALUES ($1, 'card', 100)",
          [schoolB],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("withSchool([A]) ledger_transaction SELECT edemez (tabloya grant yok)", async () => {
    await expect(
      testDb.pool.withSchool([schoolA], (db) => db.query("SELECT id FROM ledger_transaction")),
    ).rejects.toThrow(/permission denied/);
  });

  it("withSchool([A,B]) çok-okul üyeliği iki okulun kayıtlarını da görür", async () => {
    await testDb.pool.withSchool([schoolA, schoolB], async (db) => {
      const schools = await db.query<{ id: string }>("SELECT id FROM school ORDER BY name");
      expect(schools.rows.map((r) => r.id).sort()).toEqual([schoolA, schoolB].sort());

      const topups = await db.query<{ id: string }>("SELECT id FROM topup_attempt");
      expect(topups.rows.map((r) => r.id).sort()).toEqual([topupA, topupB].sort());

      const entries = await db.query<{ school_id: string | null }>(
        "SELECT school_id FROM ledger_entry",
      );
      expect(entries.rows.map((r) => r.school_id).sort()).toEqual([schoolA, schoolB].sort());
    });
  });

  it("withSchool([]) ve geçersiz uuid throw eder (injection koruması)", () => {
    const noop = async () => {};
    expect(() => testDb.pool.withSchool([], noop)).toThrow(/en az bir school_id/);
    expect(() => testDb.pool.withSchool(["abc"], noop)).toThrow(/geçersiz uuid/);
    expect(() =>
      testDb.pool.withSchool([`${schoolA}','t'); DROP TABLE school;--`], noop),
    ).toThrow(/geçersiz uuid/);
  });

  it("disableUser sonrası token_version artar, status disabled ve disabled_at dolu", async () => {
    await testDb.pool.withPlatform(async (db) => {
      const before = await db.query<{ token_version: number }>(
        "SELECT token_version FROM app_user WHERE id = $1",
        [userA],
      );
      const versionBefore = before.rows[0]?.token_version;
      expect(versionBefore).toBeDefined();

      await disableUser(db, { userId: userA });

      const after = await db.query<{ token_version: number; status: string; disabled_at: Date | null }>(
        "SELECT token_version, status, disabled_at FROM app_user WHERE id = $1",
        [userA],
      );
      expect(after.rows[0]?.token_version).toBe(Number(versionBefore) + 1);
      expect(after.rows[0]?.status).toBe("disabled");
      expect(after.rows[0]?.disabled_at).not.toBeNull();
    });
  });
});
