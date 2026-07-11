// Yeni worker job'larının smoke'u: backfill süpürücüsü SLA penceresindeki atanmamış
// slotu escalate eder; payout reconciler 1 saatten uzun 'submitted'da bekleyen payout'a
// 'payout_stuck' warning'i yazar (24 saat tekrar korumalı). index.ts import EDİLMEZ.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { runBackfillSweep } from "../src/backfill-jobs.js";
import { runPayoutReconciler } from "../src/payout-reconciler.js";

let tdb: TestDb;
let schoolId: string;
let classGroupId: string;
let poolId: string;
let planId: string;

beforeAll(async () => {
  tdb = await createTestDb();

  const seeded = await tdb.pool.withPlatform(async (db) => {
    const org = await db.query<{ id: string }>(
      "INSERT INTO organization (name) VALUES ('Backfill Org') RETURNING id",
    );
    const school = await db.query<{ id: string }>(
      "INSERT INTO school (organization_id, name) VALUES ($1, 'Backfill Okul') RETURNING id",
      [org.rows[0]!.id],
    );
    const pool = await db.query<{ id: string }>(
      "INSERT INTO pool (key, name, sell_per_lesson_cents, pay_per_lesson_cents) VALUES ('backfill_pool', 'Backfill Pool', 4000, 1600) RETURNING id",
    );
    return { schoolId: school.rows[0]!.id, poolId: pool.rows[0]!.id };
  });
  schoolId = seeded.schoolId;
  poolId = seeded.poolId;

  classGroupId = await tdb.pool.withSchool([schoolId], async (db) => {
    const res = await db.query<{ id: string }>(
      "INSERT INTO class_group (school_id, name) VALUES ($1, '9-A') RETURNING id",
      [schoolId],
    );
    return res.rows[0]!.id;
  });

  planId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO dosage_plan
         (school_id, class_group_id, pool_id, weekday, start_minute, duration_min,
          school_tz, price_cents, teacher_pay_cents, start_date, weeks, status)
       VALUES ($1, $2, $3, 0, 600, 60, 'UTC', 4000, 1600, current_date, 1, 'completed')
       RETURNING id`,
      [schoolId, classGroupId, poolId],
    );
    return res.rows[0]!.id;
  });
});

afterAll(async () => {
  await tdb.drop();
});

test("backfill-sweeper job'ı: SLA penceresindeki atanmamış slot escalate edilir", async () => {
  // Derse 1 saat var, atama yok, hold yok (para bacağı dispatch testlerinde) → escalate
  const slotId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO booking_slot
         (school_id, plan_id, class_group_id, pool_id, occurrence_key,
          starts_at, ends_at, price_cents, teacher_pay_cents)
       VALUES ($1, $2, $3, $4, current_date, now() + interval '1 hour',
               now() + interval '2 hours', 4000, 1600)
       RETURNING id`,
      [schoolId, planId, classGroupId, poolId],
    );
    return res.rows[0]!.id;
  });

  expect(await runBackfillSweep(tdb.pool)).toEqual({ offered: 0, reoffered: 0, escalated: 1 });

  await tdb.pool.withPlatform(async (db) => {
    const slot = await db.query<{ status: string }>(
      "SELECT status FROM booking_slot WHERE id = $1",
      [slotId],
    );
    expect(slot.rows[0]!.status).toBe("escalated");
    const audit = await db.query<{ actor_kind: string }>(
      "SELECT actor_kind FROM audit_log WHERE action = 'sla_escalated' AND entity_id = $1",
      [slotId],
    );
    expect(audit.rows).toEqual([{ actor_kind: "system" }]);
  });

  // İkinci koşu: escalated slot artık süpürülmez
  expect(await runBackfillSweep(tdb.pool)).toEqual({ offered: 0, reoffered: 0, escalated: 0 });
});

test("payout-reconciler job'ı: 1 saatten uzun 'submitted' payout warning'lenir (24s tekrar korumalı)", async () => {
  const payoutId = await tdb.pool.withPlatform(async (db) => {
    const teacher = await db.query<{ id: string }>(
      `INSERT INTO teacher (full_name, email, source, timezone, status, dispatch_ready)
       VALUES ('Stuck Teacher', 'stuck.teacher@example.com', 'hrmasterz', 'UTC', 'active', true)
       RETURNING id`,
    );
    const batch = await db.query<{ id: string }>(
      `INSERT INTO payout_batch (period_start, period_end, status)
       VALUES (current_date - 7, current_date, 'exported') RETURNING id`,
    );
    // Durum whitelist trigger'ı yalnız UPDATE'te — INSERT anında 'submitted' kurulabilir
    const payout = await db.query<{ id: string }>(
      `INSERT INTO payout
         (batch_id, teacher_id, amount_cents, status, provider_idempotency_key, submitted_at)
       VALUES ($1, $2, 3200, 'submitted', $3, now() - interval '2 hours')
       RETURNING id`,
      [batch.rows[0]!.id, teacher.rows[0]!.id, `payout:${teacher.rows[0]!.id}:${batch.rows[0]!.id}`],
    );
    return payout.rows[0]!.id;
  });

  const first = await runPayoutReconciler(tdb.pool);
  expect(first.stuck).toHaveLength(1);
  expect(first.stuck[0]!.payoutId).toBe(payoutId);

  const auditCount = async (): Promise<number> =>
    tdb.pool.withPlatform(async (db) => {
      const res = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log
          WHERE action = 'sentinel_warning' AND entity_type = 'payout'
            AND entity_id = $1 AND after->>'check' = 'payout_stuck'`,
        [payoutId],
      );
      return Number(res.rows[0]!.n);
    });
  expect(await auditCount()).toBe(1);

  // İkinci koşu: durum fotoğrafı yine raporlanır, audit'e YENİDEN yazılmaz
  const second = await runPayoutReconciler(tdb.pool);
  expect(second.stuck).toHaveLength(1);
  expect(await auditCount()).toBe(1);
});
