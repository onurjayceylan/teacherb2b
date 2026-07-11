// Tam zincir: elle kurulan slot+hold+confirmed atama → ensureSession → start →
// yoklama → end → settle (hold bölüşümü) → replay → dispute refund (ters kayıt + iade).
// Dispatch'in materializer'ı bilerek kullanılmaz (boundary) — bkz. helpers.createHeldSlot.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import {
  endSession,
  ensureSessionForSlot,
  markAttendance,
  openDispute,
  recordEvent,
  resolveDispute,
  settleSession,
  startSession,
} from "../src/index.js";
import {
  assertInvariantsClean,
  balance,
  createHeldSlot,
  entrySum,
  minutesFromNow,
  seedPlan,
  seedPool,
  seedSchool,
  seedStudents,
  seedTeacher,
  topupSchool,
  type SeedSchool,
} from "./helpers.js";

let tdb: TestDb;

// Test 1'de kurulan zincirin durumu — dispute testleri aynı oturum üstünden devam eder.
let seed1: SeedSchool;
let teacher1: string;
let slotA: string;
let sessionA: string;
let settleTxnId: string;

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

test("tam zincir: hold → ensure → start → yoklama → end → settle + replay", async () => {
  seed1 = await seedSchool(tdb.pool, "Sessions Okul 1");
  const poolId = await seedPool(tdb.pool, "sessions_pool_1");
  const students = await seedStudents(tdb.pool, seed1, ["Ali", "Ayşe", "Deniz"]);
  teacher1 = await seedTeacher(tdb.pool, "sessions.t1@example.com");
  const planId = await seedPlan(tdb.pool, seed1, poolId);
  await topupSchool(tdb.pool, seed1.schoolId, 4_000); // tam 1 ders

  // Dispatch akışının bıraktığı durum: hold alınmış, atama confirmed.
  const startsA = minutesFromNow(-120);
  const endsA = minutesFromNow(-60);
  slotA = await createHeldSlot(tdb.pool, {
    seed: seed1,
    planId,
    poolId,
    occurrenceKey: "2026-02-02",
    startsAt: startsA,
    endsAt: endsA,
    teacherId: teacher1,
  });
  expect(await balance(tdb.pool, "school", seed1.schoolId, "school_cash")).toBe(0);
  expect(await balance(tdb.pool, "school", seed1.schoolId, "wallet_hold")).toBe(4_000);

  // ensure idempotent: ikinci çağrı aynı oturumu döner
  const ensured = await tdb.pool.withPlatform((db) => ensureSessionForSlot(db, slotA));
  expect(ensured.created).toBe(true);
  sessionA = ensured.sessionId;
  const again = await tdb.pool.withPlatform((db) => ensureSessionForSlot(db, slotA));
  expect(again).toEqual({ sessionId: sessionA, created: false });

  // start idempotent — slot penceresi içinde (tam slot başlangıcında) başlatılır
  expect(
    await tdb.pool.withPlatform((db) => startSession(db, sessionA, { now: startsA })),
  ).toEqual({
    alreadyStarted: false,
  });
  expect(
    await tdb.pool.withPlatform((db) => startSession(db, sessionA, { now: startsA })),
  ).toEqual({
    alreadyStarted: true,
  });

  // serbest olay + yoklama (3 present işaretlenir, biri absent'e düzeltilir → upsert)
  await tdb.pool.withPlatform((db) =>
    recordEvent(db, { sessionId: sessionA, kind: "note", role: "system", meta: { via: "test" } }),
  );
  await tdb.pool.withPlatform((db) =>
    markAttendance(
      db,
      sessionA,
      students.map((studentId) => ({ studentId, present: true })),
    ),
  );
  await tdb.pool.withPlatform((db) =>
    markAttendance(db, sessionA, [{ studentId: students[2]!, present: false }]),
  );
  const attendance = await tdb.pool.withPlatform((db) =>
    db.query<{ present: boolean }>(
      "SELECT present FROM session_attendance WHERE session_id = $1 ORDER BY marked_at",
      [sessionA],
    ),
  );
  expect(attendance.rows.filter((r) => r.present).length).toBe(2);
  expect(attendance.rows.filter((r) => !r.present).length).toBe(1);

  // end: 45 dakikalık dosaj (now enjekte edilir — start + 45 dk)
  const ended = await tdb.pool.withPlatform((db) =>
    endSession(db, sessionA, { now: new Date(startsA.getTime() + 45 * 60_000) }),
  );
  expect(ended.dosageMin).toBe(45);

  // settle: hold bölüşülür — school_cash'e DOKUNULMAZ
  // (45 dk dosaj planlanan 60 dk'nın yarısından fazla → review guard'ına takılmaz)
  const settled = await settleSession(tdb.pool, sessionA);
  expect(settled.alreadySettled).toBe(false);
  if (!settled.txnId) throw new Error("settle sonucu txnId bekleniyordu");
  settleTxnId = settled.txnId;

  expect(await balance(tdb.pool, "school", seed1.schoolId, "wallet_hold")).toBe(0); // slot öncesine döndü
  expect(await balance(tdb.pool, "school", seed1.schoolId, "school_cash")).toBe(0); // DEĞİŞMEDİ
  expect(await balance(tdb.pool, "teacher", teacher1, "teacher_payable")).toBe(1_600);
  expect(await entrySum(tdb.pool, "platform", null, "platform_revenue")).toBe(2_400);
  await assertInvariantsClean(tdb.pool);

  const rows = await tdb.pool.withPlatform(async (db) => ({
    session: (
      await db.query<{ status: string; settle_txn_id: string | null }>(
        "SELECT status, settle_txn_id FROM class_session WHERE id = $1",
        [sessionA],
      )
    ).rows[0],
    slot: (
      await db.query<{ status: string }>("SELECT status FROM booking_slot WHERE id = $1", [slotA])
    ).rows[0],
    eventKinds: (
      await db.query<{ kind: string }>(
        "SELECT kind FROM session_event WHERE session_id = $1 ORDER BY id",
        [sessionA],
      )
    ).rows.map((r) => r.kind),
    audits: (
      await db.query(
        "SELECT 1 FROM audit_log WHERE action = 'session_settled' AND entity_id = $1",
        [sessionA],
      )
    ).rowCount,
  }));
  expect(rows.session).toEqual({ status: "settled", settle_txn_id: settleTxnId });
  expect(rows.slot?.status).toBe("completed");
  expect(rows.eventKinds).toEqual(["check_in", "note", "check_out"]);
  expect(rows.audits).toBe(1);

  // replay: yapısal no-op — aynı txn döner, hiçbir bakiye kımıldamaz
  expect(await settleSession(tdb.pool, sessionA)).toEqual({
    alreadySettled: true,
    txnId: settleTxnId,
  });
  expect(await balance(tdb.pool, "school", seed1.schoolId, "wallet_hold")).toBe(0);
  expect(await balance(tdb.pool, "teacher", teacher1, "teacher_payable")).toBe(1_600);
  expect(await entrySum(tdb.pool, "platform", null, "platform_revenue")).toBe(2_400);
  await assertInvariantsClean(tdb.pool);
});

test("dispute refund: settle ters kayıtla geri sarılır, hold okula iade edilir", async () => {
  const disputeId = await tdb.pool.withPlatform((db) =>
    openDispute(db, {
      sessionId: sessionA,
      schoolId: seed1.schoolId,
      reason: "eğitmen derse 20 dk geç geldi",
    }),
  );

  const result = await resolveDispute(tdb.pool, {
    disputeId,
    decision: "refund",
    note: "kayıtlar okulu doğruluyor — tam iade",
  });
  if (result.status !== "resolved_refund") throw new Error("refund bekleniyordu");

  // okul parasını geri aldı; eğitmen alacağı ve platform geliri sıfıra döndü
  expect(await balance(tdb.pool, "school", seed1.schoolId, "school_cash")).toBe(4_000);
  expect(await balance(tdb.pool, "school", seed1.schoolId, "wallet_hold")).toBe(0);
  expect(await balance(tdb.pool, "teacher", teacher1, "teacher_payable")).toBe(0);
  expect(await entrySum(tdb.pool, "platform", null, "platform_revenue")).toBe(0);
  await assertInvariantsClean(tdb.pool);

  const rows = await tdb.pool.withPlatform(async (db) => ({
    dispute: (
      await db.query<{ status: string; refund_txn_id: string | null; resolved: boolean }>(
        `SELECT status, refund_txn_id, resolved_at IS NOT NULL AS resolved
           FROM session_dispute WHERE id = $1`,
        [disputeId],
      )
    ).rows[0],
    refundTxn: (
      await db.query<{ reverses_txn_id: string | null; reason_code: string | null }>(
        "SELECT reverses_txn_id, reason_code FROM ledger_transaction WHERE id = $1",
        [result.refundTxnId],
      )
    ).rows[0],
  }));
  expect(rows.dispute).toEqual({
    status: "resolved_refund",
    refund_txn_id: result.refundTxnId,
    resolved: true,
  });
  expect(rows.refundTxn).toEqual({ reverses_txn_id: settleTxnId, reason_code: "dispute" });

  // karar verilmiş dispute'a ikinci karar yok
  await expect(
    resolveDispute(tdb.pool, { disputeId, decision: "refund", note: "tekrar" }),
  ).rejects.toThrow(/açık değil/);
});

test("dispute rejected: yalnız durum + not değişir, para oynamaz", async () => {
  const disputeId = await tdb.pool.withPlatform((db) =>
    openDispute(db, { sessionId: sessionA, schoolId: seed1.schoolId, reason: "ikinci itiraz" }),
  );
  expect(
    await resolveDispute(tdb.pool, { disputeId, decision: "rejected", note: "kayıtlar temiz" }),
  ).toEqual({ status: "rejected" });

  expect(await balance(tdb.pool, "school", seed1.schoolId, "school_cash")).toBe(4_000);
  const row = await tdb.pool.withPlatform((db) =>
    db.query<{ status: string; resolution_note: string | null }>(
      "SELECT status, resolution_note FROM session_dispute WHERE id = $1",
      [disputeId],
    ),
  );
  expect(row.rows[0]).toEqual({ status: "rejected", resolution_note: "kayıtlar temiz" });
});

test("hatalar: ended olmayan settle, settled olmayan dispute, atamasız/scheduled olmayan slot", async () => {
  const seed2 = await seedSchool(tdb.pool, "Sessions Okul 2");
  const poolId = await seedPool(tdb.pool, "sessions_pool_2");
  const teacher2 = await seedTeacher(tdb.pool, "sessions.t2@example.com");
  const planId = await seedPlan(tdb.pool, seed2, poolId);
  await topupSchool(tdb.pool, seed2.schoolId, 4_000);

  const startsB = minutesFromNow(-240);
  const slotB = await createHeldSlot(tdb.pool, {
    seed: seed2,
    planId,
    poolId,
    occurrenceKey: "2026-02-03",
    startsAt: startsB,
    endsAt: minutesFromNow(-180),
    teacherId: teacher2,
  });
  const { sessionId: sessionB } = await tdb.pool.withPlatform((db) =>
    ensureSessionForSlot(db, slotB),
  );

  // created durumunda settle → hata; started durumunda da → hata
  await expect(settleSession(tdb.pool, sessionB)).rejects.toThrow(/'ended'/);
  await tdb.pool.withPlatform((db) => startSession(db, sessionB, { now: startsB }));
  await expect(settleSession(tdb.pool, sessionB)).rejects.toThrow(/'ended'/);

  // settle edilmemiş oturuma dispute açılamaz
  await expect(
    tdb.pool.withPlatform((db) =>
      openDispute(db, { sessionId: sessionB, schoolId: seed2.schoolId, reason: "erken itiraz" }),
    ),
  ).rejects.toThrow(/settled/);

  // confirmed ataması olmayan slot oturum açamaz
  const slotC = await createHeldSlot(tdb.pool, {
    seed: seed2,
    planId,
    poolId,
    occurrenceKey: "2026-02-04",
    startsAt: minutesFromNow(-360),
    endsAt: minutesFromNow(-300),
    skipHold: true,
  });
  await expect(
    tdb.pool.withPlatform((db) => ensureSessionForSlot(db, slotC)),
  ).rejects.toThrow(/confirmed atama yok/);

  // scheduled olmayan slot da reddedilir (INSERT anında iptal statüsü — trigger UPDATE'te)
  const slotD = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO booking_slot
         (school_id, plan_id, class_group_id, pool_id, occurrence_key,
          starts_at, ends_at, price_cents, teacher_pay_cents, status)
       VALUES ($1, $2, $3, $4, '2026-02-05', $5, $6, 4000, 1600, 'cancelled_school_early')
       RETURNING id`,
      [
        seed2.schoolId,
        planId,
        seed2.classGroupId,
        poolId,
        minutesFromNow(-480),
        minutesFromNow(-420),
      ],
    );
    return res.rows[0]!.id;
  });
  await expect(
    tdb.pool.withPlatform((db) => ensureSessionForSlot(db, slotD)),
  ).rejects.toThrow(/'scheduled' değil/);

  await assertInvariantsClean(tdb.pool);
});
