// İptal/no-show matrisi: erken iptal tam iade, geç iptal %50 kesinti (floor matematiği),
// eğitmen düşmesinde re-offer/iade ve no-show'da iade + strike/suspend.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import {
  acceptOffer,
  cancelBySchool,
  getSlot,
  materializePlans,
  offerNext,
  teacherDrop,
  teacherNoShow,
} from "../src/index.js";
import {
  allWeekAvailability,
  assertInvariantsClean,
  balance,
  completePlan,
  entrySum,
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
  planId: string;
  slotIds: string[];
}

/** Okul+havuz+plan kurar, materialize eder ve planı kapatır (senaryolar birbirine karışmaz). */
async function scenario(input: {
  name: string;
  priceCents: number;
  teacherPayCents: number;
  topupCents: number;
  weeks: number;
  daysAhead: number;
}): Promise<Scenario> {
  const { schoolId, classGroupId } = await seedSchool(tdb.pool, input.name);
  const poolId = await seedPool(tdb.pool, `pool_${input.name}`);
  await topupSchool(tdb.pool, schoolId, input.topupCents);
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
    weeks: input.weeks,
  });
  const result = await materializePlans(tdb.pool);
  expect(result).toEqual({ created: input.weeks, blocked: 0, skipped: 0 });
  await completePlan(tdb.pool, planId);

  const slotIds = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      "SELECT id FROM booking_slot WHERE plan_id = $1 ORDER BY occurrence_key",
      [planId],
    );
    return res.rows.map((r) => r.id);
  });
  return { schoolId, poolId, planId, slotIds };
}

/** Havuzdaki slot için teklif açıp kabul eder → confirmed atama + eğitmen döner. */
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
  hold_txn_id: string | null;
  hold_released_txn_id: string | null;
}> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{
      status: string;
      hold_txn_id: string | null;
      hold_released_txn_id: string | null;
    }>("SELECT status, hold_txn_id, hold_released_txn_id FROM booking_slot WHERE id = $1", [
      slotId,
    ]);
    return res.rows[0]!;
  });
}

async function assignments(slotId: string): Promise<{ teacher_id: string; status: string }[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ teacher_id: string; status: string }>(
      "SELECT teacher_id, status FROM assignment WHERE slot_id = $1 ORDER BY created_at",
      [slotId],
    );
    return res.rows;
  });
}

/** Verilen alıcının 'teacher_slot_cancelled' outbox kayıtları (payload'larıyla). */
async function cancelledNotices(
  recipient: string,
): Promise<{ status: string; payload: Record<string, unknown> }[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ status: string; payload: Record<string, unknown> }>(
      `SELECT status, payload FROM notification_outbox
        WHERE template = 'teacher_slot_cancelled' AND recipient_email = $1
        ORDER BY created_at`,
      [recipient],
    );
    return res.rows;
  });
}

describe("cancelBySchool", () => {
  it("≥24 saat: tam iade, slot cancelled_school_early, canlı atama iptal", async () => {
    const s = await scenario({
      name: "early_okul",
      priceCents: 10_000,
      teacherPayCents: 6_000,
      topupCents: 10_000,
      weeks: 1,
      daysAhead: 10,
    });
    const teacherId = await seedTeacher(tdb.pool, {
      email: "early.t@example.com",
      timezone: TZ,
      poolId: s.poolId,
      availability: allWeekAvailability(),
    });
    const slotId = s.slotIds[0]!;
    await tdb.pool.withPlatform(async (db) => {
      const slot = await getSlot(db, slotId);
      await offerNext(db, slot!); // offered atama açık kalsın → iptal onu da kapatmalı
    });

    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(0);
    const result = await cancelBySchool(tdb.pool, { slotId }); // ders 10 gün sonra → erken
    expect(result).toEqual({ slotId, status: "cancelled_school_early" });

    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(10_000);
    expect(await balance(tdb.pool, "school", s.schoolId, "wallet_hold")).toBe(0);
    const state = await slotState(slotId);
    expect(state.status).toBe("cancelled_school_early");
    expect(state.hold_released_txn_id).not.toBeNull();
    expect(await assignments(slotId)).toEqual([{ teacher_id: teacherId, status: "cancelled" }]);
    // Atama yalnız 'offered' aşamasındaydı → eğitmene iptal bildirimi YAZILMAZ
    expect(await cancelledNotices("early.t@example.com")).toEqual([]);
    await assertInvariantsClean(tdb.pool);
  });

  it("≥24 saat + ONAYLI eğitmen: teacher_slot_cancelled outbox kaydı (lateCancel:false)", async () => {
    const s = await scenario({
      name: "early_bildirim",
      priceCents: 6_000,
      teacherPayCents: 3_000,
      topupCents: 6_000,
      weeks: 1,
      daysAhead: 12,
    });
    await seedTeacher(tdb.pool, {
      email: "early.confirmed@example.com",
      timezone: TZ,
      poolId: s.poolId,
      availability: allWeekAvailability(),
    });
    const slotId = s.slotIds[0]!;
    await offerAndAccept(slotId);
    const startsAt = await tdb.pool.withPlatform(
      async (db) => (await getSlot(db, slotId))!.starts_at,
    );

    await cancelBySchool(tdb.pool, { slotId });

    const notices = await cancelledNotices("early.confirmed@example.com");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.status).toBe("pending");
    expect(notices[0]!.payload).toMatchObject({
      slotStartsAt: startsAt.toISOString(),
      schoolName: "early_bildirim",
      teacherTimezone: TZ,
      lateCancel: false,
    });
  });

  it("<24 saat: okula price-floor(price/2), eğitmene floor(tp/2), kalan platforma", async () => {
    const s = await scenario({
      name: "late_okul",
      priceCents: 11_001, // tek sayı → floor matematiği görünür
      teacherPayCents: 7_001,
      topupCents: 11_001,
      weeks: 1,
      daysAhead: 8,
    });
    const teacherId = await seedTeacher(tdb.pool, {
      email: "late.t@example.com",
      timezone: TZ,
      poolId: s.poolId,
      availability: allWeekAvailability(),
    });
    const slotId = s.slotIds[0]!;
    const confirmedTeacher = await offerAndAccept(slotId);
    expect(confirmedTeacher).toBe(teacherId);

    const platformBefore = await entrySum(tdb.pool, "platform", null, "platform_revenue");
    const startsAt = await tdb.pool.withPlatform(async (db) => (await getSlot(db, slotId))!.starts_at);
    const result = await cancelBySchool(tdb.pool, {
      slotId,
      now: new Date(startsAt.getTime() - 2 * 60 * 60_000), // derse 2 saat kala
    });
    expect(result).toEqual({ slotId, status: "cancelled_school_late" });

    // half=floor(11001/2)=5500 → okula 5501; tpHalf=floor(7001/2)=3500; platforma 2000
    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(5_501);
    expect(await balance(tdb.pool, "school", s.schoolId, "wallet_hold")).toBe(0);
    expect(await balance(tdb.pool, "teacher", teacherId, "teacher_payable")).toBe(3_500);
    // platform_revenue track_balance dışı → bacak toplamından doğrula
    expect(await entrySum(tdb.pool, "platform", null, "platform_revenue")).toBe(
      platformBefore + 2_000,
    );
    expect((await slotState(slotId)).status).toBe("cancelled_school_late");
    expect(await assignments(slotId)).toEqual([{ teacher_id: teacherId, status: "cancelled" }]);

    // Geç iptal: aynı transaction'da eğitmene iptal + %50 ödeme bilgisi (lateCancel:true)
    const notices = await cancelledNotices("late.t@example.com");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({
      slotStartsAt: startsAt.toISOString(),
      schoolName: "late_okul",
      lateCancel: true,
    });
    await assertInvariantsClean(tdb.pool);
  });

  it("başlamış ders iptal edilemez", async () => {
    const s = await scenario({
      name: "gec_okul",
      priceCents: 5_000,
      teacherPayCents: 3_000,
      topupCents: 5_000,
      weeks: 1,
      daysAhead: 6,
    });
    const slotId = s.slotIds[0]!;
    const startsAt = await tdb.pool.withPlatform(async (db) => (await getSlot(db, slotId))!.starts_at);
    await expect(
      cancelBySchool(tdb.pool, { slotId, now: new Date(startsAt.getTime() + 60_000) }),
    ).rejects.toThrow(/başlamış/);
  });
});

describe("teacherDrop", () => {
  it("aday varsa anında re-offer: slot scheduled'a döner, hold'a DOKUNULMAZ", async () => {
    const s = await scenario({
      name: "drop_okul",
      priceCents: 9_000,
      teacherPayCents: 5_000,
      topupCents: 9_000,
      weeks: 1,
      daysAhead: 9,
    });
    const t1 = await seedTeacher(tdb.pool, {
      email: "drop.t1@example.com",
      timezone: TZ,
      poolId: s.poolId,
      availability: allWeekAvailability(),
    });
    const t2 = await seedTeacher(tdb.pool, {
      email: "drop.t2@example.com",
      timezone: TZ,
      poolId: s.poolId,
      availability: allWeekAvailability(),
    });
    const slotId = s.slotIds[0]!;
    const confirmed = await offerAndAccept(slotId);
    expect(confirmed).toBe(t1);

    const result = await teacherDrop(tdb.pool, { slotId });
    expect(result).toEqual({ reoffered: true, teacherId: t2 });

    const state = await slotState(slotId);
    expect(state.status).toBe("scheduled");
    expect(state.hold_released_txn_id).toBeNull(); // hold aynen duruyor
    expect(await balance(tdb.pool, "school", s.schoolId, "wallet_hold")).toBe(9_000);
    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(0);
    expect(await assignments(slotId)).toEqual([
      { teacher_id: t1, status: "dropped" },
      { teacher_id: t2, status: "offered" },
    ]);
    await assertInvariantsClean(tdb.pool);
  });

  it("aday yoksa slot cancelled_teacher kalır ve hold iade edilir", async () => {
    const s = await scenario({
      name: "drop_yalniz",
      priceCents: 9_000,
      teacherPayCents: 5_000,
      topupCents: 9_000,
      weeks: 1,
      daysAhead: 11,
    });
    await seedTeacher(tdb.pool, {
      email: "drop.solo@example.com",
      timezone: TZ,
      poolId: s.poolId,
      availability: allWeekAvailability(),
    });
    const slotId = s.slotIds[0]!;
    await offerAndAccept(slotId);

    const result = await teacherDrop(tdb.pool, { slotId });
    expect(result).toEqual({ reoffered: false }); // düşen eğitmen tekrar aday olmaz

    const state = await slotState(slotId);
    expect(state.status).toBe("cancelled_teacher");
    expect(state.hold_released_txn_id).not.toBeNull();
    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(9_000);
    expect(await balance(tdb.pool, "school", s.schoolId, "wallet_hold")).toBe(0);
    // Dersi eğitmen KENDİSİ bıraktı → ona 'teacher_slot_cancelled' YAZILMAZ
    expect(await cancelledNotices("drop.solo@example.com")).toEqual([]);
    await assertInvariantsClean(tdb.pool);
  });
});

describe("teacherNoShow", () => {
  it("tam iade + strike; 3. no-show'da eğitmen suspended", async () => {
    const s = await scenario({
      name: "noshow_okul",
      priceCents: 8_000,
      teacherPayCents: 4_400,
      topupCents: 24_000,
      weeks: 3,
      daysAhead: 5,
    });
    const teacherId = await seedTeacher(tdb.pool, {
      email: "noshow.t@example.com",
      timezone: TZ,
      poolId: s.poolId,
      availability: allWeekAvailability(),
    });
    // Üç haftalık üç slotun üçünü de aynı eğitmen onaylar (haftalık → çakışma yok)
    for (const slotId of s.slotIds) {
      expect(await offerAndAccept(slotId)).toBe(teacherId);
    }
    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(0);

    expect(await teacherNoShow(tdb.pool, { slotId: s.slotIds[0]! })).toEqual({
      strikeCount: 1,
      suspended: false,
    });
    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(8_000);
    expect((await slotState(s.slotIds[0]!)).status).toBe("no_show_teacher");

    expect(await teacherNoShow(tdb.pool, { slotId: s.slotIds[1]! })).toEqual({
      strikeCount: 2,
      suspended: false,
    });

    expect(await teacherNoShow(tdb.pool, { slotId: s.slotIds[2]! })).toEqual({
      strikeCount: 3,
      suspended: true,
    });
    expect(await balance(tdb.pool, "school", s.schoolId, "school_cash")).toBe(24_000);
    expect(await balance(tdb.pool, "school", s.schoolId, "wallet_hold")).toBe(0);

    const teacher = await tdb.pool.withPlatform(async (db) => {
      const res = await db.query<{ status: string; strike_count: number }>(
        "SELECT status, strike_count FROM teacher WHERE id = $1",
        [teacherId],
      );
      return res.rows[0]!;
    });
    expect(teacher).toEqual({ status: "suspended", strike_count: 3 });
    await assertInvariantsClean(tdb.pool);
  });
});
