// P0 para-güven düzeltmesi: ders zaman-penceresi (startSession) + settle insan-onayı.
// - start: slot.starts_at - 15 dk'dan önce ve slot.ends_at + 2 saatten sonra REDDEDİLİR.
// - settle: kısa ders (dosaj < planlanan/2) ya da erken başlatma → PARA HAREKETİ YOK,
//   review_required=true + audit; force:true (admin onayı) normal settle eder.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { endSession, ensureSessionForSlot, settleSession, startSession } from "../src/index.js";
import {
  assertInvariantsClean,
  balance,
  createHeldSlot,
  entrySum,
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

/** Her test kendi okul/havuz/plan/eğitmen dörtlüsüyle çalışır — bakiyeler karışmaz. */
async function seedCtx(tag: string): Promise<Ctx> {
  const seed = await seedSchool(tdb.pool, `Window Okul ${tag}`);
  const poolId = await seedPool(tdb.pool, `window_pool_${tag}`);
  const teacherId = await seedTeacher(tdb.pool, `window.${tag}@example.com`);
  const planId = await seedPlan(tdb.pool, seed, poolId);
  await topupSchool(tdb.pool, seed.schoolId, 4_000);
  return { seed, poolId, planId, teacherId };
}

async function sessionRow(
  sessionId: string,
): Promise<{ status: string; review_required: boolean; review_reason: string | null }> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{
      status: string;
      review_required: boolean;
      review_reason: string | null;
    }>("SELECT status, review_required, review_reason FROM class_session WHERE id = $1", [
      sessionId,
    ]);
    return res.rows[0]!;
  });
}

async function reviewAuditCount(sessionId: string): Promise<number> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_log WHERE action = 'settle_review_required' AND entity_id = $1",
      [sessionId],
    );
    return Number(res.rows[0]?.n ?? 0);
  });
}

test("start penceresi: 15 dk'dan erken RED, pencere içi OK, bitiş+2 saat sonrası RED", async () => {
  const ctx = await seedCtx("t1");
  const startsAt = minutesFromNow(60); // ders 1 saat sonra
  const endsAt = new Date(startsAt.getTime() + 45 * 60_000);
  const slotId = await createHeldSlot(tdb.pool, {
    seed: ctx.seed,
    planId: ctx.planId,
    poolId: ctx.poolId,
    occurrenceKey: "2026-03-02",
    startsAt,
    endsAt,
    teacherId: ctx.teacherId,
  });
  const { sessionId } = await tdb.pool.withPlatform((db) => ensureSessionForSlot(db, slotId));

  // 16 dk önce: reddedilir + kalan süreyi söyler
  await expect(
    tdb.pool.withPlatform((db) =>
      startSession(db, sessionId, { now: new Date(startsAt.getTime() - 16 * 60_000) }),
    ),
  ).rejects.toThrow(/henüz başlatılamaz — başlangıca 16 dk var/);

  // bitiş + 2 saat + 1 dk: pencere geçti
  await expect(
    tdb.pool.withPlatform((db) =>
      startSession(db, sessionId, { now: new Date(endsAt.getTime() + 121 * 60_000) }),
    ),
  ).rejects.toThrow(/penceresi geçti — destek ile iletişime geçin/);

  // reddedilen denemeler durum bırakmaz: oturum hâlâ 'created'
  expect((await sessionRow(sessionId)).status).toBe("created");

  // 14 dk önce: 15 dk'lık pencere içinde → OK
  expect(
    await tdb.pool.withPlatform((db) =>
      startSession(db, sessionId, { now: new Date(startsAt.getTime() - 14 * 60_000) }),
    ),
  ).toEqual({ alreadyStarted: false });
  expect((await sessionRow(sessionId)).status).toBe("started");
});

test("kısa ders: settle PARA OYNATMAZ → reviewRequired; force:true admin onayıyla settle eder", async () => {
  const ctx = await seedCtx("t2");
  const startsAt = minutesFromNow(-120);
  const endsAt = new Date(startsAt.getTime() + 45 * 60_000); // 45 dk planlı
  const slotId = await createHeldSlot(tdb.pool, {
    seed: ctx.seed,
    planId: ctx.planId,
    poolId: ctx.poolId,
    occurrenceKey: "2026-03-03",
    startsAt,
    endsAt,
    teacherId: ctx.teacherId,
  });
  const { sessionId } = await tdb.pool.withPlatform((db) => ensureSessionForSlot(db, slotId));
  await tdb.pool.withPlatform((db) => startSession(db, sessionId, { now: startsAt }));
  // 2 dk sonra bitirilir → dosaj 2 < 45/2
  const ended = await tdb.pool.withPlatform((db) =>
    endSession(db, sessionId, { now: new Date(startsAt.getTime() + 2 * 60_000) }),
  );
  expect(ended.dosageMin).toBe(2);

  const before = {
    hold: await balance(tdb.pool, "school", ctx.seed.schoolId, "wallet_hold"),
    cash: await balance(tdb.pool, "school", ctx.seed.schoolId, "school_cash"),
  };
  expect(before.hold).toBe(4_000);

  // settle → review kuyruğu, PARA HAREKETİ YOK
  const result = await settleSession(tdb.pool, sessionId);
  expect(result.reviewRequired).toBe(true);
  expect(result.reason).toMatch(/kısa ders: 2 dk \(planlanan 45 dk\)/);
  expect(result.txnId).toBeUndefined();

  expect(await balance(tdb.pool, "school", ctx.seed.schoolId, "wallet_hold")).toBe(before.hold);
  expect(await balance(tdb.pool, "school", ctx.seed.schoolId, "school_cash")).toBe(before.cash);
  expect(await balance(tdb.pool, "teacher", ctx.teacherId, "teacher_payable")).toBe(0);

  const row = await sessionRow(sessionId);
  expect(row.status).toBe("ended"); // settled DEĞİL
  expect(row.review_required).toBe(true);
  expect(row.review_reason).toMatch(/kısa ders/);
  expect(await reviewAuditCount(sessionId)).toBe(1);

  // tekrar deneme: yine review, ama audit şişmez
  const again = await settleSession(tdb.pool, sessionId);
  expect(again.reviewRequired).toBe(true);
  expect(await reviewAuditCount(sessionId)).toBe(1);

  // admin onayı: force → normal settle + bayrak kapanır + bakiyeler doğru
  const forced = await settleSession(tdb.pool, sessionId, { force: true });
  expect(forced.alreadySettled).toBe(false);
  expect(forced.txnId).toBeTruthy();
  expect(await balance(tdb.pool, "school", ctx.seed.schoolId, "wallet_hold")).toBe(0);
  expect(await balance(tdb.pool, "school", ctx.seed.schoolId, "school_cash")).toBe(0);
  expect(await balance(tdb.pool, "teacher", ctx.teacherId, "teacher_payable")).toBe(1_600);
  expect(await entrySum(tdb.pool, "platform", null, "platform_revenue")).toBe(2_400);

  const settledRow = await sessionRow(sessionId);
  expect(settledRow.status).toBe("settled");
  expect(settledRow.review_required).toBe(false);
  await assertInvariantsClean(tdb.pool);
});

test("erken başlatma guard'ı (eski/yarış verisi): started_at pencere öncesiyse settle review'a düşer", async () => {
  const ctx = await seedCtx("t3");
  const startsAt = minutesFromNow(-180);
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
  const slotId = await createHeldSlot(tdb.pool, {
    seed: ctx.seed,
    planId: ctx.planId,
    poolId: ctx.poolId,
    occurrenceKey: "2026-03-04",
    startsAt,
    endsAt,
    teacherId: ctx.teacherId,
  });
  // startSession penceresi artık erken start'ı engelliyor — eski veri elle kurulur:
  // durum whitelist trigger'ı yalnız UPDATE'te, INSERT anında 'ended' kurulabilir.
  const sessionId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO class_session
         (slot_id, school_id, teacher_id, class_group_id, status, started_at, ended_at, dosage_min)
       VALUES ($1, $2, $3, $4, 'ended', $5, $6, 60)
       RETURNING id`,
      [
        slotId,
        ctx.seed.schoolId,
        ctx.teacherId,
        ctx.seed.classGroupId,
        new Date(startsAt.getTime() - 30 * 60_000), // planlanandan 30 dk önce başlamış
        new Date(startsAt.getTime() + 30 * 60_000),
      ],
    );
    return res.rows[0]!.id;
  });

  const result = await settleSession(tdb.pool, sessionId);
  expect(result.reviewRequired).toBe(true);
  expect(result.reason).toMatch(/erken başlatma/);
  // dosaj yeterli (60 dk) — yalnız erken başlatma nedeni yazılır
  expect(result.reason).not.toMatch(/kısa ders/);
  expect(await balance(tdb.pool, "school", ctx.seed.schoolId, "wallet_hold")).toBe(4_000);
  expect(await reviewAuditCount(sessionId)).toBe(1);

  // force ile insan onayı sonrası para doğru bölüşülür
  const forced = await settleSession(tdb.pool, sessionId, { force: true });
  expect(forced.txnId).toBeTruthy();
  expect(await balance(tdb.pool, "teacher", ctx.teacherId, "teacher_payable")).toBe(1_600);
  await assertInvariantsClean(tdb.pool);
});

test("normal süreli ders eskisi gibi OTOMATİK settle olur (force gerekmez)", async () => {
  const ctx = await seedCtx("t4");
  const startsAt = minutesFromNow(-90);
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
  const slotId = await createHeldSlot(tdb.pool, {
    seed: ctx.seed,
    planId: ctx.planId,
    poolId: ctx.poolId,
    occurrenceKey: "2026-03-05",
    startsAt,
    endsAt,
    teacherId: ctx.teacherId,
  });
  const { sessionId } = await tdb.pool.withPlatform((db) => ensureSessionForSlot(db, slotId));
  await tdb.pool.withPlatform((db) => startSession(db, sessionId, { now: startsAt }));
  await tdb.pool.withPlatform((db) =>
    endSession(db, sessionId, { now: new Date(startsAt.getTime() + 60 * 60_000) }),
  );

  const result = await settleSession(tdb.pool, sessionId);
  expect(result.alreadySettled).toBe(false);
  expect(result.txnId).toBeTruthy();
  expect(result.reviewRequired).toBeFalsy();
  expect(await balance(tdb.pool, "teacher", ctx.teacherId, "teacher_payable")).toBe(1_600);
  expect(await reviewAuditCount(sessionId)).toBe(0);

  const row = await sessionRow(sessionId);
  expect(row).toEqual({ status: "settled", review_required: false, review_reason: null });
  await assertInvariantsClean(tdb.pool);
});
