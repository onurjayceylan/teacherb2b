// Backfill SLA süpürücüsü: (a) eğitmensiz kalmış cancelled_teacher slot gelecekteyse
// yeniden teklif; (b) SLA penceresine girmiş atanmamış slot escalate + okul parası iade;
// (c) aday yokken uzak-gelecek slot DEĞİŞMEZ (süpürücü durum bozmaz).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import {
  acceptOffer,
  getSlot,
  materializePlans,
  offerNext,
  sweepBackfill,
  teacherDrop,
} from "../src/index.js";
import {
  allWeekAvailability,
  assertInvariantsClean,
  balance,
  completePlan,
  futureDate,
  seedPlan,
  seedPool,
  seedSchool,
  seedTeacher,
  topupSchool,
} from "./helpers.js";

const TZ = "Europe/Istanbul";

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

interface Scenario {
  schoolId: string;
  poolId: string;
  slotId: string;
}

/** Okul+havuz+tek slotluk plan kurar, materialize eder, planı kapatır. */
async function scenario(input: {
  name: string;
  priceCents: number;
  teacherPayCents: number;
  daysAhead: number;
}): Promise<Scenario> {
  const { schoolId, classGroupId } = await seedSchool(tdb.pool, input.name);
  const poolId = await seedPool(tdb.pool, `pool_${input.name}`);
  await topupSchool(tdb.pool, schoolId, input.priceCents);
  const start = futureDate(TZ, input.daysAhead);
  const planId = await seedPlan(tdb.pool, {
    schoolId,
    classGroupId,
    poolId,
    weekday: start.weekday,
    startMinute: 720, // 12:00 okul-lokal
    durationMin: 60,
    schoolTz: TZ,
    priceCents: input.priceCents,
    teacherPayCents: input.teacherPayCents,
    startDate: start.dateISO,
    weeks: 1,
  });
  const result = await materializePlans(tdb.pool);
  expect(result).toEqual({ created: 1, blocked: 0, skipped: 0 });
  await completePlan(tdb.pool, planId);

  const slotId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      "SELECT id FROM booking_slot WHERE plan_id = $1",
      [planId],
    );
    return res.rows[0]!.id;
  });
  return { schoolId, poolId, slotId };
}

/** Slot için teklif açıp kabul eder → confirmed atama + eğitmen döner. */
async function offerAndAccept(slotId: string): Promise<string> {
  const offer = await tdb.pool.withPlatform(async (db) => {
    const slot = await getSlot(db, slotId);
    if (!slot) throw new Error("slot yok");
    return offerNext(db, slot);
  });
  expect(offer).not.toBeNull();
  const accepted = await acceptOffer(tdb.pool, offer!.token);
  expect(accepted).toEqual({ ok: true, slotId });
  return offer!.teacherId;
}

async function slotState(slotId: string): Promise<{
  status: string;
  starts_at: Date;
  hold_txn_id: string | null;
  hold_released_txn_id: string | null;
}> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{
      status: string;
      starts_at: Date;
      hold_txn_id: string | null;
      hold_released_txn_id: string | null;
    }>(
      `SELECT status, starts_at, hold_txn_id, hold_released_txn_id
         FROM booking_slot WHERE id = $1`,
      [slotId],
    );
    return res.rows[0]!;
  });
}

describe("sweepBackfill", () => {
  it("(a) cancelled_teacher + gelecekteki ders: yeni aday çıkınca yeniden teklif, slot scheduled", async () => {
    const s = await scenario({
      name: "bf_reoffer",
      priceCents: 9_000,
      teacherPayCents: 5_000,
      daysAhead: 10,
    });
    const t1 = await seedTeacher(tdb.pool, {
      email: "bf.drop@example.com",
      timezone: TZ,
      poolId: s.poolId,
      availability: allWeekAvailability(),
    });
    expect(await offerAndAccept(s.slotId)).toBe(t1);

    // t1 düşer; başka aday yok → slot cancelled_teacher, hold okula iade edilir
    expect(await teacherDrop(tdb.pool, { slotId: s.slotId })).toEqual({ reoffered: false });
    expect((await slotState(s.slotId)).status).toBe("cancelled_teacher");
    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(9_000);

    // Havuza YENİ eğitmen katılır → süpürücü slotu geri kazanır
    const t2 = await seedTeacher(tdb.pool, {
      email: "bf.next@example.com",
      timezone: TZ,
      poolId: s.poolId,
      availability: allWeekAvailability(),
    });

    expect(await sweepBackfill(tdb.pool)).toEqual({ offered: 0, reoffered: 1, escalated: 0 });

    const state = await slotState(s.slotId);
    expect(state.status).toBe("scheduled");
    // para durumu drop anında çözülmüştü — süpürücü hold'a dokunmaz
    expect(state.hold_released_txn_id).not.toBeNull();
    const asg = await tdb.pool.withPlatform(async (db) => {
      const res = await db.query<{ teacher_id: string; status: string }>(
        "SELECT teacher_id, status FROM assignment WHERE slot_id = $1 ORDER BY created_at",
        [s.slotId],
      );
      return res.rows;
    });
    expect(asg).toEqual([
      { teacher_id: t1, status: "dropped" },
      { teacher_id: t2, status: "offered" },
    ]);
    await assertInvariantsClean(tdb.pool);
  });

  it("(b) SLA penceresine girmiş atanmamış slot: escalated + okul parası iade + audit satırı", async () => {
    // Havuzda hiç eğitmen yok → slot atanmadan bekliyor
    const s = await scenario({
      name: "bf_escalate",
      priceCents: 7_000,
      teacherPayCents: 3_000,
      daysAhead: 8,
    });
    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(0);
    expect(await balance(tdb.pool, "school", s.schoolId, "wallet_hold")).toBe(7_000);

    // 'now'u derse 1 saat kalaya kur: 1s <= slaHours(2) → escalate dalı
    const startsAt = (await slotState(s.slotId)).starts_at;
    const result = await sweepBackfill(tdb.pool, {
      now: new Date(startsAt.getTime() - 60 * 60_000),
    });
    expect(result).toEqual({ offered: 0, reoffered: 0, escalated: 1 });

    const state = await slotState(s.slotId);
    expect(state.status).toBe("escalated");
    expect(state.hold_released_txn_id).not.toBeNull();
    // SLA sözü: okulun parası geri
    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(7_000);
    expect(await balance(tdb.pool, "school", s.schoolId, "wallet_hold")).toBe(0);

    const audit = await tdb.pool.withPlatform(async (db) => {
      const res = await db.query<{ actor_kind: string; entity_type: string }>(
        "SELECT actor_kind, entity_type FROM audit_log WHERE action = 'sla_escalated' AND entity_id = $1",
        [s.slotId],
      );
      return res.rows;
    });
    expect(audit).toEqual([{ actor_kind: "system", entity_type: "booking_slot" }]);
    await assertInvariantsClean(tdb.pool);
  });

  it("(c) aday yokken uzak-gelecek slot DEĞİŞMEZ: offered 0, escalated 0, hold yerinde", async () => {
    const s = await scenario({
      name: "bf_nochange",
      priceCents: 6_000,
      teacherPayCents: 2_500,
      daysAhead: 12,
    });

    expect(await sweepBackfill(tdb.pool)).toEqual({ offered: 0, reoffered: 0, escalated: 0 });

    const state = await slotState(s.slotId);
    expect(state.status).toBe("scheduled");
    expect(state.hold_txn_id).not.toBeNull();
    expect(state.hold_released_txn_id).toBeNull();
    expect(await balance(tdb.pool, "school", s.schoolId, "wallet_hold")).toBe(6_000);
    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(0);
    const asg = await tdb.pool.withPlatform(async (db) => {
      const res = await db.query("SELECT 1 FROM assignment WHERE slot_id = $1", [s.slotId]);
      return res.rowCount ?? 0;
    });
    expect(asg).toBe(0);
    await assertInvariantsClean(tdb.pool);
  });
});
