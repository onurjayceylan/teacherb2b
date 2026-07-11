// Düşük bakiye uyarı job'ı: bakiye < 7 günlük taahhüt → audit_log'a 'low_balance_warning';
// okul başına 24 saatte tek kayıt; bol bakiyeli okul uyarılmaz; gelecekte başlayan
// bloke (blocked_insufficient_funds) slotu olan okul da uyarılır.
// Seed ham SQL ile (worker @teachernow/tenancy'ye bağımlı değil).
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { runLowBalanceCheck } from "../src/low-balance.js";

let tdb: TestDb;
let orgId: string;
let lowSchool: SchoolSeed;
let richSchool: SchoolSeed;

interface SchoolSeed {
  schoolId: string;
  classGroupId: string;
  planId: string;
}

function firstId(rows: Array<{ id: string }>, what: string): string {
  const row = rows[0];
  if (!row) throw new Error(`seed: ${what} sonuç döndürmedi`);
  return row.id;
}

/** Okul + class_group + dosaj planı (slot FK zinciri için) açar. */
async function seedSchool(name: string): Promise<SchoolSeed> {
  const schoolId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      "INSERT INTO school (organization_id, name) VALUES ($1, $2) RETURNING id",
      [orgId, name],
    );
    return firstId(res.rows, "school");
  });
  // class_group INSERT'i yalnız okul bağlamında (platformun roster INSERT grant'i yok).
  const classGroupId = await tdb.pool.withSchool([schoolId], async (db) => {
    const res = await db.query<{ id: string }>(
      "INSERT INTO class_group (school_id, name) VALUES ($1, 'Grade 1') RETURNING id",
      [schoolId],
    );
    return firstId(res.rows, "class_group");
  });
  const planId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO dosage_plan
         (school_id, class_group_id, pool_id, weekday, start_minute, duration_min,
          school_tz, price_cents, teacher_pay_cents, start_date, weeks)
       SELECT $1, $2, id, 0, 600, 45, 'Europe/Istanbul', 4000, 1600, current_date, 4
         FROM pool WHERE key = 'native_esl'
       RETURNING id`,
      [schoolId, classGroupId],
    );
    return firstId(res.rows, "dosage_plan");
  });
  return { schoolId, classGroupId, planId };
}

/** Slot ekler; occurrence_key günü UNIQUE(plan_id, occurrence_key) çakışmasın diye parametreli. */
async function addSlot(
  seed: SchoolSeed,
  opts: { startsInDays: number; status?: "scheduled" | "blocked_insufficient_funds" },
): Promise<void> {
  await tdb.pool.withPlatform((db) =>
    db.query(
      `INSERT INTO booking_slot
         (school_id, plan_id, class_group_id, pool_id, occurrence_key,
          starts_at, ends_at, price_cents, teacher_pay_cents, status)
       SELECT $1, $2, $3, pool_id, current_date + $4::int,
              now() + make_interval(days => $4::int),
              now() + make_interval(days => $4::int) + interval '45 minutes',
              4000, 1600, $5
         FROM dosage_plan WHERE id = $2`,
      [seed.schoolId, seed.planId, seed.classGroupId, opts.startsInDays, opts.status ?? "scheduled"],
    ),
  );
}

/** school_cash bakiyesini topup_settle txn'iyle kurar (clearing karşı bacak). */
async function setBalance(schoolId: string, cents: number): Promise<void> {
  await tdb.pool.withPlatform(async (db) => {
    const cash = await db.query<{ id: string }>(
      "SELECT ensure_ledger_account('school', $1, 'school_cash') AS id",
      [schoolId],
    );
    const clearing = await db.query<{ id: string }>(
      "SELECT ensure_ledger_account('platform', NULL, 'stripe_clearing') AS id",
    );
    await db.query(
      "SELECT * FROM post_ledger_txn($1, 'topup_settle', 'topup_attempt', NULL, $2::jsonb)",
      [
        `seed-balance-${schoolId}`,
        JSON.stringify([
          { account_id: firstId(cash.rows, "school_cash"), amount_cents: cents },
          { account_id: firstId(clearing.rows, "clearing"), amount_cents: -cents },
        ]),
      ],
    );
  });
}

async function warningsFor(schoolId: string): Promise<Array<{ actor_kind: string; after: { balanceCents: number; committed7dCents: number } }>> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ actor_kind: string; after: { balanceCents: number; committed7dCents: number } }>(
      `SELECT actor_kind, after FROM audit_log
        WHERE action = 'low_balance_warning' AND entity_type = 'school' AND entity_id = $1`,
      [schoolId],
    );
    return res.rows;
  });
}

beforeAll(async () => {
  tdb = await createTestDb();
  orgId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      "INSERT INTO organization (name) VALUES ('Low Balance Org') RETURNING id",
    );
    return firstId(res.rows, "organization");
  });

  // Düşük bakiye: kasada 1000, 2 gün sonra 4000'lik scheduled slot → taahhüt karşılıksız.
  lowSchool = await seedSchool("Low Balance School");
  await setBalance(lowSchool.schoolId, 1000);
  await addSlot(lowSchool, { startsInDays: 2 });

  // Bol bakiye: kasada 100000, aynı taahhüt → uyarı yok.
  richSchool = await seedSchool("Rich School");
  await setBalance(richSchool.schoolId, 100_000);
  await addSlot(richSchool, { startsInDays: 2 });
});

afterAll(async () => {
  await tdb.drop();
});

test("bakiyesi 7 günlük taahhüdün altındaki okul uyarılır; bol bakiyeli okul uyarılmaz", async () => {
  const result = await runLowBalanceCheck(tdb.pool);
  expect(result).toEqual({ warned: 1 });

  const low = await warningsFor(lowSchool.schoolId);
  expect(low).toHaveLength(1);
  expect(low[0]!.actor_kind).toBe("agent");
  expect(low[0]!.after).toEqual({ balanceCents: 1000, committed7dCents: 4000 });

  expect(await warningsFor(richSchool.schoolId)).toHaveLength(0);
});

test("ikinci koşu → warned 0 (aynı okula 24 saat içinde tekrar yazılmaz)", async () => {
  const result = await runLowBalanceCheck(tdb.pool);
  expect(result).toEqual({ warned: 0 });
  expect(await warningsFor(lowSchool.schoolId)).toHaveLength(1);
});

test("bloke slotu (gelecekte) olan okul bakiyesi bol olsa da uyarılır", async () => {
  const blockedSchool = await seedSchool("Blocked School");
  await setBalance(blockedSchool.schoolId, 100_000);
  await addSlot(blockedSchool, { startsInDays: 3, status: "blocked_insufficient_funds" });

  const result = await runLowBalanceCheck(tdb.pool);
  expect(result).toEqual({ warned: 1 }); // low/rich 24s korumasında; yalnız blocked okul

  const rows = await warningsFor(blockedSchool.schoolId);
  expect(rows).toHaveLength(1);
  // Bloke slot 'scheduled' olmadığı için taahhüt toplamına girmez; bakiye fotoğrafı yazılır.
  expect(rows[0]!.after).toEqual({ balanceCents: 100_000, committed7dCents: 0 });
});

test("7 gün penceresi dışındaki scheduled slot taahhüt sayılmaz → uyarı yok", async () => {
  const farSchool = await seedSchool("Far Horizon School");
  await setBalance(farSchool.schoolId, 1000);
  await addSlot(farSchool, { startsInDays: 10 }); // pencere dışı: taahhüt 0

  const result = await runLowBalanceCheck(tdb.pool);
  expect(result).toEqual({ warned: 0 });
  expect(await warningsFor(farSchool.schoolId)).toHaveLength(0);
});
