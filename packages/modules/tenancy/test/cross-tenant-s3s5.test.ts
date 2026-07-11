// Cross-tenant IDOR DOĞRULAMA süiti (S6): S3-S5 tablolarını da kapsar.
// İki okul (A, B) tam veri zinciriyle seed edilir (roster → plan → slot → session →
// dispute/charge/topup/ledger); ardından okul A bağlamından:
//   1. tenant tablolarında yalnız A'nın satırları görünür (B = 0),
//   2. ekonomi kolonları (eğitmen maliyeti) permission denied,
//   3. B'nin kayıtlarına record-IDOR (id ile UPDATE/SELECT) etkisiz,
//   4. platform-scoped tablolar toptan permission denied,
//   5. ledger_entry/ledger_account yalnız A'nın satırları/hesapları.
//
// S6 taramasının bulduğu sızıntı (dosage_plan.teacher_pay_cents okula açıktı) 0011 ile
// kapatıldı: SELECT kolon-grant'e indirildi, INSERT create_dosage_plan RPC'sine taşındı.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { createOrganization, createSchool } from "../src/index.js";

interface SchoolSeed {
  schoolId: string;
  classGroupId: string;
  studentId: string;
  planId: string;
  slotId: string;
  teacherId: string;
  sessionId: string;
  attendanceId: string;
  disputeId: string;
  chargeId: string;
  topupId: string;
  ledgerAmountCents: number;
}

let testDb: TestDb;
let seedA: SchoolSeed;
let seedB: SchoolSeed;

function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`seed: ${what} sonuç döndürmedi`);
  return row;
}

/** Okul + tam S3-S5 veri zinciri. Roster/plan okul bağlamında, gerisi platformda. */
async function seedSchoolChain(
  orgId: string,
  tag: string,
  ledgerAmountCents: number,
): Promise<SchoolSeed> {
  const schoolId = await testDb.pool.withPlatform((db) =>
    createSchool(db, { organizationId: orgId, name: `School ${tag}` }),
  );

  // Fiyat kartı pool seed'inden (0008): native_esl sell 4000 / pay 1600.
  const poolId = await testDb.pool.withPlatform(async (db) => {
    const res = await db.query<{
      id: string;
      sell_per_lesson_cents: string;
      pay_per_lesson_cents: string;
    }>(
      "SELECT id, sell_per_lesson_cents, pay_per_lesson_cents FROM pool WHERE key = 'native_esl'",
    );
    const row = one(res.rows, "native_esl pool");
    expect(Number(row.sell_per_lesson_cents)).toBe(4000);
    expect(Number(row.pay_per_lesson_cents)).toBe(1600);
    return row.id;
  });

  // Roster + dosaj reçetesi OKUL bağlamında (platformun class_group/student INSERT'i yok).
  const { classGroupId, studentId, planId } = await testDb.pool.withSchool(
    [schoolId],
    async (db) => {
      const cg = await db.query<{ id: string }>(
        "INSERT INTO class_group (school_id, name) VALUES ($1, $2) RETURNING id",
        [schoolId, `Class ${tag}`],
      );
      const classGroupIdInner = one(cg.rows, "class_group").id;
      const st = await db.query<{ id: string }>(
        "INSERT INTO student (school_id, class_group_id, full_name) VALUES ($1, $2, $3) RETURNING id",
        [schoolId, classGroupIdInner, `Student ${tag}`],
      );
      // 0011: okul rolü dosage_plan'a doğrudan INSERT edemez — plan RPC ile açılır
      // (fiyat snapshot'ını DB alır; tenant kapısı RPC içinde app.school_ids'le).
      const plan = await db.query<{ id: string }>(
        `SELECT create_dosage_plan($1, $2, $3, 0, 600, 45, current_date, 4) AS id`,
        [schoolId, classGroupIdInner, poolId],
      );
      return {
        classGroupId: classGroupIdInner,
        studentId: one(st.rows, "student").id,
        planId: one(plan.rows, "dosage_plan").id,
      };
    },
  );

  // Slot + eğitmen + session + yoklama + dispute + WoZ charge + topup: platform bağlamında.
  return testDb.pool.withPlatform(async (db) => {
    const teacher = await db.query<{ id: string }>(
      "INSERT INTO teacher (full_name, email, source, hourly_cost_cents) VALUES ($1, $2, 'site', 1600) RETURNING id",
      [`Teacher ${tag}`, `teacher-${tag.toLowerCase()}@example.com`],
    );
    const teacherId = one(teacher.rows, "teacher").id;

    const slot = await db.query<{ id: string }>(
      `INSERT INTO booking_slot
         (school_id, plan_id, class_group_id, pool_id, occurrence_key,
          starts_at, ends_at, price_cents, teacher_pay_cents)
       VALUES ($1, $2, $3, $4, current_date + 1,
               now() + interval '1 day', now() + interval '1 day 45 minutes', 4000, 1600)
       RETURNING id`,
      [schoolId, planId, classGroupId, poolId],
    );
    const slotId = one(slot.rows, "booking_slot").id;

    const session = await db.query<{ id: string }>(
      `INSERT INTO class_session (slot_id, school_id, teacher_id, class_group_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [slotId, schoolId, teacherId, classGroupId],
    );
    const sessionId = one(session.rows, "class_session").id;

    const attendance = await db.query<{ id: string }>(
      "INSERT INTO session_attendance (session_id, student_id, present) VALUES ($1, $2, true) RETURNING id",
      [sessionId, studentId],
    );
    const dispute = await db.query<{ id: string }>(
      "INSERT INTO session_dispute (session_id, school_id, reason) VALUES ($1, $2, $3) RETURNING id",
      [sessionId, schoolId, `dispute ${tag}`],
    );
    const charge = await db.query<{ id: string }>(
      `INSERT INTO manual_lesson_charge
         (school_id, teacher_id, class_group_id, lesson_date, minutes, charge_cents, teacher_pay_cents)
       VALUES ($1, $2, $3, current_date, 45, 4000, 1600) RETURNING id`,
      [schoolId, teacherId, classGroupId],
    );
    const topup = await db.query<{ id: string }>(
      "INSERT INTO topup_attempt (school_id, method, amount_cents) VALUES ($1, 'card', 5000) RETURNING id",
      [schoolId],
    );

    // Ledger: okul kasası + platform clearing; okul-etiketli entry üret.
    const acct = await db.query<{ id: string }>(
      "SELECT ensure_ledger_account('school', $1, 'school_cash') AS id",
      [schoolId],
    );
    const cashId = one(acct.rows, "school_cash hesabı").id;
    const clearingRes = await db.query<{ id: string }>(
      "SELECT ensure_ledger_account('platform', NULL, 'stripe_clearing') AS id",
    );
    const clearingId = one(clearingRes.rows, "clearing hesabı").id;
    await db.query(
      "SELECT * FROM post_ledger_txn($1, 'topup_settle', 'topup_attempt', NULL, $2::jsonb)",
      [
        `seed-s3s5-${tag}`,
        JSON.stringify([
          { account_id: cashId, amount_cents: ledgerAmountCents },
          { account_id: clearingId, amount_cents: -ledgerAmountCents },
        ]),
      ],
    );

    return {
      schoolId,
      classGroupId,
      studentId,
      planId,
      slotId,
      teacherId,
      sessionId,
      attendanceId: one(attendance.rows, "session_attendance").id,
      disputeId: one(dispute.rows, "session_dispute").id,
      chargeId: one(charge.rows, "manual_lesson_charge").id,
      topupId: one(topup.rows, "topup_attempt").id,
      ledgerAmountCents,
    };
  });
}

beforeAll(async () => {
  testDb = await createTestDb();
  const orgId = await testDb.pool.withPlatform((db) =>
    createOrganization(db, { name: "S3S5 Cross Tenant Org" }),
  );
  seedA = await seedSchoolChain(orgId, "A", 1111);
  seedB = await seedSchoolChain(orgId, "B", 2222);
});

afterAll(async () => {
  await testDb.drop();
});

describe("cross-tenant S3-S5 doğrulama", () => {
  it("1. tenant tablolarında withSchool([A]) yalnız A'nın satırlarını görür (B = 0)", async () => {
    await testDb.pool.withSchool([seedA.schoolId], async (db) => {
      // booking_slot/manual_lesson_charge kolon-grant'lidir: yalnız açık kolonlar seçilir.
      const cases: Array<{ table: string; sql: string; aId: string; bId: string }> = [
        { table: "dosage_plan", sql: "SELECT id, school_id FROM dosage_plan", aId: seedA.planId, bId: seedB.planId },
        { table: "booking_slot", sql: "SELECT id, school_id FROM booking_slot", aId: seedA.slotId, bId: seedB.slotId },
        { table: "class_session", sql: "SELECT id, school_id FROM class_session", aId: seedA.sessionId, bId: seedB.sessionId },
        { table: "session_dispute", sql: "SELECT id, school_id FROM session_dispute", aId: seedA.disputeId, bId: seedB.disputeId },
        { table: "manual_lesson_charge", sql: "SELECT id, school_id FROM manual_lesson_charge", aId: seedA.chargeId, bId: seedB.chargeId },
        { table: "student", sql: "SELECT id, school_id FROM student", aId: seedA.studentId, bId: seedB.studentId },
        { table: "class_group", sql: "SELECT id, school_id FROM class_group", aId: seedA.classGroupId, bId: seedB.classGroupId },
      ];
      for (const c of cases) {
        const res = await db.query<{ id: string; school_id: string }>(c.sql);
        expect(res.rows.map((r) => r.id), c.table).toEqual([c.aId]);
        expect(res.rows.every((r) => r.school_id === seedA.schoolId), c.table).toBe(true);
      }

      // session_attendance'ta school_id yok; izolasyon session üzerinden (EXISTS policy).
      const att = await db.query<{ id: string; session_id: string }>(
        "SELECT id, session_id FROM session_attendance",
      );
      expect(att.rows.map((r) => r.id)).toEqual([seedA.attendanceId]);
      expect(att.rows[0]?.session_id).toBe(seedA.sessionId);
    });
  });

  it("2. ekonomi kolonları okul bağlamında permission denied (kolon sızıntısı yok)", async () => {
    const deniedQueries = [
      "SELECT teacher_pay_cents FROM booking_slot",
      "SELECT teacher_pay_cents FROM manual_lesson_charge",
      "SELECT pay_per_lesson_cents FROM pool",
      // 0011 sonrası: reçetedeki maliyet snapshot'ı da okula kapalı + doğrudan INSERT yasak.
      "SELECT teacher_pay_cents FROM dosage_plan",
      "INSERT INTO dosage_plan (school_id, class_group_id, pool_id, weekday, start_minute, duration_min, school_tz, price_cents, teacher_pay_cents, start_date, weeks) SELECT school_id, class_group_id, pool_id, 1, 700, 45, school_tz, 1, 1, current_date, 1 FROM dosage_plan LIMIT 1",
      // teacher tablosuna okulun hiç erişimi yok → tüm tablo denied (kabul).
      "SELECT hourly_cost_cents FROM teacher",
    ];
    for (const sql of deniedQueries) {
      await expect(
        testDb.pool.withSchool([seedA.schoolId], (db) => db.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("3. record-IDOR: B'nin kayıtlarına id ile erişim etkisiz", async () => {
    await testDb.pool.withSchool([seedA.schoolId], async (db) => {
      // B'nin dosage_plan'ına UPDATE (okulun grant'i olan kolonlarla) → 0 satır.
      const planUpd = await db.query(
        "UPDATE dosage_plan SET status = 'paused', updated_at = now() WHERE id = $1",
        [seedB.planId],
      );
      expect(planUpd.rowCount).toBe(0);

      // B'nin booking_slot'u id ile (record-IDOR) → 0 satır.
      const slotSel = await db.query("SELECT id FROM booking_slot WHERE id = $1", [seedB.slotId]);
      expect(slotSel.rowCount).toBe(0);
    });

    // B'nin session_dispute'una UPDATE: role_school'a UPDATE grant'i hiç verilmemiş →
    // tablo düzeyinde permission denied (rowCount 0'dan da sert; grant açılırsa RLS 0 satır vermeli).
    try {
      const res = await testDb.pool.withSchool([seedA.schoolId], (db) =>
        db.query("UPDATE session_dispute SET status = 'rejected' WHERE id = $1", [seedB.disputeId]),
      );
      expect(res.rowCount).toBe(0);
    } catch (err) {
      expect(String(err)).toMatch(/permission denied/);
    }

    // Platform gözünden B'nin verisi değişmemiş olmalı.
    await testDb.pool.withPlatform(async (db) => {
      const plan = await db.query<{ status: string }>(
        "SELECT status FROM dosage_plan WHERE id = $1",
        [seedB.planId],
      );
      expect(plan.rows[0]?.status).toBe("active");
      const dispute = await db.query<{ status: string }>(
        "SELECT status FROM session_dispute WHERE id = $1",
        [seedB.disputeId],
      );
      expect(dispute.rows[0]?.status).toBe("open");
    });
  });

  it("4. platform-scoped tablolar okul bağlamında toptan permission denied", async () => {
    const platformTables = [
      "payout",
      "payout_batch",
      "payout_line",
      "teacher_document",
      "hr_interview",
      "assignment",
      "teacher_availability",
      "webhook_event",
      "teacher_invite",
      "teacher_portal_token",
      "session_event",
      "teacher_pool",
    ];
    for (const table of platformTables) {
      await expect(
        testDb.pool.withSchool([seedA.schoolId], (db) => db.query(`SELECT 1 FROM ${table}`)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("5. ledger_entry/ledger_account: A yalnız kendi satır ve hesaplarını görür", async () => {
    await testDb.pool.withSchool([seedA.schoolId], async (db) => {
      const entries = await db.query<{ school_id: string | null; amount_cents: string }>(
        "SELECT school_id, amount_cents FROM ledger_entry",
      );
      expect(entries.rows).toHaveLength(1);
      expect(entries.rows[0]?.school_id).toBe(seedA.schoolId);
      expect(Number(entries.rows[0]?.amount_cents)).toBe(seedA.ledgerAmountCents);

      const entriesB = await db.query("SELECT 1 FROM ledger_entry WHERE school_id = $1", [
        seedB.schoolId,
      ]);
      expect(entriesB.rowCount).toBe(0);

      // Hesaplar: yalnız A'nın school_cash'i; B'nin hesabı ve platform clearing görünmez.
      const accounts = await db.query<{ owner_type: string; owner_id: string | null; kind: string }>(
        "SELECT owner_type, owner_id, kind FROM ledger_account",
      );
      expect(accounts.rows).toHaveLength(1);
      expect(accounts.rows[0]).toMatchObject({
        owner_type: "school",
        owner_id: seedA.schoolId,
        kind: "school_cash",
      });
    });
  });
});
