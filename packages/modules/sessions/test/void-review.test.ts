// P1-B (denetim-3-rol-tur2): reddedilen settle'ın para çözümü (voidRejectedSession).
// Reddedilen ders (ended + review_rejected_at + slot scheduled + hold açık) admin kararıyla
// void edilir: hold OKULA TAM iade, slot 'voided_review', eğitmene 'teacher_payment_adjusted'
// (kind='review_rejected') outbox kaydı. İdempotent: ikinci çağrı para OYNATMAZ.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { voidRejectedSession } from "../src/index.js";
import {
  assertInvariantsClean,
  balance,
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

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

interface Ctx {
  seed: SeedSchool;
  poolId: string;
  planId: string;
  teacherId: string;
}

async function seedCtx(tag: string): Promise<Ctx> {
  const seed = await seedSchool(tdb.pool, `Void Okul ${tag}`);
  const poolId = await seedPool(tdb.pool, `void_pool_${tag}`);
  const teacherId = await seedTeacher(tdb.pool, `void.${tag}@example.com`);
  const planId = await seedPlan(tdb.pool, seed, poolId);
  await topupSchool(tdb.pool, seed.schoolId, 4_000);
  return { seed, poolId, planId, teacherId };
}

/** Reddedilmiş-settle durumunu kurar: hold'lu slot + ended session + review_rejected_at.
 * (Bu, admin.rejectSettle sonrası oluşan durumun aynısı.) */
async function seedRejectedSession(ctx: Ctx, occurrenceKey: string): Promise<string> {
  const startsAt = minutesFromNow(-120);
  const endsAt = new Date(startsAt.getTime() + 45 * 60_000);
  const slotId = await createHeldSlot(tdb.pool, {
    seed: ctx.seed,
    planId: ctx.planId,
    poolId: ctx.poolId,
    occurrenceKey,
    startsAt,
    endsAt,
    teacherId: ctx.teacherId,
  });
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO class_session
         (slot_id, school_id, teacher_id, class_group_id, status,
          started_at, ended_at, dosage_min, review_required, review_reason, review_rejected_at)
       VALUES ($1, $2, $3, $4, 'ended', $5, $6, 2, true, 'kısa ders', now())
       RETURNING id`,
      [
        slotId,
        ctx.seed.schoolId,
        ctx.teacherId,
        ctx.seed.classGroupId,
        startsAt,
        new Date(startsAt.getTime() + 2 * 60_000),
      ],
    );
    return res.rows[0]!.id;
  });
}

async function slotStatus(sessionId: string): Promise<string> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ status: string }>(
      `SELECT bs.status FROM booking_slot bs
         JOIN class_session cs ON cs.slot_id = bs.id WHERE cs.id = $1`,
      [sessionId],
    );
    return res.rows[0]!.status;
  });
}

test("void: hold OKULA tam iade, slot voided_review, eğitmene bildirim; ikinci çağrı para OYNATMAZ", async () => {
  const ctx = await seedCtx("v1");
  const sessionId = await seedRejectedSession(ctx, "2026-04-01");

  // Başlangıç: hold 4000 kilitli, kasa 0
  expect(await balance(tdb.pool, "school", ctx.seed.schoolId, "wallet_hold")).toBe(4_000);
  expect(await balance(tdb.pool, "school", ctx.seed.schoolId, "school_cash")).toBe(0);

  const result = await voidRejectedSession(tdb.pool, { sessionId });
  expect(result.refundCents).toBe(4_000);
  expect(result.txnId).toBeTruthy();

  // Hold okula TAM iade edildi
  expect(await balance(tdb.pool, "school", ctx.seed.schoolId, "wallet_hold")).toBe(0);
  expect(await balance(tdb.pool, "school", ctx.seed.schoolId, "school_cash")).toBe(4_000);
  // Eğitmene ödeme YOK
  expect(await balance(tdb.pool, "teacher", ctx.teacherId, "teacher_payable")).toBe(0);
  expect(await slotStatus(sessionId)).toBe("voided_review");

  await tdb.pool.withPlatform(async (db) => {
    const audit = await db.query(
      "SELECT 1 FROM audit_log WHERE action = 'session_voided_review' AND entity_id = $1",
      [sessionId],
    );
    expect(audit.rowCount).toBe(1);
    const outbox = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM notification_outbox
        WHERE template = 'teacher_payment_adjusted' AND recipient_email = 'void.v1@example.com'`,
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]!.payload["kind"]).toBe("review_rejected");
  });
  await assertInvariantsClean(tdb.pool);

  // İkinci void: slot artık 'scheduled' değil → hata, para OYNAMAZ
  await expect(voidRejectedSession(tdb.pool, { sessionId })).rejects.toThrow(
    /slot 'scheduled' değil/,
  );
  expect(await balance(tdb.pool, "school", ctx.seed.schoolId, "school_cash")).toBe(4_000);
  await assertInvariantsClean(tdb.pool);
});

test("guard: review_rejected_at boş session void edilemez (settle reddi yok)", async () => {
  const ctx = await seedCtx("v2");
  const startsAt = minutesFromNow(-120);
  const endsAt = new Date(startsAt.getTime() + 45 * 60_000);
  const slotId = await createHeldSlot(tdb.pool, {
    seed: ctx.seed,
    planId: ctx.planId,
    poolId: ctx.poolId,
    occurrenceKey: "2026-04-02",
    startsAt,
    endsAt,
    teacherId: ctx.teacherId,
  });
  // review_rejected_at YOK: henüz reddedilmemiş, yalnızca review'da bekleyen ders
  const sessionId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO class_session
         (slot_id, school_id, teacher_id, class_group_id, status,
          started_at, ended_at, dosage_min, review_required)
       VALUES ($1, $2, $3, $4, 'ended', $5, $6, 2, true)
       RETURNING id`,
      [
        slotId,
        ctx.seed.schoolId,
        ctx.teacherId,
        ctx.seed.classGroupId,
        startsAt,
        new Date(startsAt.getTime() + 2 * 60_000),
      ],
    );
    return res.rows[0]!.id;
  });

  await expect(voidRejectedSession(tdb.pool, { sessionId })).rejects.toThrow(
    /settle reddi yok/,
  );
  // Para dokunulmadı — hold hâlâ kilitli
  expect(await balance(tdb.pool, "school", ctx.seed.schoolId, "wallet_hold")).toBe(4_000);
  await assertInvariantsClean(tdb.pool);
});
