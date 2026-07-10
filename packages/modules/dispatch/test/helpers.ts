// Test tohumlama yardımcıları: org+okul+sınıf, havuz, eğitmen (aktif + dispatch_ready +
// müsaitlik), plan ve okul kasasına bakiye (post_ledger_txn topup). Ham SQL kullanılır —
// testler de dispatch gibi yalnız @teachernow/db'ye dayanır.
import { randomUUID } from "node:crypto";
import type { ActorPool } from "@teachernow/db";
import { DateTime } from "luxon";
import { expect } from "vitest";

export interface SeedSchool {
  schoolId: string;
  classGroupId: string;
}

export async function seedSchool(pool: ActorPool, name: string): Promise<SeedSchool> {
  const schoolId = await pool.withPlatform(async (db) => {
    const org = await db.query<{ id: string }>(
      "INSERT INTO organization (name) VALUES ($1) RETURNING id",
      [`${name} Org`],
    );
    const school = await db.query<{ id: string }>(
      "INSERT INTO school (organization_id, name) VALUES ($1, $2) RETURNING id",
      [org.rows[0]!.id, name],
    );
    return school.rows[0]!.id;
  });
  // Roster okulun verisi: class_group okul bağlamında açılır (role_platform INSERT edemez)
  const classGroupId = await pool.withSchool([schoolId], async (db) => {
    const res = await db.query<{ id: string }>(
      "INSERT INTO class_group (school_id, name) VALUES ($1, '5-A') RETURNING id",
      [schoolId],
    );
    return res.rows[0]!.id;
  });
  return { schoolId, classGroupId };
}

/** Her senaryo kendi havuzunu açar — dosyalar/senaryolar arası aday sızıntısı olmaz. */
export async function seedPool(pool: ActorPool, key: string): Promise<string> {
  return pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      "INSERT INTO pool (key, name) VALUES ($1, $1) RETURNING id",
      [key],
    );
    return res.rows[0]!.id;
  });
}

export interface AvailabilityWindow {
  weekday: number;
  startMinute: number;
  endMinute: number;
  /** verilmezse eğitmenin timezone'u kullanılır */
  timezone?: string;
}

export interface SeedTeacherInput {
  email: string;
  timezone: string;
  poolId?: string;
  availability?: AvailabilityWindow[];
}

/** Aktif + dispatch_ready eğitmen; istenirse havuz üyeliği ve müsaitlik pencereleri. */
export async function seedTeacher(pool: ActorPool, input: SeedTeacherInput): Promise<string> {
  return pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO teacher (full_name, email, source, timezone, status, dispatch_ready)
       VALUES ('Dispatch Teacher', $1, 'hrmasterz', $2, 'active', true)
       RETURNING id`,
      [input.email, input.timezone],
    );
    const teacherId = res.rows[0]!.id;
    if (input.poolId) {
      await db.query("INSERT INTO teacher_pool (teacher_id, pool_id) VALUES ($1, $2)", [
        teacherId,
        input.poolId,
      ]);
    }
    for (const w of input.availability ?? []) {
      await db.query(
        `INSERT INTO teacher_availability (teacher_id, weekday, start_minute, end_minute, timezone)
         VALUES ($1, $2, $3, $4, $5)`,
        [teacherId, w.weekday, w.startMinute, w.endMinute, w.timezone ?? input.timezone],
      );
    }
    return teacherId;
  });
}

/** Eğitmeni havuza sonradan ekler (materialize sonrası manuel teklif senaryoları için). */
export async function addTeacherToPool(
  pool: ActorPool,
  teacherId: string,
  poolId: string,
): Promise<void> {
  await pool.withPlatform((db) =>
    db.query("INSERT INTO teacher_pool (teacher_id, pool_id) VALUES ($1, $2)", [
      teacherId,
      poolId,
    ]),
  );
}

/** Okul kasasına bakiye: post_ledger_txn topup (bank_clearing karşı bacağı). */
export async function topupSchool(
  pool: ActorPool,
  schoolId: string,
  amountCents: number,
): Promise<void> {
  await pool.withPlatform(async (db) => {
    const cash = await db.query<{ id: string }>(
      "SELECT ensure_ledger_account('school', $1, 'school_cash') AS id",
      [schoolId],
    );
    const clearing = await db.query<{ id: string }>(
      "SELECT ensure_ledger_account('platform', NULL, 'bank_clearing') AS id",
    );
    const entries = JSON.stringify([
      { account_id: cash.rows[0]!.id, amount_cents: amountCents },
      { account_id: clearing.rows[0]!.id, amount_cents: -amountCents },
    ]);
    await db.query("SELECT * FROM post_ledger_txn($1, 'topup', 'test_topup', $2, $3::jsonb)", [
      `test:topup:${randomUUID()}`,
      randomUUID(),
      entries,
    ]);
  });
}

export interface SeedPlanInput {
  schoolId: string;
  classGroupId: string;
  poolId: string;
  weekday: number;
  startMinute: number;
  durationMin: number;
  schoolTz: string;
  priceCents: number;
  teacherPayCents: number;
  /** YYYY-MM-DD (okul-lokal) */
  startDate: string;
  weeks: number;
}

export async function seedPlan(pool: ActorPool, input: SeedPlanInput): Promise<string> {
  return pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO dosage_plan
         (school_id, class_group_id, pool_id, weekday, start_minute, duration_min,
          school_tz, price_cents, teacher_pay_cents, start_date, weeks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        input.schoolId,
        input.classGroupId,
        input.poolId,
        input.weekday,
        input.startMinute,
        input.durationMin,
        input.schoolTz,
        input.priceCents,
        input.teacherPayCents,
        input.startDate,
        input.weeks,
      ],
    );
    return res.rows[0]!.id;
  });
}

/** Testler global materializer koştuğu için biten senaryonun planı kapatılır. */
export async function completePlan(pool: ActorPool, planId: string): Promise<void> {
  await pool.withPlatform((db) =>
    db.query("UPDATE dosage_plan SET status = 'completed', updated_at = now() WHERE id = $1", [
      planId,
    ]),
  );
}

export async function balance(
  pool: ActorPool,
  ownerType: string,
  ownerId: string | null,
  kind: string,
): Promise<number> {
  return pool.withPlatform(async (db) => {
    const res = await db.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM ledger_account
        WHERE owner_type = $1 AND owner_id IS NOT DISTINCT FROM $2 AND kind = $3`,
      [ownerType, ownerId, kind],
    );
    const row = res.rows[0];
    return row ? Number(row.balance_cents) : 0; // pg bigint → string
  });
}

/**
 * Bacaklardan türetilmiş bakiye. platform_revenue gibi track_balance=false hesapların
 * balance_cents cache'i hep 0 kalır — onlar için tek doğru kaynak entry toplamıdır.
 */
export async function entrySum(
  pool: ActorPool,
  ownerType: string,
  ownerId: string | null,
  kind: string,
): Promise<number> {
  return pool.withPlatform(async (db) => {
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

export async function assertInvariantsClean(pool: ActorPool): Promise<void> {
  await pool.withPlatform(async (db) => {
    const violations = await db.query("SELECT * FROM ledger_invariant_violations()");
    expect(violations.rows).toEqual([]);
  });
}

/** Bugünden daysAhead gün sonrası (verilen zone'da): tarih + ISO-Pazartesi-0 weekday. */
export function futureDate(zone: string, daysAhead: number): { dateISO: string; weekday: number } {
  const dt = DateTime.now().setZone(zone).plus({ days: daysAhead });
  const dateISO = dt.toISODate();
  if (!dateISO) throw new Error(`futureDate: geçersiz zone: ${zone}`);
  return { dateISO, weekday: dt.weekday - 1 };
}

/** Haftanın 7 günü 00:00-24:00 müsaitlik (eğitmenin kendi tz'sinde). */
export function allWeekAvailability(): AvailabilityWindow[] {
  return Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    startMinute: 0,
    endMinute: 1440,
  }));
}
