// Uçtan uca: plan → materialize (hold) → teklif → kabul → geç iptal → bakiyeler + invariant'lar.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import {
  acceptOffer,
  cancelBySchool,
  getSlot,
  materializePlans,
  offerNext,
} from "../src/index.js";
import {
  allWeekAvailability,
  assertInvariantsClean,
  balance,
  entrySum,
  futureDate,
  seedPlan,
  seedPool,
  seedSchool,
  seedTeacher,
  topupSchool,
} from "./helpers.js";

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

test("plan → materialize → offer → accept → geç iptal: tüm bakiyeler beklenen", async () => {
  const { schoolId, classGroupId } = await seedSchool(tdb.pool, "E2E Okul");
  const poolId = await seedPool(tdb.pool, "e2e_pool");
  await topupSchool(tdb.pool, schoolId, 10_000); // tam 1 ders

  const start = futureDate("Europe/Istanbul", 7);
  const planId = await seedPlan(tdb.pool, {
    schoolId,
    classGroupId,
    poolId,
    weekday: start.weekday,
    startMinute: 840, // 14:00
    durationMin: 60,
    schoolTz: "Europe/Istanbul",
    priceCents: 10_000,
    teacherPayCents: 6_000,
    startDate: start.dateISO,
    weeks: 1,
  });

  // 1) Materialize: slot + hold (havuz henüz boş → teklif açılmaz, slot scheduled kalır)
  expect(await materializePlans(tdb.pool)).toEqual({ created: 1, blocked: 0, skipped: 0 });
  expect(await balance(tdb.pool, "school", schoolId, "school_cash")).toBe(0);
  expect(await balance(tdb.pool, "school", schoolId, "wallet_hold")).toBe(10_000);

  const slotId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      "SELECT id FROM booking_slot WHERE plan_id = $1",
      [planId],
    );
    expect(res.rows).toHaveLength(1);
    return res.rows[0]!.id;
  });

  // 2) Eğitmen havuza katılır → teklif → token'la kabul
  const teacherId = await seedTeacher(tdb.pool, {
    email: "e2e.teacher@example.com",
    timezone: "Europe/Istanbul",
    poolId,
    availability: allWeekAvailability(),
  });
  const offer = await tdb.pool.withPlatform(async (db) => {
    const slot = await getSlot(db, slotId);
    return offerNext(db, slot!);
  });
  expect(offer!.teacherId).toBe(teacherId);
  expect(await acceptOffer(tdb.pool, offer!.token)).toEqual({ ok: true, slotId });

  // 3) Okul derse 3 saat kala iptal eder → %50 kesinti matrisi
  const platformBefore = await entrySum(tdb.pool, "platform", null, "platform_revenue");
  const startsAt = await tdb.pool.withPlatform(async (db) => (await getSlot(db, slotId))!.starts_at);
  const result = await cancelBySchool(tdb.pool, {
    slotId,
    now: new Date(startsAt.getTime() - 3 * 60 * 60_000),
  });
  expect(result).toEqual({ slotId, status: "cancelled_school_late" });

  // half=5000 → okula 5000; tpHalf=3000 eğitmene; 2000 platforma; hold sıfırlandı
  expect(await balance(tdb.pool, "school", schoolId, "school_cash")).toBe(5_000);
  expect(await balance(tdb.pool, "school", schoolId, "wallet_hold")).toBe(0);
  expect(await balance(tdb.pool, "teacher", teacherId, "teacher_payable")).toBe(3_000);
  // platform_revenue track_balance dışı → bacak toplamından doğrula
  expect(await entrySum(tdb.pool, "platform", null, "platform_revenue")).toBe(
    platformBefore + 2_000,
  );

  await tdb.pool.withPlatform(async (db) => {
    // Ledger izi: hold + late_cancel, ikisi de slot'a bağlı
    const txns = await db.query<{ type: string; idempotency_key: string }>(
      `SELECT type, idempotency_key FROM ledger_transaction
        WHERE ref_type = 'booking_slot' AND ref_id = $1 ORDER BY created_at`,
      [slotId],
    );
    expect(txns.rows.map((t) => t.type)).toEqual(["hold", "late_cancel"]);
    expect(txns.rows[0]!.idempotency_key).toBe(`hold:slot:${slotId}`);
    expect(txns.rows[1]!.idempotency_key).toBe(`late_cancel:slot:${slotId}`);

    // Atama iptal edildi; para etkili işlemler audit'te
    const asg = await db.query<{ status: string }>(
      "SELECT status FROM assignment WHERE slot_id = $1",
      [slotId],
    );
    expect(asg.rows).toEqual([{ status: "cancelled" }]);
    const audit = await db.query<{ action: string }>(
      `SELECT action FROM audit_log
        WHERE entity_type = 'booking_slot' AND entity_id = $1 ORDER BY id`,
      [slotId],
    );
    expect(audit.rows.map((a) => a.action)).toEqual(["slot_hold_created", "slot_late_cancel"]);
  });

  await assertInvariantsClean(tdb.pool);
});
