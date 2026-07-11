// Dispatch job sarmalayıcıları: materializer slot+hold açar, sweeper süresi dolan
// teklifi expire eder. index.ts import EDİLMEZ — yalnız job fonksiyonları test edilir.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { runDispatchMaterializer, runOfferTimeoutSweeper } from "../src/dispatch-jobs.js";

let tdb: TestDb;
let schoolId: string;
let planId: string;

beforeAll(async () => {
  tdb = await createTestDb();

  // Org + okul + havuz + plan (worker dispatch modülünün seed'lerine bağımlı değil — ham SQL)
  const seeded = await tdb.pool.withPlatform(async (db) => {
    const org = await db.query<{ id: string }>(
      "INSERT INTO organization (name) VALUES ('Worker Org') RETURNING id",
    );
    const school = await db.query<{ id: string }>(
      "INSERT INTO school (organization_id, name) VALUES ($1, 'Worker Okul') RETURNING id",
      [org.rows[0]!.id],
    );
    const pool = await db.query<{ id: string }>(
      "INSERT INTO pool (key, name, sell_per_lesson_cents, pay_per_lesson_cents) VALUES ('worker_pool', 'Worker Pool', 4000, 1600) RETURNING id",
    );
    return { schoolId: school.rows[0]!.id, poolId: pool.rows[0]!.id };
  });
  schoolId = seeded.schoolId;

  const classGroupId = await tdb.pool.withSchool([schoolId], async (db) => {
    const res = await db.query<{ id: string }>(
      "INSERT INTO class_group (school_id, name) VALUES ($1, '7-B') RETURNING id",
      [schoolId],
    );
    return res.rows[0]!.id;
  });

  planId = await tdb.pool.withPlatform(async (db) => {
    // Okul kasasına 1 ders'lik bakiye (post_ledger_txn topup)
    const cash = await db.query<{ id: string }>(
      "SELECT ensure_ledger_account('school', $1, 'school_cash') AS id",
      [schoolId],
    );
    const clearing = await db.query<{ id: string }>(
      "SELECT ensure_ledger_account('platform', NULL, 'bank_clearing') AS id",
    );
    await db.query("SELECT * FROM post_ledger_txn($1, 'topup', 'test_topup', $2, $3::jsonb)", [
      "test:topup:worker",
      "00000000-0000-4000-8000-000000000001",
      JSON.stringify([
        { account_id: cash.rows[0]!.id, amount_cents: 10_000 },
        { account_id: clearing.rows[0]!.id, amount_cents: -10_000 },
      ]),
    ]);

    // Yarından itibaren haftada 1 ders, 1 hafta — ufuk penceresinin içinde
    const start = await db.query<{ d: string; wd: number }>(
      `SELECT (current_date + 2)::text AS d,
              (EXTRACT(isodow FROM current_date + 2)::int - 1) AS wd`,
    );
    const plan = await db.query<{ id: string }>(
      `INSERT INTO dosage_plan
         (school_id, class_group_id, pool_id, weekday, start_minute, duration_min,
          school_tz, price_cents, teacher_pay_cents, start_date, weeks)
       VALUES ($1, $2, $3, $4, 600, 60, 'Europe/Istanbul', 10000, 6000, $5, 1)
       RETURNING id`,
      [schoolId, classGroupId, seeded.poolId, start.rows[0]!.wd, start.rows[0]!.d],
    );
    return plan.rows[0]!.id;
  });
});

afterAll(async () => {
  await tdb.drop();
});

test("dispatch-materializer job'ı: slot + hold açılır; ikinci koşu idempotent", async () => {
  expect(await runDispatchMaterializer(tdb.pool)).toEqual({
    created: 1,
    blocked: 0,
    skipped: 0,
  });
  expect(await runDispatchMaterializer(tdb.pool)).toEqual({
    created: 0,
    blocked: 0,
    skipped: 1,
  });

  await tdb.pool.withPlatform(async (db) => {
    const slot = await db.query<{ status: string; hold_txn_id: string | null }>(
      "SELECT status, hold_txn_id FROM booking_slot WHERE plan_id = $1",
      [planId],
    );
    expect(slot.rows).toHaveLength(1);
    expect(slot.rows[0]!.status).toBe("scheduled");
    expect(slot.rows[0]!.hold_txn_id).not.toBeNull();

    const cash = await db.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM ledger_account
        WHERE owner_type = 'school' AND owner_id = $1 AND kind = 'school_cash'`,
      [schoolId],
    );
    expect(Number(cash.rows[0]!.balance_cents)).toBe(0); // 1 ders'lik hold düştü
  });
});

test("offer-timeout-sweeper job'ı: süresi dolan teklif expire edilir", async () => {
  // Havuz üyeliği/müsaitliği olmayan eğitmene elle 'offered' atama yaz (süresi geçmiş)
  await tdb.pool.withPlatform(async (db) => {
    const teacher = await db.query<{ id: string }>(
      `INSERT INTO teacher (full_name, email, source, status, dispatch_ready)
       VALUES ('Sweeper Teacher', 'sweeper.teacher@example.com', 'hrmasterz', 'active', true)
       RETURNING id`,
    );
    await db.query(
      `INSERT INTO assignment
         (slot_id, teacher_id, status, starts_at, ends_at, offer_token_hash, offer_expires_at)
       SELECT id, $1, 'offered', starts_at, ends_at, $2, now() - interval '1 minute'
         FROM booking_slot WHERE plan_id = $3`,
      [
        teacher.rows[0]!.id,
        createHash("sha256").update(randomBytes(32)).digest("hex"),
        planId,
      ],
    );
  });

  // Aday yok (eğitmen havuz üyesi değil) → yalnız expire, re-offer yok
  expect(await runOfferTimeoutSweeper(tdb.pool)).toEqual({ expired: 1, reoffered: 0 });

  await tdb.pool.withPlatform(async (db) => {
    const asg = await db.query<{ status: string }>(
      `SELECT a.status FROM assignment a
        JOIN booking_slot s ON s.id = a.slot_id
       WHERE s.plan_id = $1`,
      [planId],
    );
    expect(asg.rows).toEqual([{ status: "expired" }]);
  });
});
