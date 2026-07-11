// Matcher + teklif yaşam döngüsü: aday filtreleri (müsaitlik/tz/çakışma), yük dengesi,
// CAS kabul/red ve süresi dolan tekliflerin süpürülmesi.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { DateTime } from "luxon";
import {
  acceptOffer,
  declineOffer,
  expireStaleOffers,
  findCandidates,
  getSlot,
  offerNext,
  type SlotRow,
} from "../src/index.js";
import {
  allWeekAvailability,
  futureDate,
  seedPlan,
  seedPool,
  seedSchool,
  seedTeacher,
} from "./helpers.js";

const NY = "America/New_York";

let tdb: TestDb;
let schoolId: string;
let classGroupId: string;

beforeAll(async () => {
  tdb = await createTestDb();
  ({ schoolId, classGroupId } = await seedSchool(tdb.pool, "Matcher Okul"));
});

afterAll(async () => {
  await tdb.drop();
});

/** FK için plan + istenen anda başlayan slot açar (materializer'dan bağımsız kurgu). */
async function insertSlot(input: {
  poolId: string;
  planId: string;
  occurrenceKey: string;
  startsAt: Date;
  durationMin?: number;
}): Promise<SlotRow> {
  const durationMin = input.durationMin ?? 60;
  const endsAt = new Date(input.startsAt.getTime() + durationMin * 60_000);
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO booking_slot
         (school_id, plan_id, class_group_id, pool_id, occurrence_key,
          starts_at, ends_at, price_cents, teacher_pay_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 10000, 6000)
       RETURNING id`,
      [schoolId, input.planId, classGroupId, input.poolId, input.occurrenceKey, input.startsAt, endsAt],
    );
    const slot = await getSlot(db, res.rows[0]!.id);
    if (!slot) throw new Error("insertSlot: slot okunamadı");
    return slot;
  });
}

async function makePlan(poolId: string, weekday: number, startDate: string): Promise<string> {
  return seedPlan(tdb.pool, {
    schoolId,
    classGroupId,
    poolId,
    weekday,
    startMinute: 600,
    durationMin: 60,
    schoolTz: NY,
    priceCents: 10_000,
    teacherPayCents: 6_000,
    startDate,
    weeks: 1,
  });
}

function nyInstant(dateISO: string, hour: number): Date {
  return DateTime.fromISO(dateISO, { zone: NY }).set({ hour, minute: 0 }).toJSDate();
}

async function confirmAssignment(teacherId: string, slot: SlotRow): Promise<void> {
  await tdb.pool.withPlatform((db) =>
    db.query(
      `INSERT INTO assignment (slot_id, teacher_id, status, starts_at, ends_at)
       VALUES ($1, $2, 'confirmed', $3, $4)`,
      [slot.id, teacherId, slot.starts_at, slot.ends_at],
    ),
  );
}

async function assignmentFor(slotId: string): Promise<{ teacher_id: string; status: string }[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ teacher_id: string; status: string }>(
      "SELECT teacher_id, status FROM assignment WHERE slot_id = $1 ORDER BY created_at",
      [slotId],
    );
    return res.rows;
  });
}

describe("findCandidates", () => {
  it("müsaitlik uyan eğitmen aday; TZ uyuşmayan ve çakışan onaylı ataması olan değil", async () => {
    const poolId = await seedPool(tdb.pool, "match_pool_1");
    const day = futureDate(NY, 3);
    const planId = await makePlan(poolId, day.weekday, day.dateISO);
    const slot = await insertSlot({
      poolId,
      planId,
      occurrenceKey: day.dateISO,
      startsAt: nyInstant(day.dateISO, 10), // 10:00-11:00 NY
    });

    // A: NY penceresi 09:00-12:00 → slotu tam kapsar
    const teacherA = await seedTeacher(tdb.pool, {
      email: "match.a@example.com",
      timezone: NY,
      poolId,
      availability: [{ weekday: day.weekday, startMinute: 540, endMinute: 720 }],
    });
    // B: İstanbul penceresi 09:00-12:00 — NY sabahı İstanbul akşamı → uyuşmaz
    await seedTeacher(tdb.pool, {
      email: "match.b@example.com",
      timezone: "Europe/Istanbul",
      poolId,
      availability: [{ weekday: day.weekday, startMinute: 540, endMinute: 720 }],
    });
    // C: müsait ama aynı saatte başka slotta onaylı ataması var
    const teacherC = await seedTeacher(tdb.pool, {
      email: "match.c@example.com",
      timezone: NY,
      poolId,
      availability: [{ weekday: day.weekday, startMinute: 540, endMinute: 720 }],
    });
    const otherDay = futureDate(NY, 4);
    const otherSlot = await insertSlot({
      poolId,
      planId,
      occurrenceKey: otherDay.dateISO,
      startsAt: nyInstant(day.dateISO, 10), // slot ile AYNI an
    });
    await confirmAssignment(teacherC, otherSlot);

    const candidates = await tdb.pool.withPlatform((db) => findCandidates(db, slot));
    expect(candidates.map((c) => c.teacherId)).toEqual([teacherA]);
  });

  it("yük dengesi: 2 onaylısı olan eğitmen dururken 0 onaylı önce gelir", async () => {
    const poolId = await seedPool(tdb.pool, "match_pool_2");
    const day = futureDate(NY, 5);
    const planId = await makePlan(poolId, day.weekday, day.dateISO);
    const slot = await insertSlot({
      poolId,
      planId,
      occurrenceKey: day.dateISO,
      startsAt: nyInstant(day.dateISO, 10),
    });

    // D önce yaratılır (created_at küçük) ama 2 onaylı atama taşır
    const teacherD = await seedTeacher(tdb.pool, {
      email: "match.d@example.com",
      timezone: NY,
      poolId,
      availability: allWeekAvailability(),
    });
    const teacherE = await seedTeacher(tdb.pool, {
      email: "match.e@example.com",
      timezone: NY,
      poolId,
      availability: allWeekAvailability(),
    });
    const busy1 = futureDate(NY, 6);
    const busy2 = futureDate(NY, 7);
    await confirmAssignment(
      teacherD,
      await insertSlot({
        poolId,
        planId,
        occurrenceKey: busy1.dateISO,
        startsAt: nyInstant(busy1.dateISO, 10),
      }),
    );
    await confirmAssignment(
      teacherD,
      await insertSlot({
        poolId,
        planId,
        occurrenceKey: busy2.dateISO,
        startsAt: nyInstant(busy2.dateISO, 10),
      }),
    );

    const candidates = await tdb.pool.withPlatform((db) => findCandidates(db, slot));
    expect(candidates.map((c) => c.teacherId)).toEqual([teacherE, teacherD]);
    expect(candidates.map((c) => c.confirmedCount)).toEqual([0, 2]);
  });
});

describe("teklif yaşam döngüsü", () => {
  let poolId: string;
  let planId: string;
  let teacherF: string;
  let teacherG: string;

  beforeAll(async () => {
    poolId = await seedPool(tdb.pool, "match_pool_3");
    const anchor = futureDate(NY, 8);
    planId = await makePlan(poolId, anchor.weekday, anchor.dateISO);
    teacherF = await seedTeacher(tdb.pool, {
      email: "offer.f@example.com",
      timezone: NY,
      poolId,
      availability: allWeekAvailability(),
    });
    teacherG = await seedTeacher(tdb.pool, {
      email: "offer.g@example.com",
      timezone: NY,
      poolId,
      availability: allWeekAvailability(),
    });
  });

  it("accept CAS: aynı token'la ikinci kabul expired_or_taken", async () => {
    const day = futureDate(NY, 8);
    const slot = await insertSlot({
      poolId,
      planId,
      occurrenceKey: day.dateISO,
      startsAt: nyInstant(day.dateISO, 10),
    });

    const offer = await tdb.pool.withPlatform((db) => offerNext(db, slot));
    expect(offer).not.toBeNull();
    expect(offer!.teacherId).toBe(teacherF); // ikisi de 0 onaylı → created_at sırası

    const first = await acceptOffer(tdb.pool, offer!.token);
    expect(first).toEqual({ ok: true, slotId: slot.id });
    const second = await acceptOffer(tdb.pool, offer!.token);
    expect(second).toEqual({ ok: false, reason: "expired_or_taken" });

    expect(await assignmentFor(slot.id)).toEqual([{ teacher_id: teacherF, status: "confirmed" }]);
  });

  it("decline: sıradaki adaya aynı transaction'da yeni teklif açılır", async () => {
    const day = futureDate(NY, 9);
    const slot = await insertSlot({
      poolId,
      planId,
      occurrenceKey: day.dateISO,
      startsAt: nyInstant(day.dateISO, 10),
    });

    // F artık 1 onaylı taşıyor → teklif önce G'ye gider
    const offer = await tdb.pool.withPlatform((db) => offerNext(db, slot));
    expect(offer!.teacherId).toBe(teacherG);

    const declined = await declineOffer(tdb.pool, offer!.token);
    expect(declined).toEqual({ ok: true, nextTeacherId: teacherF });
    // Aynı token'la ikinci red: teklif çoktan sonuçlandı
    expect(await declineOffer(tdb.pool, offer!.token)).toEqual({
      ok: false,
      reason: "expired_or_taken",
    });

    expect(await assignmentFor(slot.id)).toEqual([
      { teacher_id: teacherG, status: "declined" },
      { teacher_id: teacherF, status: "offered" },
    ]);
  });

  it("expireStaleOffers: süresi geçen teklif expire olur ve sıradaki adaya geçilir", async () => {
    const day = futureDate(NY, 10);
    const slot = await insertSlot({
      poolId,
      planId,
      occurrenceKey: day.dateISO,
      startsAt: nyInstant(day.dateISO, 10),
    });

    // Teklifi geçmiş 'now' ile aç → offer_expires_at çoktan geçmiş
    const stale = await tdb.pool.withPlatform((db) =>
      offerNext(db, slot, { now: new Date(Date.now() - 60 * 60_000) }),
    );
    expect(stale!.teacherId).toBe(teacherG); // G hâlâ 0 onaylı

    const swept = await expireStaleOffers(tdb.pool);
    expect(swept).toEqual({ expired: 1, reoffered: 1 });

    // G expired → aynı slota tekrar teklif almaz; sıradaki F offered
    expect(await assignmentFor(slot.id)).toEqual([
      { teacher_id: teacherG, status: "expired" },
      { teacher_id: teacherF, status: "offered" },
    ]);

    // Süresi dolmuş token'la kabul denemesi reddedilir
    expect(await acceptOffer(tdb.pool, stale!.token)).toEqual({
      ok: false,
      reason: "expired_or_taken",
    });
  });
});

// G0 kapısı (0015): reşit-olmayan içeren okulda (school.minors, varsayılan TRUE) yalnız
// kimlik+ülke-sabıka evrakları 'verified' eğitmen (teacher.safeguarding_ready) aday olur.
describe("G0 safeguarding kapısı", () => {
  it("minors okulda evraksız eğitmen aday değil; evraklar verified olunca trigger'la aday olur", async () => {
    const poolId = await seedPool(tdb.pool, "g0_pool_1");
    const day = futureDate(NY, 4);
    const planId = await makePlan(poolId, day.weekday, day.dateISO);
    const slot = await insertSlot({
      poolId,
      planId,
      occurrenceKey: day.dateISO,
      startsAt: nyInstant(day.dateISO, 10),
    });

    const teacherId = await seedTeacher(tdb.pool, {
      email: "g0.nodocs@example.com",
      timezone: NY,
      poolId,
      availability: allWeekAvailability(),
      withoutSafeguardingDocs: true,
    });

    // Evrak yok → müsait ve dispatch_ready olmasına rağmen aday DEĞİL
    expect(await tdb.pool.withPlatform((db) => findCandidates(db, slot))).toEqual([]);

    // Yalnız kimlik verified → hâlâ aday değil (iki evrak birden şart)
    await tdb.pool.withPlatform((db) =>
      db.query(
        `INSERT INTO teacher_document (teacher_id, kind, status)
         VALUES ($1, 'id_verification', 'verified')`,
        [teacherId],
      ),
    );
    expect(await tdb.pool.withPlatform((db) => findCandidates(db, slot))).toEqual([]);

    // Ülke sabıka da verified → trigger safeguarding_ready'yi açar, eğitmen aday
    await tdb.pool.withPlatform((db) =>
      db.query(
        `INSERT INTO teacher_document (teacher_id, kind, status)
         VALUES ($1, 'country_clearance', 'verified')`,
        [teacherId],
      ),
    );
    const flag = await tdb.pool.withPlatform((db) =>
      db.query<{ safeguarding_ready: boolean }>(
        "SELECT safeguarding_ready FROM teacher WHERE id = $1",
        [teacherId],
      ),
    );
    expect(flag.rows[0]!.safeguarding_ready).toBe(true);
    const candidates = await tdb.pool.withPlatform((db) => findCandidates(db, slot));
    expect(candidates.map((c) => c.teacherId)).toEqual([teacherId]);

    // Evrak 'expired'a düşerse kapı geri kapanır (trigger UPDATE'te de koşar)
    await tdb.pool.withPlatform((db) =>
      db.query(
        `UPDATE teacher_document SET status = 'expired'
          WHERE teacher_id = $1 AND kind = 'country_clearance'`,
        [teacherId],
      ),
    );
    expect(await tdb.pool.withPlatform((db) => findCandidates(db, slot))).toEqual([]);
  });

  it("yalnız-yetişkin okulda (minors=false) evraksız eğitmen aday olabilir", async () => {
    const adult = await seedSchool(tdb.pool, "G0 Yetişkin Okul");
    await tdb.pool.withPlatform((db) =>
      db.query("UPDATE school SET minors = false WHERE id = $1", [adult.schoolId]),
    );
    const poolId = await seedPool(tdb.pool, "g0_pool_2");
    const day = futureDate(NY, 5);
    const planId = await seedPlan(tdb.pool, {
      schoolId: adult.schoolId,
      classGroupId: adult.classGroupId,
      poolId,
      weekday: day.weekday,
      startMinute: 600,
      durationMin: 60,
      schoolTz: NY,
      priceCents: 10_000,
      teacherPayCents: 6_000,
      startDate: day.dateISO,
      weeks: 1,
    });
    const startsAt = nyInstant(day.dateISO, 10);
    const slot = await tdb.pool.withPlatform(async (db) => {
      const res = await db.query<{ id: string }>(
        `INSERT INTO booking_slot
           (school_id, plan_id, class_group_id, pool_id, occurrence_key,
            starts_at, ends_at, price_cents, teacher_pay_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 10000, 6000)
         RETURNING id`,
        [
          adult.schoolId,
          planId,
          adult.classGroupId,
          poolId,
          day.dateISO,
          startsAt,
          new Date(startsAt.getTime() + 60 * 60_000),
        ],
      );
      return (await getSlot(db, res.rows[0]!.id))!;
    });

    const teacherId = await seedTeacher(tdb.pool, {
      email: "g0.adult@example.com",
      timezone: NY,
      poolId,
      availability: allWeekAvailability(),
      withoutSafeguardingDocs: true,
    });
    const candidates = await tdb.pool.withPlatform((db) => findCandidates(db, slot));
    expect(candidates.map((c) => c.teacherId)).toEqual([teacherId]);
  });
});
