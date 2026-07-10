// Materializer: idempotenlik, plan_exception, yetersiz bakiye ve DST duvar saati.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { DateTime } from "luxon";
import { materializePlans } from "../src/index.js";
import {
  assertInvariantsClean,
  balance,
  completePlan,
  futureDate,
  seedPlan,
  seedPool,
  seedSchool,
  topupSchool,
} from "./helpers.js";

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

interface SlotSummary {
  occurrence_key: string;
  status: string;
  starts_at: Date;
  hold_txn_id: string | null;
}

async function planSlots(planId: string): Promise<SlotSummary[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<SlotSummary>(
      `SELECT occurrence_key::text AS occurrence_key, status, starts_at, hold_txn_id
         FROM booking_slot WHERE plan_id = $1 ORDER BY occurrence_key`,
      [planId],
    );
    return res.rows;
  });
}

describe("materializePlans", () => {
  it("4 haftalık plan → 4 slot + 4 hold; ikinci koşu idempotent; exception haftası atlanır", async () => {
    const { schoolId, classGroupId } = await seedSchool(tdb.pool, "Mat Okul");
    const poolId = await seedPool(tdb.pool, "mat_pool_1");
    await topupSchool(tdb.pool, schoolId, 50_000);

    const start = futureDate("Europe/Istanbul", 2);
    const planId = await seedPlan(tdb.pool, {
      schoolId,
      classGroupId,
      poolId,
      weekday: start.weekday,
      startMinute: 600, // 10:00 okul-lokal
      durationMin: 60,
      schoolTz: "Europe/Istanbul",
      priceCents: 10_000,
      teacherPayCents: 6_000,
      startDate: start.dateISO,
      weeks: 4,
    });

    const first = await materializePlans(tdb.pool);
    expect(first).toEqual({ created: 4, blocked: 0, skipped: 0 });

    // Bakiye 4×price düştü, karşılığı wallet_hold'da
    expect(await balance(tdb.pool, "school", schoolId, "school_cash")).toBe(10_000);
    expect(await balance(tdb.pool, "school", schoolId, "wallet_hold")).toBe(40_000);

    const slots = await planSlots(planId);
    expect(slots).toHaveLength(4);
    for (const slot of slots) {
      expect(slot.status).toBe("scheduled");
      expect(slot.hold_txn_id).not.toBeNull();
    }

    // İkinci koşu: idempotent — yeni slot yok, yeni hold yok
    const second = await materializePlans(tdb.pool);
    expect(second).toEqual({ created: 0, blocked: 0, skipped: 4 });
    expect(await balance(tdb.pool, "school", schoolId, "school_cash")).toBe(10_000);
    expect(await balance(tdb.pool, "school", schoolId, "wallet_hold")).toBe(40_000);
    await assertInvariantsClean(tdb.pool);
    await completePlan(tdb.pool, planId);

    // plan_exception'lı hafta hiç üretilmez → 3 slot
    const { schoolId: school2, classGroupId: cg2 } = await seedSchool(tdb.pool, "Mat Okul 2");
    await topupSchool(tdb.pool, school2, 40_000);
    const plan2 = await seedPlan(tdb.pool, {
      schoolId: school2,
      classGroupId: cg2,
      poolId,
      weekday: start.weekday,
      startMinute: 600,
      durationMin: 60,
      schoolTz: "Europe/Istanbul",
      priceCents: 10_000,
      teacherPayCents: 6_000,
      startDate: start.dateISO,
      weeks: 4,
    });
    const skipDate = DateTime.fromISO(start.dateISO).plus({ days: 7 }).toISODate()!;
    await tdb.pool.withPlatform((db) =>
      db.query("INSERT INTO plan_exception (plan_id, skip_date, reason) VALUES ($1, $2, 'tatil')", [
        plan2,
        skipDate,
      ]),
    );

    const third = await materializePlans(tdb.pool);
    expect(third).toEqual({ created: 3, blocked: 0, skipped: 0 });
    const slots2 = await planSlots(plan2);
    expect(slots2).toHaveLength(3);
    expect(slots2.map((s) => s.occurrence_key)).not.toContain(skipDate);
    expect(await balance(tdb.pool, "school", school2, "wallet_hold")).toBe(30_000);
    await completePlan(tdb.pool, plan2);
  });

  it("yetersiz bakiye: 1 ders'lik bakiyeyle 1 scheduled + 3 blocked; bakiye 0 altına inmez", async () => {
    const { schoolId, classGroupId } = await seedSchool(tdb.pool, "Fakir Okul");
    const poolId = await seedPool(tdb.pool, "mat_pool_2");
    await topupSchool(tdb.pool, schoolId, 12_000); // tam 1 ders

    const start = futureDate("Europe/Istanbul", 3);
    const planId = await seedPlan(tdb.pool, {
      schoolId,
      classGroupId,
      poolId,
      weekday: start.weekday,
      startMinute: 540,
      durationMin: 45,
      schoolTz: "Europe/Istanbul",
      priceCents: 12_000,
      teacherPayCents: 7_000,
      startDate: start.dateISO,
      weeks: 4,
    });

    const result = await materializePlans(tdb.pool);
    expect(result).toEqual({ created: 1, blocked: 3, skipped: 0 });

    expect(await balance(tdb.pool, "school", schoolId, "school_cash")).toBe(0);
    expect(await balance(tdb.pool, "school", schoolId, "wallet_hold")).toBe(12_000);

    const slots = await planSlots(planId);
    expect(slots).toHaveLength(4);
    // Kronolojik ilk occurrence fonlandı, kalanlar hold'suz blocked
    expect(slots[0]!.status).toBe("scheduled");
    expect(slots[0]!.hold_txn_id).not.toBeNull();
    for (const slot of slots.slice(1)) {
      expect(slot.status).toBe("blocked_insufficient_funds");
      expect(slot.hold_txn_id).toBeNull();
    }
    await assertInvariantsClean(tdb.pool);
    await completePlan(tdb.pool, planId);
  });

  it("DST duvar saati: Mart geçişini kesen NY planında her slot lokal 15:00, UTC offset kayar", async () => {
    const { schoolId, classGroupId } = await seedSchool(tdb.pool, "DST Okul");
    const poolId = await seedPool(tdb.pool, "mat_pool_3");
    await topupSchool(tdb.pool, schoolId, 27_000);

    // 2026 DST: 8 Mart Pazar → pazartesiler 2, 9, 16 Mart geçişi keser
    const planId = await seedPlan(tdb.pool, {
      schoolId,
      classGroupId,
      poolId,
      weekday: 0, // Pazartesi
      startMinute: 900, // 15:00 okul-lokal
      durationMin: 60,
      schoolTz: "America/New_York",
      priceCents: 9_000,
      teacherPayCents: 5_000,
      startDate: "2026-03-02",
      weeks: 3,
    });

    const result = await materializePlans(tdb.pool, {
      now: new Date("2026-02-24T00:00:00.000Z"),
      horizonWeeks: 4,
    });
    expect(result).toEqual({ created: 3, blocked: 0, skipped: 0 });

    const slots = await planSlots(planId);
    expect(slots.map((s) => s.occurrence_key)).toEqual([
      "2026-03-02",
      "2026-03-09",
      "2026-03-16",
    ]);

    const utcHours: number[] = [];
    for (const slot of slots) {
      const local = DateTime.fromJSDate(slot.starts_at, { zone: "America/New_York" });
      expect(local.hour).toBe(15); // duvar saati her hafta sabit
      expect(local.minute).toBe(0);
      utcHours.push(DateTime.fromJSDate(slot.starts_at, { zone: "utc" }).hour);
    }
    // EST (UTC-5) → 20:00Z; EDT (UTC-4) → 19:00Z
    expect(utcHours).toEqual([20, 19, 19]);
    await assertInvariantsClean(tdb.pool);
    await completePlan(tdb.pool, planId);
  });
});
