// Payout akışının uçtan uca testi. Seed zinciri ELLE kurulur (payouts modülü yalnız
// @teachernow/db'ye bağımlı — dispatch/sessions import edilmez): slot + hold +
// confirmed atama + class_session + settle txn'i, sonra batch yaşam döngüsü:
// createBatch → exportCsv → markSubmitted → importResults (paid/failed/replay).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type Db, type TestDb } from "@teachernow/db";
import {
  createBatch,
  exportBatchCsv,
  getTeacherPayouts,
  importResults,
  listOpen,
  markBatchSubmitted,
} from "../src/index.js";

let tdb: TestDb;
let schoolId: string;
let classGroupId: string;
let poolId: string;
let planId: string;

let readyTeacher: string; // 5 evrak verified → payout_ready=true
let heldTeacher: string; // evraksız → payout_ready=false (hard-gate)
let batch1Id: string;

const DOC_KINDS = ["contract", "id_verification", "country_clearance", "tax_form", "payout_method"];

/** N gün öncesinin YYYY-MM-DD'si (UTC). */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

const periodStart = isoDaysAgo(9);
const periodEnd = isoDaysAgo(0);

async function seedTeacher(fullName: string, email: string, verified: boolean): Promise<string> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO teacher (full_name, email, source, timezone, status, dispatch_ready)
       VALUES ($1, $2, 'hrmasterz', 'UTC', 'active', true) RETURNING id`,
      [fullName, email],
    );
    const teacherId = res.rows[0]!.id;
    if (verified) {
      // 5 zorunlu evrakın tamamı verified → trigger payout_ready'yi true'ya çeker
      for (const kind of DOC_KINDS) {
        await db.query(
          `INSERT INTO teacher_document (teacher_id, kind, status, vendor)
           VALUES ($1, $2, 'verified', 'manual')`,
          [teacherId, kind],
        );
      }
    }
    return teacherId;
  });
}

async function ensureAccount(
  db: Db,
  ownerType: string,
  ownerId: string | null,
  kind: string,
): Promise<string> {
  const res = await db.query<{ id: string }>(
    "SELECT ensure_ledger_account($1, $2, $3, 'USD') AS id",
    [ownerType, ownerId, kind],
  );
  return res.rows[0]!.id;
}

/**
 * Settled session zinciri: topup → slot → hold → confirmed atama → class_session →
 * settle txn [wallet_hold -price, teacher_payable +pay, platform_revenue +marj] → settled.
 */
async function settledSession(
  teacherId: string,
  opts: { priceCents: number; payCents: number; daysAgo: number },
): Promise<string> {
  const startsAt = new Date(Date.now() - opts.daysAgo * 86_400_000);
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
  const occurrenceKey = startsAt.toISOString().slice(0, 10);

  return tdb.pool.withPlatform(async (db) => {
    // Okul kasasına ders bedeli kadar bakiye (bank_clearing karşı bacağı)
    const cashId = await ensureAccount(db, "school", schoolId, "school_cash");
    const clearingId = await ensureAccount(db, "platform", null, "bank_clearing");
    await db.query("SELECT * FROM post_ledger_txn($1, 'topup', 'test_topup', $2, $3::jsonb)", [
      `test:topup:${randomUUID()}`,
      randomUUID(),
      JSON.stringify([
        { account_id: cashId, amount_cents: opts.priceCents },
        { account_id: clearingId, amount_cents: -opts.priceCents },
      ]),
    ]);

    const slotRes = await db.query<{ id: string }>(
      `INSERT INTO booking_slot
         (school_id, plan_id, class_group_id, pool_id, occurrence_key,
          starts_at, ends_at, price_cents, teacher_pay_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [schoolId, planId, classGroupId, poolId, occurrenceKey, startsAt, endsAt, opts.priceCents, opts.payCents],
    );
    const slotId = slotRes.rows[0]!.id;

    const holdId = await ensureAccount(db, "school", schoolId, "wallet_hold");
    const hold = await db.query<{ txn_id: string }>(
      "SELECT * FROM post_ledger_txn($1, 'hold', 'booking_slot', $2, $3::jsonb)",
      [
        `hold:slot:${slotId}`,
        slotId,
        JSON.stringify([
          { account_id: cashId, amount_cents: -opts.priceCents },
          { account_id: holdId, amount_cents: opts.priceCents },
        ]),
      ],
    );
    await db.query("UPDATE booking_slot SET hold_txn_id = $2, updated_at = now() WHERE id = $1", [
      slotId,
      hold.rows[0]!.txn_id,
    ]);

    await db.query(
      `INSERT INTO assignment (slot_id, teacher_id, status, starts_at, ends_at)
       VALUES ($1, $2, 'confirmed', $3, $4)`,
      [slotId, teacherId, startsAt, endsAt],
    );

    const sessionRes = await db.query<{ id: string }>(
      `INSERT INTO class_session
         (slot_id, school_id, teacher_id, class_group_id, status, started_at, ended_at, dosage_min)
       VALUES ($1, $2, $3, $4, 'ended', $5, $6, 60) RETURNING id`,
      [slotId, schoolId, teacherId, classGroupId, startsAt, endsAt],
    );
    const sessionId = sessionRes.rows[0]!.id;

    const payableId = await ensureAccount(db, "teacher", teacherId, "teacher_payable");
    const revenueId = await ensureAccount(db, "platform", null, "platform_revenue");
    const settle = await db.query<{ txn_id: string }>(
      "SELECT * FROM post_ledger_txn($1, 'session_settle', 'class_session', $2, $3::jsonb)",
      [
        `settle:session:${sessionId}`,
        sessionId,
        JSON.stringify([
          { account_id: holdId, amount_cents: -opts.priceCents },
          { account_id: payableId, amount_cents: opts.payCents },
          { account_id: revenueId, amount_cents: opts.priceCents - opts.payCents },
        ]),
      ],
    );
    await db.query(
      `UPDATE class_session SET status = 'settled', settle_txn_id = $2, updated_at = now()
        WHERE id = $1`,
      [sessionId, settle.rows[0]!.txn_id],
    );
    await db.query("UPDATE booking_slot SET status = 'completed', updated_at = now() WHERE id = $1", [
      slotId,
    ]);
    return sessionId;
  });
}

async function balance(ownerType: string, ownerId: string | null, kind: string): Promise<number> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM ledger_account
        WHERE owner_type = $1 AND owner_id IS NOT DISTINCT FROM $2 AND kind = $3`,
      [ownerType, ownerId, kind],
    );
    const row = res.rows[0];
    return row ? Number(row.balance_cents) : 0; // pg bigint → string
  });
}

/** track_balance=false hesaplar (wise_clearing) için tek doğru kaynak: bacak toplamı. */
async function entrySum(ownerType: string, ownerId: string | null, kind: string): Promise<number> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(e.amount_cents), 0) AS total
         FROM ledger_entry e
         JOIN ledger_account a ON a.id = e.account_id
        WHERE a.owner_type = $1 AND a.owner_id IS NOT DISTINCT FROM $2 AND a.kind = $3`,
      [ownerType, ownerId, kind],
    );
    return Number(res.rows[0]!.total);
  });
}

async function assertInvariantsClean(): Promise<void> {
  await tdb.pool.withPlatform(async (db) => {
    const violations = await db.query("SELECT * FROM ledger_invariant_violations()");
    expect(violations.rows).toEqual([]);
  });
}

interface PayoutRow {
  id: string;
  teacher_id: string;
  amount_cents: string;
  status: string;
  provider_idempotency_key: string;
  external_ref: string | null;
  failure_reason: string | null;
  paid_txn_id: string | null;
  submitted_at: Date | null;
  paid_at: Date | null;
}

async function payoutsOfBatch(batchId: string): Promise<PayoutRow[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<PayoutRow>(
      `SELECT id, teacher_id, amount_cents, status, provider_idempotency_key,
              external_ref, failure_reason, paid_txn_id, submitted_at, paid_at
         FROM payout WHERE batch_id = $1 ORDER BY created_at`,
      [batchId],
    );
    return res.rows;
  });
}

async function linesOfPayout(payoutId: string): Promise<{ session_id: string; amount_cents: string }[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ session_id: string; amount_cents: string }>(
      "SELECT session_id, amount_cents FROM payout_line WHERE payout_id = $1 ORDER BY id",
      [payoutId],
    );
    return res.rows;
  });
}

async function batchStatus(batchId: string): Promise<string> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ status: string }>(
      "SELECT status FROM payout_batch WHERE id = $1",
      [batchId],
    );
    return res.rows[0]!.status;
  });
}

let session1: string;
let session2: string;

beforeAll(async () => {
  tdb = await createTestDb();

  const seeded = await tdb.pool.withPlatform(async (db) => {
    const org = await db.query<{ id: string }>(
      "INSERT INTO organization (name) VALUES ('Payout Org') RETURNING id",
    );
    const school = await db.query<{ id: string }>(
      "INSERT INTO school (organization_id, name) VALUES ($1, 'Payout Okul') RETURNING id",
      [org.rows[0]!.id],
    );
    const pool = await db.query<{ id: string }>(
      "INSERT INTO pool (key, name, sell_per_lesson_cents, pay_per_lesson_cents) VALUES ('payout_pool', 'Payout Pool', 4000, 1600) RETURNING id",
    );
    return { schoolId: school.rows[0]!.id, poolId: pool.rows[0]!.id };
  });
  schoolId = seeded.schoolId;
  poolId = seeded.poolId;

  // class_group okulun verisi — okul bağlamında açılır (role_platform INSERT edemez)
  classGroupId = await tdb.pool.withSchool([schoolId], async (db) => {
    const res = await db.query<{ id: string }>(
      "INSERT INTO class_group (school_id, name) VALUES ($1, '8-C') RETURNING id",
      [schoolId],
    );
    return res.rows[0]!.id;
  });

  planId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO dosage_plan
         (school_id, class_group_id, pool_id, weekday, start_minute, duration_min,
          school_tz, price_cents, teacher_pay_cents, start_date, weeks, status)
       VALUES ($1, $2, $3, 0, 600, 60, 'UTC', 4000, 1600, $4, 12, 'completed')
       RETURNING id`,
      [schoolId, classGroupId, poolId, isoDaysAgo(30)],
    );
    return res.rows[0]!.id;
  });

  readyTeacher = await seedTeacher("Aylin Hazir", "payout.ready@example.com", true);
  heldTeacher = await seedTeacher("Baran Evraksiz", "payout.held@example.com", false);

  // readyTeacher: 2 settled ders (2×1600 = 3200 payable); heldTeacher: 1 settled ders (1600)
  session1 = await settledSession(readyTeacher, { priceCents: 4000, payCents: 1600, daysAgo: 3 });
  session2 = await settledSession(readyTeacher, { priceCents: 4000, payCents: 1600, daysAgo: 2 });
  await settledSession(heldTeacher, { priceCents: 4000, payCents: 1600, daysAgo: 4 });
});

afterAll(async () => {
  await tdb.drop();
});

test("createBatch: payable 3200 → 1 payout + 2 line; evraksız eğitmen batch dışı ama heldTeachers'ta", async () => {
  // payout_ready trigger doğrulaması: 5 verified evrak → true, evraksız → false
  const ready = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string; payout_ready: boolean }>(
      "SELECT id, payout_ready FROM teacher ORDER BY created_at",
    );
    return res.rows;
  });
  expect(ready).toEqual([
    { id: readyTeacher, payout_ready: true },
    { id: heldTeacher, payout_ready: false },
  ]);
  expect(await balance("teacher", readyTeacher, "teacher_payable")).toBe(3_200);

  const result = await createBatch(tdb.pool, { periodStart, periodEnd });
  batch1Id = result.batchId;
  expect(result.payouts).toBe(1);
  expect(result.totalCents).toBe(3_200);
  expect(result.heldTeachers).toEqual([{ teacherId: heldTeacher, amountCents: 1_600 }]);

  const payouts = await payoutsOfBatch(batch1Id);
  expect(payouts).toHaveLength(1);
  const payout = payouts[0]!;
  expect(payout.teacher_id).toBe(readyTeacher);
  expect(Number(payout.amount_cents)).toBe(3_200);
  expect(payout.status).toBe("pending");
  expect(payout.provider_idempotency_key).toBe(`payout:${readyTeacher}:${batch1Id}`);

  const lines = await linesOfPayout(payout.id);
  expect(lines.map((l) => l.session_id).sort()).toEqual([session1, session2].sort());
  expect(lines.map((l) => Number(l.amount_cents))).toEqual([1_600, 1_600]);
  expect(await batchStatus(batch1Id)).toBe("draft");
});

test("exportBatchCsv: başlık + pending satır formatı; batch draft→exported", async () => {
  const csv = await exportBatchCsv(tdb.pool, batch1Id);
  const lines = csv.trim().split("\n");
  expect(lines[0]).toBe("provider_idempotency_key,teacher_full_name,teacher_email,amount,currency");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe(
    `payout:${readyTeacher}:${batch1Id},Aylin Hazir,payout.ready@example.com,32.00,USD`,
  );
  expect(await batchStatus(batch1Id)).toBe("exported");
});

test("markBatchSubmitted: pending → submitted + submitted_at; listOpen görür", async () => {
  expect(await markBatchSubmitted(tdb.pool, batch1Id)).toEqual({ submitted: 1 });

  const payout = (await payoutsOfBatch(batch1Id))[0]!;
  expect(payout.status).toBe("submitted");
  expect(payout.submitted_at).not.toBeNull();
  // İnsan beyanı para İŞLEMEZ: payable aynen durur
  expect(await balance("teacher", readyTeacher, "teacher_payable")).toBe(3_200);

  const open = await listOpen(tdb.pool);
  expect(open).toHaveLength(1);
  expect(open[0]!.status).toBe("submitted");
  expect(open[0]!.amountCents).toBe(3_200);
});

test("importResults paid: payable 0'a iner, wise_clearing +3200; replay çift düşüm yapmaz", async () => {
  const rows = [
    {
      idempotencyKey: `payout:${readyTeacher}:${batch1Id}`,
      externalRef: "WISE-1001",
      status: "paid" as const,
    },
  ];
  expect(await importResults(tdb.pool, batch1Id, rows)).toEqual({
    paid: 1,
    failed: 0,
    warnings: [],
  });

  expect(await balance("teacher", readyTeacher, "teacher_payable")).toBe(0);
  expect(await entrySum("platform", null, "wise_clearing")).toBe(3_200);
  const payout = (await payoutsOfBatch(batch1Id))[0]!;
  expect(payout.status).toBe("paid");
  expect(payout.external_ref).toBe("WISE-1001");
  expect(payout.paid_txn_id).not.toBeNull();
  expect(payout.paid_at).not.toBeNull();
  await assertInvariantsClean();

  // REPLAY: aynı satır dizisi ikinci kez — CAS + ledger key sayesinde hiçbir bakiye kımıldamaz
  const replay = await importResults(tdb.pool, batch1Id, rows);
  expect(replay.paid).toBe(0);
  expect(replay.failed).toBe(0);
  expect(replay.warnings).toHaveLength(1);
  expect(replay.warnings[0]).toContain("paid");

  expect(await balance("teacher", readyTeacher, "teacher_payable")).toBe(0);
  expect(await entrySum("platform", null, "wise_clearing")).toBe(3_200);
  expect(await listOpen(tdb.pool)).toEqual([]);
  await assertInvariantsClean();
});

test("importResults failed: payable DEĞİŞMEZ; sonraki batch aynı session'ları yeniden toplar", async () => {
  const failTeacher = await seedTeacher("Ceyda Iban", "payout.fail@example.com", true);
  const failSession = await settledSession(failTeacher, {
    priceCents: 5_000,
    payCents: 2_000,
    daysAgo: 5,
  });
  expect(await balance("teacher", failTeacher, "teacher_payable")).toBe(2_000);

  const b2 = await createBatch(tdb.pool, { periodStart, periodEnd });
  expect(b2.payouts).toBe(1);
  expect(b2.totalCents).toBe(2_000);
  expect(b2.heldTeachers).toEqual([{ teacherId: heldTeacher, amountCents: 1_600 }]);
  await markBatchSubmitted(tdb.pool, b2.batchId);

  expect(
    await importResults(tdb.pool, b2.batchId, [
      {
        idempotencyKey: `payout:${failTeacher}:${b2.batchId}`,
        externalRef: "WISE-2001",
        status: "failed",
        failureReason: "banka hesabi dogrulanamadi",
      },
    ]),
  ).toEqual({ paid: 0, failed: 1, warnings: [] });

  // LEDGER'A DOKUNULMADI: alacak korunur, wise_clearing kımıldamaz
  expect(await balance("teacher", failTeacher, "teacher_payable")).toBe(2_000);
  expect(await entrySum("platform", null, "wise_clearing")).toBe(3_200);
  const failedPayout = (await payoutsOfBatch(b2.batchId))[0]!;
  expect(failedPayout.status).toBe("failed");
  expect(failedPayout.failure_reason).toBe("banka hesabi dogrulanamadi");

  // failed payout'un line'ları CANLI DEĞİL → yeni batch aynı session'ı yeniden bağlar
  const b3 = await createBatch(tdb.pool, { periodStart, periodEnd });
  expect(b3.payouts).toBe(1);
  expect(b3.totalCents).toBe(2_000);
  const b3payout = (await payoutsOfBatch(b3.batchId))[0]!;
  expect(await linesOfPayout(b3payout.id)).toEqual([
    { session_id: failSession, amount_cents: "2000" },
  ]);

  // Açık (pending) payout varken bir batch daha: aynı alacak İKİNCİ kez toplanmaz
  const b4 = await createBatch(tdb.pool, { periodStart, periodEnd });
  expect(b4.payouts).toBe(0);
  expect(b4.totalCents).toBe(0);

  // b3'ü kapat (yeniden deneme başarılı) — sonraki test temiz bakiyelerle başlasın
  await markBatchSubmitted(tdb.pool, b3.batchId);
  expect(
    await importResults(tdb.pool, b3.batchId, [
      {
        idempotencyKey: `payout:${failTeacher}:${b3.batchId}`,
        externalRef: "WISE-2002",
        status: "paid",
      },
    ]),
  ).toEqual({ paid: 1, failed: 0, warnings: [] });
  expect(await balance("teacher", failTeacher, "teacher_payable")).toBe(0);

  // Eğitmen paneli: failed + paid geçmişi görünür
  const history = await getTeacherPayouts(tdb.pool, failTeacher);
  expect(history.map((h) => h.status).sort()).toEqual(["failed", "paid"]);
  await assertInvariantsClean();
});

test("boş dönem: hazır eğitmenlerin alacağı kalmadı → payouts 0, held eğitmen görünür kalır", async () => {
  const b5 = await createBatch(tdb.pool, { periodStart, periodEnd });
  expect(b5.payouts).toBe(0);
  expect(b5.totalCents).toBe(0);
  expect(b5.heldTeachers).toEqual([{ teacherId: heldTeacher, amountCents: 1_600 }]);
  expect(await payoutsOfBatch(b5.batchId)).toEqual([]);
  await assertInvariantsClean();
});
