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
  listOverpaidTeachers,
  markBatchSubmitted,
  teachersMissingPayoutDetails,
} from "../src/index.js";

let tdb: TestDb;
let schoolId: string;
let classGroupId: string;
let poolId: string;
let planId: string;

let readyTeacher: string; // 5 evrak verified → payout_ready=true
let heldTeacher: string; // evraksız → payout_ready=false (hard-gate)
let failTeacher: string; // failed-payout senaryosunun eğitmeni (payout detayı YOK)
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

  // readyTeacher'ın payout hesap bilgisi girilmiş (0013 payout_details) — CSV'ye taşınır;
  // heldTeacher bilinçli olarak DETAYSIZ bırakılır (eksik-detay listesi + boş CSV kolonları).
  await tdb.pool.withPlatform((db) =>
    db.query(`UPDATE teacher SET payout_details = $2::jsonb WHERE id = $1`, [
      readyTeacher,
      JSON.stringify({
        method: "wise_email",
        value: "aylin@wise.example.com",
        accountHolder: "Aylin Hazir",
      }),
    ]),
  );

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
  expect(result.batchId).not.toBeNull();
  batch1Id = result.batchId!;
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

test("exportBatchCsv: başlık + pending satır formatı (payout detayları dahil); batch draft→exported", async () => {
  const csv = await exportBatchCsv(tdb.pool, batch1Id);
  const lines = csv.trim().split("\n");
  expect(lines[0]).toBe(
    "provider_idempotency_key,teacher_full_name,teacher_email,amount,currency," +
      "payout_method,payout_value,account_holder",
  );
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe(
    `payout:${readyTeacher}:${batch1Id},Aylin Hazir,payout.ready@example.com,32.00,USD,` +
      "wise_email,aylin@wise.example.com,Aylin Hazir",
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
  failTeacher = await seedTeacher("Ceyda Iban", "payout.fail@example.com", true);
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
  const b2Id = b2.batchId!;

  // Payout detayı GİRİLMEMİŞ eğitmen: CSV'nin yeni üç kolonu boş kalır
  const csv = await exportBatchCsv(tdb.pool, b2Id);
  expect(csv.trim().split("\n")[1]).toBe(
    `payout:${failTeacher}:${b2Id},Ceyda Iban,payout.fail@example.com,20.00,USD,,,`,
  );

  await markBatchSubmitted(tdb.pool, b2Id);

  expect(
    await importResults(tdb.pool, b2Id, [
      {
        idempotencyKey: `payout:${failTeacher}:${b2Id}`,
        externalRef: "WISE-2001",
        status: "failed",
        failureReason: "banka hesabi dogrulanamadi",
      },
    ]),
  ).toEqual({ paid: 0, failed: 1, warnings: [] });

  // LEDGER'A DOKUNULMADI: alacak korunur, wise_clearing kımıldamaz
  expect(await balance("teacher", failTeacher, "teacher_payable")).toBe(2_000);
  expect(await entrySum("platform", null, "wise_clearing")).toBe(3_200);
  const failedPayout = (await payoutsOfBatch(b2Id))[0]!;
  expect(failedPayout.status).toBe("failed");
  expect(failedPayout.failure_reason).toBe("banka hesabi dogrulanamadi");

  // failed payout'un line'ları CANLI DEĞİL → yeni batch aynı session'ı yeniden bağlar
  const b3 = await createBatch(tdb.pool, { periodStart, periodEnd });
  expect(b3.payouts).toBe(1);
  expect(b3.totalCents).toBe(2_000);
  const b3Id = b3.batchId!;
  const b3payout = (await payoutsOfBatch(b3Id))[0]!;
  expect(await linesOfPayout(b3payout.id)).toEqual([
    { session_id: failSession, amount_cents: "2000" },
  ]);

  // Açık (pending) payout varken bir batch daha: ödenebilir kimse yok → BOŞ BATCH açılmaz
  const b4 = await createBatch(tdb.pool, { periodStart, periodEnd });
  expect(b4.payouts).toBe(0);
  expect(b4.totalCents).toBe(0);
  expect(b4.batchId).toBeNull();

  // b3'ü kapat (yeniden deneme başarılı) — sonraki test temiz bakiyelerle başlasın
  await markBatchSubmitted(tdb.pool, b3Id);
  expect(
    await importResults(tdb.pool, b3Id, [
      {
        idempotencyKey: `payout:${failTeacher}:${b3Id}`,
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

test("boş dönem: hazır eğitmenlerin alacağı kalmadı → payouts 0, BOŞ BATCH açılmaz, held görünür", async () => {
  const b5 = await createBatch(tdb.pool, { periodStart, periodEnd });
  expect(b5.payouts).toBe(0);
  expect(b5.totalCents).toBe(0);
  expect(b5.batchId).toBeNull(); // ödenecek kimse yok → batch satırı hiç oluşmaz
  expect(b5.heldTeachers).toEqual([{ teacherId: heldTeacher, amountCents: 1_600 }]);
  await assertInvariantsClean();
});

test("teachersMissingPayoutDetails: payout_details NULL olan yalnız AKTİF eğitmenler", async () => {
  // Aktif olmayan (invited) detaysız eğitmen listeye GİRMEMELİ
  await tdb.pool.withPlatform((db) =>
    db.query(
      `INSERT INTO teacher (full_name, email, source) VALUES ('Davetli Detaysiz', 'payout.invited@example.com', 'site')`,
    ),
  );

  const missing = await tdb.pool.withPlatform((db) => teachersMissingPayoutDetails(db));
  // readyTeacher detaylı → yok; heldTeacher + failTeacher aktif ve detaysız → listede
  expect(missing).toEqual([
    { teacherId: heldTeacher, name: "Baran Evraksiz", email: "payout.held@example.com" },
    { teacherId: failTeacher, name: "Ceyda Iban", email: "payout.fail@example.com" },
  ]);

  // Detay girilince listeden düşer
  await tdb.pool.withPlatform((db) =>
    db.query(`UPDATE teacher SET payout_details = $2::jsonb WHERE id = $1`, [
      heldTeacher,
      JSON.stringify({
        method: "iban",
        value: "TR330006100519786457841326",
        accountHolder: "Baran Evraksiz",
      }),
    ]),
  );
  const after = await tdb.pool.withPlatform((db) => teachersMissingPayoutDetails(db));
  expect(after.map((t) => t.teacherId)).toEqual([failTeacher]);
});

// Denetim tur 3: itiraz-iade edilen ders 'settled' kalır ama settle'ı ters kayıtla geri
// alınmıştır → payout satırı olarak sayılmamalı, yoksa sum(payout_line) ödenen tutarla uyuşmaz.
test("payout_line: itiraz-iade edilen ders payout satırına GİRMEZ (sum(line)=payable)", async () => {
  const refundT = await seedTeacher("Deniz Refund", "payout.refund@example.com", true);
  // daysAgo 8/7: bu plan için henüz kullanılmamış occurrence_key'ler (2–5 dolu), dönem içi.
  const sA = await settledSession(refundT, { priceCents: 4_000, payCents: 1_600, daysAgo: 8 });
  const sB = await settledSession(refundT, { priceCents: 4_000, payCents: 1_600, daysAgo: 7 });
  expect(await balance("teacher", refundT, "teacher_payable")).toBe(3_200);

  // sA'ya itiraz-iade — resolveDispute'un tam kopyası (ters kayıt + hold iade + dispute satırı).
  await tdb.pool.withPlatform(async (db) => {
    const s = await db.query<{ slot_id: string; settle_txn_id: string; school_id: string }>(
      "SELECT slot_id, settle_txn_id, school_id FROM class_session WHERE id = $1",
      [sA],
    );
    const row = s.rows[0]!;
    const entries = await db.query<{ account_id: string; amount_cents: string }>(
      "SELECT account_id, amount_cents FROM ledger_entry WHERE txn_id = $1 ORDER BY id",
      [row.settle_txn_id],
    );
    await db.query(
      "SELECT * FROM post_ledger_txn($1, 'dispute_refund', 'class_session', $2, $3::jsonb, $4, 'dispute')",
      [
        `dispute_refund:session:${sA}`,
        sA,
        JSON.stringify(
          entries.rows.map((e) => ({ account_id: e.account_id, amount_cents: -Number(e.amount_cents) })),
        ),
        row.settle_txn_id,
      ],
    );
    const holdId = await ensureAccount(db, "school", row.school_id, "wallet_hold");
    const cashId = await ensureAccount(db, "school", row.school_id, "school_cash");
    await db.query(
      "SELECT * FROM post_ledger_txn($1, 'dispute_release', 'class_session', $2, $3::jsonb)",
      [
        `dispute_release:session:${sA}`,
        sA,
        JSON.stringify([
          { account_id: holdId, amount_cents: -4_000 },
          { account_id: cashId, amount_cents: 4_000 },
        ]),
      ],
    );
    await db.query(
      `INSERT INTO session_dispute (session_id, school_id, reason, status, resolved_at)
       VALUES ($1, $2, 'test itiraz', 'resolved_refund', now())`,
      [sA, row.school_id],
    );
  });
  expect(await balance("teacher", refundT, "teacher_payable")).toBe(1_600); // iade sonrası

  const batch = await createBatch(tdb.pool, { periodStart, periodEnd });
  const myPayout = (await payoutsOfBatch(batch.batchId!)).find((p) => p.teacher_id === refundT)!;
  expect(Number(myPayout.amount_cents)).toBe(1_600); // ödenen = güncel bakiye
  const lines = await linesOfPayout(myPayout.id);
  expect(lines.map((l) => l.session_id)).toEqual([sB]); // sA (iade edilen) HARİÇ
  expect(lines.reduce((sum, l) => sum + Number(l.amount_cents), 0)).toBe(1_600); // sum(line)=payable
  await assertInvariantsClean();
});

// Denetim tur 3 [P2]: itiraz-iadesi payout ÖDENDİKTEN sonra çözülürse eğitmen dondurulmuş
// (iade-öncesi) tutarı tam alır → teacher_payable NEGATİFE düşer (min_zero değil). Invariant
// bunu yakalamaz (trial balance korunur); listOverpaidTeachers borcu admin'e yüzeye çıkarır.
test("overpayment yüzeye çıkar: payout paid SONRASI iade → negatif payable listelenir", async () => {
  const opT = await seedTeacher("Ece Overpaid", "payout.overpaid@example.com", true);
  const sA = await settledSession(opT, { priceCents: 4_000, payCents: 1_600, daysAgo: 6 });
  await settledSession(opT, { priceCents: 4_000, payCents: 1_600, daysAgo: 1 });
  expect(await balance("teacher", opT, "teacher_payable")).toBe(3_200);

  // Batch: payout 3200'de DONAR, submitted.
  const batch = await createBatch(tdb.pool, { periodStart, periodEnd });
  const payout = (await payoutsOfBatch(batch.batchId!)).find((p) => p.teacher_id === opT)!;
  expect(Number(payout.amount_cents)).toBe(3_200);
  await markBatchSubmitted(tdb.pool, batch.batchId!);

  // SONRA sA'ya itiraz-iade → payable 3200 → 1600 (payout hâlâ 3200'de donuk).
  await tdb.pool.withPlatform(async (db) => {
    const s = await db.query<{ settle_txn_id: string; school_id: string }>(
      "SELECT settle_txn_id, school_id FROM class_session WHERE id = $1",
      [sA],
    );
    const row = s.rows[0]!;
    const entries = await db.query<{ account_id: string; amount_cents: string }>(
      "SELECT account_id, amount_cents FROM ledger_entry WHERE txn_id = $1 ORDER BY id",
      [row.settle_txn_id],
    );
    await db.query(
      "SELECT * FROM post_ledger_txn($1, 'dispute_refund', 'class_session', $2, $3::jsonb, $4, 'dispute')",
      [
        `dispute_refund:session:${sA}`,
        sA,
        JSON.stringify(
          entries.rows.map((e) => ({ account_id: e.account_id, amount_cents: -Number(e.amount_cents) })),
        ),
        row.settle_txn_id,
      ],
    );
    const holdId = await ensureAccount(db, "school", row.school_id, "wallet_hold");
    const cashId = await ensureAccount(db, "school", row.school_id, "school_cash");
    await db.query(
      "SELECT * FROM post_ledger_txn($1, 'dispute_release', 'class_session', $2, $3::jsonb)",
      [
        `dispute_release:session:${sA}`,
        sA,
        JSON.stringify([
          { account_id: holdId, amount_cents: -4_000 },
          { account_id: cashId, amount_cents: 4_000 },
        ]),
      ],
    );
    // resolveDispute'un yazdığı satır — resolved_refund exclusion × netting etkileşimini de kur.
    await db.query(
      `INSERT INTO session_dispute (session_id, school_id, reason, status, resolved_at)
       VALUES ($1, $2, 'test itiraz', 'resolved_refund', now())`,
      [sA, row.school_id],
    );
  });
  expect(await balance("teacher", opT, "teacher_payable")).toBe(1_600);

  // Wise sonuç dosyası: DONMUŞ 3200 ödendi → payable = 1600 − 3200 = −1600.
  expect(
    await importResults(tdb.pool, batch.batchId!, [
      {
        idempotencyKey: payout.provider_idempotency_key,
        externalRef: "WISE-OVERPAID",
        status: "paid",
      },
    ]),
  ).toEqual({ paid: 1, failed: 0, warnings: [] });
  expect(await balance("teacher", opT, "teacher_payable")).toBe(-1_600);

  // Invariant NEGATİFİ yakalamaz (trial balance korunur) — görünürlük burada:
  await assertInvariantsClean();
  const overpaid = await tdb.pool.withPlatform((db) => listOverpaidTeachers(db));
  const mine = overpaid.find((o) => o.teacherId === opT)!;
  expect(mine).toMatchObject({ name: "Ece Overpaid", owedCents: 1_600 });
});
