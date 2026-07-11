// Outbox yazıcıları: teklif açılınca eğitmene 'teacher_offer', SLA eskalasyonunda okulun
// owner/admin kullanıcılarına 'school_sla_escalated' kaydı — domain yazımıyla AYNI transaction'da.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { getSlot, materializePlans, offerNext, sweepBackfill } from "../src/index.js";
import {
  allWeekAvailability,
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

interface OutboxRow {
  recipient_email: string;
  template: string;
  status: string;
  payload: Record<string, unknown>;
}

async function outboxRows(template: string): Promise<OutboxRow[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<OutboxRow>(
      `SELECT recipient_email, template, status, payload
         FROM notification_outbox WHERE template = $1 ORDER BY recipient_email`,
      [template],
    );
    return res.rows;
  });
}

/** Okul + havuz + tek slotluk plan kurar, materialize eder, planı kapatır → slotId. */
async function scenario(input: {
  name: string;
  priceCents: number;
  daysAhead: number;
}): Promise<{ schoolId: string; poolId: string; slotId: string }> {
  const { schoolId, classGroupId } = await seedSchool(tdb.pool, input.name);
  const poolId = await seedPool(tdb.pool, `pool_${input.name}`);
  await topupSchool(tdb.pool, schoolId, input.priceCents);
  const start = futureDate(TZ, input.daysAhead);
  const planId = await seedPlan(tdb.pool, {
    schoolId,
    classGroupId,
    poolId,
    weekday: start.weekday,
    startMinute: 720,
    durationMin: 60,
    schoolTz: TZ,
    priceCents: input.priceCents,
    teacherPayCents: 4_000,
    startDate: start.dateISO,
    weeks: 1,
  });
  const result = await materializePlans(tdb.pool);
  expect(result.created).toBe(1);
  await completePlan(tdb.pool, planId);
  const slotId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>("SELECT id FROM booking_slot WHERE plan_id = $1", [
      planId,
    ]);
    return res.rows[0]!.id;
  });
  return { schoolId, poolId, slotId };
}

/** Okula app_user + school_user üyeliği açar. */
async function seedSchoolUser(schoolId: string, email: string, role: string): Promise<void> {
  await tdb.pool.withPlatform(async (db) => {
    const user = await db.query<{ id: string }>(
      "INSERT INTO app_user (email, name) VALUES ($1, 'Okul Kullanıcısı') RETURNING id",
      [email],
    );
    await db.query("INSERT INTO school_user (school_id, user_id, role) VALUES ($1, $2, $3)", [
      schoolId,
      user.rows[0]!.id,
      role,
    ]);
  });
}

describe("notification outbox", () => {
  it("offerNext: teklifle AYNI transaction'da eğitmene 'teacher_offer' outbox kaydı düşer", async () => {
    const s = await scenario({ name: "ntf_offer", priceCents: 8_000, daysAhead: 9 });
    await seedTeacher(tdb.pool, {
      email: "ntf.teacher@example.com",
      timezone: TZ,
      poolId: s.poolId,
      availability: allWeekAvailability(),
    });

    const offer = await tdb.pool.withPlatform(async (db) => {
      const slot = await getSlot(db, s.slotId);
      if (!slot) throw new Error("slot yok");
      return offerNext(db, slot);
    });
    expect(offer).not.toBeNull();

    const rows = await outboxRows("teacher_offer");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.recipient_email).toBe("ntf.teacher@example.com");
    expect(row.status).toBe("pending");
    // Ham token outbox payload'ında (dispatcher URL'i BASE_URL ile kurar)
    expect(row.payload["token"]).toBe(offer!.token);
    expect(row.payload["durationMin"]).toBe(60);
    expect(row.payload["teacherTimezone"]).toBe(TZ);
    expect(row.payload["poolName"]).toBe("pool_ntf_offer");
    expect(row.payload["schoolName"]).toBe("ntf_offer");
    const startsAt = await tdb.pool.withPlatform(async (db) => (await getSlot(db, s.slotId))!.starts_at);
    expect(row.payload["slotStartsAt"]).toBe(startsAt.toISOString());
  });

  it("escalate: owner ve admin'e 'school_sla_escalated' düşer (refundedCents doğru); finance almaz", async () => {
    // Havuzda eğitmen yok → slot atanmadan SLA penceresine girer
    const s = await scenario({ name: "ntf_escalate", priceCents: 7_500, daysAhead: 8 });
    await seedSchoolUser(s.schoolId, "ntf.owner@okul.com", "owner");
    await seedSchoolUser(s.schoolId, "ntf.admin@okul.com", "admin");
    await seedSchoolUser(s.schoolId, "ntf.finance@okul.com", "finance");

    const startsAt = await tdb.pool.withPlatform(
      async (db) => (await getSlot(db, s.slotId))!.starts_at,
    );
    const result = await sweepBackfill(tdb.pool, {
      now: new Date(startsAt.getTime() - 60 * 60_000), // derse 1 saat kala → escalate
    });
    expect(result).toEqual({ offered: 0, reoffered: 0, escalated: 1 });

    const rows = await outboxRows("school_sla_escalated");
    expect(rows.map((r) => r.recipient_email)).toEqual(["ntf.admin@okul.com", "ntf.owner@okul.com"]);
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.payload["schoolName"]).toBe("ntf_escalate");
      expect(row.payload["className"]).toBe("5-A");
      expect(row.payload["slotStartsAt"]).toBe(startsAt.toISOString());
      // SLA sözü: hold tam iade edildi → refundedCents slot fiyatı
      expect(row.payload["refundedCents"]).toBe(7_500);
    }
  });
});
