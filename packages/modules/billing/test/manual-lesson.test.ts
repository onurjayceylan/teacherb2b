import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { adminSettleBankTopup, chargeManualLesson, createBankTopup } from "../src/index.js";

let tdb: TestDb;
let schoolId: string;
let teacherId: string;
let classGroupId: string;

beforeAll(async () => {
  tdb = await createTestDb();
  ({ schoolId, teacherId } = await tdb.pool.withPlatform(async (db) => {
    const org = await db.query<{ id: string }>(
      "INSERT INTO organization (name) VALUES ('WoZ Org') RETURNING id",
    );
    const school = await db.query<{ id: string }>(
      "INSERT INTO school (organization_id, name) VALUES ($1, 'WoZ Okul') RETURNING id",
      [org.rows[0]!.id],
    );
    const teacher = await db.query<{ id: string }>(
      `INSERT INTO teacher (full_name, email, source)
       VALUES ('WoZ Teacher', 'woz.teacher@example.com', 'hrmasterz') RETURNING id`,
    );
    return { schoolId: school.rows[0]!.id, teacherId: teacher.rows[0]!.id };
  }));

  // Roster okulun verisi: class_group okul bağlamında açılır
  classGroupId = await tdb.pool.withSchool([schoolId], async (db) => {
    const res = await db.query<{ id: string }>(
      "INSERT INTO class_group (school_id, name, level) VALUES ($1, '5-A', 'A2') RETURNING id",
      [schoolId],
    );
    return res.rows[0]!.id;
  });

  // Okul kasasına bakiye yükle (banka top-up + admin settle yolu)
  const { id: topupId } = await tdb.pool.withSchool([schoolId], (db) =>
    createBankTopup(db, { schoolId, amountCents: 100_000 }),
  );
  await tdb.pool.withPlatform((db) => adminSettleBankTopup(db, { topupId }));
});

afterAll(async () => {
  await tdb.drop();
});

async function balance(ownerType: string, ownerId: string, kind: string): Promise<number> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM ledger_account
        WHERE owner_type = $1 AND owner_id = $2 AND kind = $3`,
      [ownerType, ownerId, kind],
    );
    const row = res.rows[0];
    // pg bigint'i string döndürür
    return row ? Number(row.balance_cents) : 0;
  });
}

async function lessonRowCount(chargeCents: number): Promise<number> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM manual_lesson_charge WHERE charge_cents = $1",
      [chargeCents],
    );
    return res.rows[0]!.n;
  });
}

async function assertInvariantsClean(): Promise<void> {
  await tdb.pool.withPlatform(async (db) => {
    const violations = await db.query("SELECT * FROM ledger_invariant_violations()");
    expect(violations.rows).toEqual([]);
  });
}

describe("chargeManualLesson", () => {
  it("mutlu yol: okul bakiyesi düşer, eğitmen alacağı artar, marj platforma yazılır", async () => {
    const schoolBefore = await balance("school", schoolId, "school_cash");
    expect(schoolBefore).toBe(100_000);

    const { id, txnId } = await tdb.pool.withPlatform((db) =>
      chargeManualLesson(db, {
        schoolId,
        teacherId,
        classGroupId,
        lessonDate: "2026-07-01",
        minutes: 50,
        chargeCents: 20_000,
        teacherPayCents: 12_000,
        note: "Speaking club — 5-A",
      }),
    );
    expect(id).toBeTruthy();
    expect(txnId).toBeTruthy();

    expect(await balance("school", schoolId, "school_cash")).toBe(80_000);
    expect(await balance("teacher", teacherId, "teacher_payable")).toBe(12_000);

    await tdb.pool.withPlatform(async (db) => {
      const row = await db.query<{ txn_id: string; minutes: number; class_group_id: string }>(
        "SELECT txn_id, minutes, class_group_id FROM manual_lesson_charge WHERE id = $1",
        [id],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]!.txn_id).toBe(txnId);
      expect(row.rows[0]!.minutes).toBe(50);
      expect(row.rows[0]!.class_group_id).toBe(classGroupId);

      const txn = await db.query<{ idempotency_key: string; type: string }>(
        "SELECT idempotency_key, type FROM ledger_transaction WHERE id = $1",
        [txnId],
      );
      expect(txn.rows[0]).toEqual({ idempotency_key: `woz:lesson:${id}`, type: "lesson_charge" });
    });

    await assertInvariantsClean();
  });

  it("yetersiz bakiye: exception atar, ders satırı da ledger izi de kalmaz", async () => {
    const schoolBefore = await balance("school", schoolId, "school_cash");
    const teacherBefore = await balance("teacher", teacherId, "teacher_payable");

    // min_zero: school_cash eksiye düşemez → ledger_account CHECK'i patlar
    await expect(
      tdb.pool.withPlatform((db) =>
        chargeManualLesson(db, {
          schoolId,
          teacherId,
          lessonDate: "2026-07-02",
          minutes: 60,
          chargeCents: 1_000_000,
          teacherPayCents: 500_000,
        }),
      ),
    ).rejects.toThrow(/check constraint/);

    // Transaction bütünlüğü: satır yok, bakiyeler değişmedi
    expect(await lessonRowCount(1_000_000)).toBe(0);
    expect(await balance("school", schoolId, "school_cash")).toBe(schoolBefore);
    expect(await balance("teacher", teacherId, "teacher_payable")).toBe(teacherBefore);
    await assertInvariantsClean();
  });

  it("teacherPay > charge: satır CHECK'i patlar, hiçbir şey yazılmaz", async () => {
    const schoolBefore = await balance("school", schoolId, "school_cash");
    const teacherBefore = await balance("teacher", teacherId, "teacher_payable");

    await expect(
      tdb.pool.withPlatform((db) =>
        chargeManualLesson(db, {
          schoolId,
          teacherId,
          lessonDate: "2026-07-03",
          minutes: 40,
          chargeCents: 5_000,
          teacherPayCents: 6_000, // negatif marj yapısal olarak temsil edilemez
        }),
      ),
    ).rejects.toThrow(/manual_lesson_charge/);

    expect(await lessonRowCount(5_000)).toBe(0);
    expect(await balance("school", schoolId, "school_cash")).toBe(schoolBefore);
    expect(await balance("teacher", teacherId, "teacher_payable")).toBe(teacherBefore);
    await assertInvariantsClean();
  });
});
