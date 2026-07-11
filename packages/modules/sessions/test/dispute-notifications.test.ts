// resolveDispute bildirimi: karar (refund/rejected) okulun owner/admin kullanıcılarına
// 'school_dispute_resolved' outbox kaydı olarak kararla AYNI transaction'da düşer;
// finance rolü almaz (school_sla_escalated alıcı deseni).
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import {
  endSession,
  ensureSessionForSlot,
  openDispute,
  resolveDispute,
  settleSession,
  startSession,
} from "../src/index.js";
import {
  assertInvariantsClean,
  createHeldSlot,
  minutesFromNow,
  seedPlan,
  seedPool,
  seedSchool,
  seedTeacher,
  topupSchool,
  type SeedSchool,
} from "./helpers.js";

let tdb: TestDb;
let seed: SeedSchool;
let slotStartsAt: Date;
let sessionId: string;

beforeAll(async () => {
  tdb = await createTestDb();
  seed = await seedSchool(tdb.pool, "Dispute Bildirim Okul");
  const poolId = await seedPool(tdb.pool, "dispute_ntf_pool");
  const teacherId = await seedTeacher(tdb.pool, "dispute.ntf.t@example.com");
  const planId = await seedPlan(tdb.pool, seed, poolId);
  await topupSchool(tdb.pool, seed.schoolId, 4_000);

  // Okul üyeleri: owner + admin bildirim alır, finance almaz
  await tdb.pool.withPlatform(async (db) => {
    for (const [email, role] of [
      ["dispute.owner@okul.com", "owner"],
      ["dispute.admin@okul.com", "admin"],
      ["dispute.finance@okul.com", "finance"],
    ] as const) {
      const user = await db.query<{ id: string }>(
        "INSERT INTO app_user (email, name) VALUES ($1, 'Okul Kullanıcısı') RETURNING id",
        [email],
      );
      await db.query("INSERT INTO school_user (school_id, user_id, role) VALUES ($1, $2, $3)", [
        seed.schoolId,
        user.rows[0]!.id,
        role,
      ]);
    }
  });

  // Settled oturum zinciri: hold'lu slot + confirmed atama → ensure → start → end → settle
  slotStartsAt = minutesFromNow(-120);
  const endsAt = minutesFromNow(-60);
  const slotId = await createHeldSlot(tdb.pool, {
    seed,
    planId,
    poolId,
    occurrenceKey: "2026-03-02",
    startsAt: slotStartsAt,
    endsAt,
    teacherId,
  });
  const ensured = await tdb.pool.withPlatform((db) => ensureSessionForSlot(db, slotId));
  sessionId = ensured.sessionId;
  await tdb.pool.withPlatform((db) => startSession(db, sessionId, { now: slotStartsAt }));
  await tdb.pool.withPlatform((db) =>
    endSession(db, sessionId, { now: new Date(slotStartsAt.getTime() + 45 * 60_000) }),
  );
  const settled = await settleSession(tdb.pool, sessionId);
  expect(settled.alreadySettled).toBe(false);
});

afterAll(async () => {
  await tdb.drop();
});

async function resolvedNotices(): Promise<
  { recipient_email: string; status: string; payload: Record<string, unknown> }[]
> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{
      recipient_email: string;
      status: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT recipient_email, status, payload
         FROM notification_outbox
        WHERE template = 'school_dispute_resolved'
        ORDER BY created_at, recipient_email`,
    );
    return res.rows;
  });
}

/** P1-A: eğitmene giden kesinti bildirimleri (clawback şeffaflığı). */
async function teacherAdjustedNotices(): Promise<
  { recipient_email: string; payload: Record<string, unknown> }[]
> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ recipient_email: string; payload: Record<string, unknown> }>(
      `SELECT recipient_email, payload FROM notification_outbox
        WHERE template = 'teacher_payment_adjusted' ORDER BY created_at`,
    );
    return res.rows;
  });
}

test("refund kararı: owner+admin'e outcome='refunded' + slot tarihi düşer; finance almaz", async () => {
  const disputeId = await tdb.pool.withPlatform((db) =>
    openDispute(db, { sessionId, schoolId: seed.schoolId, reason: "eğitmen geç geldi" }),
  );
  const result = await resolveDispute(tdb.pool, {
    disputeId,
    decision: "refund",
    note: "kayıtlar okulu doğruluyor",
  });
  expect(result.status).toBe("resolved_refund");

  const rows = await resolvedNotices();
  expect(rows.map((r) => r.recipient_email)).toEqual([
    "dispute.admin@okul.com",
    "dispute.owner@okul.com",
  ]);
  for (const row of rows) {
    expect(row.status).toBe("pending");
    expect(row.payload).toMatchObject({
      outcome: "refunded",
      slotStartsAt: slotStartsAt.toISOString(),
      schoolName: "Dispute Bildirim Okul",
      refundedCents: 4_000,
    });
  }

  // P1-A: refund kararında eğitmene kesinti bildirimi (kind='dispute_refund', teacher_pay 1600)
  const adjusted = await teacherAdjustedNotices();
  expect(adjusted).toHaveLength(1);
  expect(adjusted[0]!.recipient_email).toBe("dispute.ntf.t@example.com");
  expect(adjusted[0]!.payload).toMatchObject({
    kind: "dispute_refund",
    amountCents: 1_600,
    lessonStartsAt: slotStartsAt.toISOString(),
  });
  await assertInvariantsClean(tdb.pool);
});

test("rejected kararı: outcome='released' düşer (refundedCents payload'da yok)", async () => {
  const disputeId = await tdb.pool.withPlatform((db) =>
    openDispute(db, { sessionId, schoolId: seed.schoolId, reason: "ikinci itiraz" }),
  );
  expect(
    await resolveDispute(tdb.pool, { disputeId, decision: "rejected", note: "kayıtlar temiz" }),
  ).toEqual({ status: "rejected" });

  const rows = await resolvedNotices();
  expect(rows).toHaveLength(4); // önceki 2 (refund) + yeni 2 (released)
  const released = rows.slice(2);
  expect(released.map((r) => r.recipient_email)).toEqual([
    "dispute.admin@okul.com",
    "dispute.owner@okul.com",
  ]);
  for (const row of released) {
    expect(row.payload["outcome"]).toBe("released");
    expect(row.payload["slotStartsAt"]).toBe(slotStartsAt.toISOString());
    expect(row.payload["refundedCents"]).toBeUndefined();
  }

  // P1-A: reddedilen itiraz eğitmenden para almaz → yeni clawback bildirimi YOK (hâlâ 1)
  expect(await teacherAdjustedNotices()).toHaveLength(1);
});
