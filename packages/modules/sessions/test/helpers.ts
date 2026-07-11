// Test tohumlama: org+okul+sınıf+öğrenciler, fiyatlı havuz, eğitmen (+müsaitlik), plan,
// topup ve ELLE kurulan slot+hold+confirmed atama. Dispatch'in materializer'ı bilerek
// KULLANILMAZ (boundary: sessions testleri de yalnız @teachernow/db'ye dayanır) —
// dispatch akışının slot açılırken aldığı hold burada aynı anahtar düzeniyle
// ('hold:slot:<id>' → [school_cash -price, wallet_hold +price]) taklit edilir.
import { randomUUID } from "node:crypto";
import type { ActorPool } from "@teachernow/db";
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

/** Sınıfa isimli öğrenciler ekler (yoklama testleri için); id listesi döner. */
export async function seedStudents(
  pool: ActorPool,
  seed: SeedSchool,
  names: string[],
): Promise<string[]> {
  return pool.withSchool([seed.schoolId], async (db) => {
    const ids: string[] = [];
    for (const name of names) {
      const res = await db.query<{ id: string }>(
        "INSERT INTO student (school_id, class_group_id, full_name) VALUES ($1, $2, $3) RETURNING id",
        [seed.schoolId, seed.classGroupId, name],
      );
      ids.push(res.rows[0]!.id);
    }
    return ids;
  });
}

/** Fiyat kartlı havuz — sell/pay kolonları NOT NULL: 4000/1600. */
export async function seedPool(pool: ActorPool, key: string): Promise<string> {
  return pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      "INSERT INTO pool (key, name, sell_per_lesson_cents, pay_per_lesson_cents) VALUES ($1, $1, 4000, 1600) RETURNING id",
      [key],
    );
    return res.rows[0]!.id;
  });
}

/** Aktif + dispatch_ready eğitmen; tüm hafta müsaitlik pencereleriyle. */
export async function seedTeacher(pool: ActorPool, email: string): Promise<string> {
  return pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO teacher (full_name, email, source, timezone, status, dispatch_ready)
       VALUES ('Session Teacher', $1, 'hrmasterz', 'Europe/Istanbul', 'active', true)
       RETURNING id`,
      [email],
    );
    const teacherId = res.rows[0]!.id;
    for (let weekday = 0; weekday < 7; weekday++) {
      await db.query(
        `INSERT INTO teacher_availability (teacher_id, weekday, start_minute, end_minute, timezone)
         VALUES ($1, $2, 0, 1440, 'Europe/Istanbul')`,
        [teacherId, weekday],
      );
    }
    return teacherId;
  });
}

/** Slotların FK zinciri için minimal dosaj reçetesi. */
export async function seedPlan(pool: ActorPool, seed: SeedSchool, poolId: string): Promise<string> {
  return pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO dosage_plan
         (school_id, class_group_id, pool_id, weekday, start_minute, duration_min,
          school_tz, price_cents, teacher_pay_cents, start_date, weeks)
       VALUES ($1, $2, $3, 0, 840, 60, 'Europe/Istanbul', 4000, 1600, '2026-01-05', 4)
       RETURNING id`,
      [seed.schoolId, seed.classGroupId, poolId],
    );
    return res.rows[0]!.id;
  });
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

export interface HeldSlotInput {
  seed: SeedSchool;
  planId: string;
  poolId: string;
  /** UNIQUE(plan_id, occurrence_key) — aynı planda her slot farklı tarih almalı. */
  occurrenceKey: string;
  startsAt: Date;
  endsAt: Date;
  /** verilirse confirmed atama açılır; verilmezse slot atamasız kalır */
  teacherId?: string;
  /** verilmezse hold alınır (dispatch akışının slot açılıştaki durumu) */
  skipHold?: boolean;
}

/**
 * Dispatch'in materializer çıktısını elle kurar: INSERT booking_slot + hold txn
 * ('hold:slot:<id>' — [school_cash -price, wallet_hold +price]) + confirmed assignment.
 */
export async function createHeldSlot(pool: ActorPool, input: HeldSlotInput): Promise<string> {
  return pool.withPlatform(async (db) => {
    const slotRes = await db.query<{ id: string; price_cents: string }>(
      `INSERT INTO booking_slot
         (school_id, plan_id, class_group_id, pool_id, occurrence_key,
          starts_at, ends_at, price_cents, teacher_pay_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 4000, 1600)
       RETURNING id, price_cents`,
      [
        input.seed.schoolId,
        input.planId,
        input.seed.classGroupId,
        input.poolId,
        input.occurrenceKey,
        input.startsAt,
        input.endsAt,
      ],
    );
    const slotId = slotRes.rows[0]!.id;
    const price = Number(slotRes.rows[0]!.price_cents);

    if (!input.skipHold) {
      const cash = await db.query<{ id: string }>(
        "SELECT ensure_ledger_account('school', $1, 'school_cash') AS id",
        [input.seed.schoolId],
      );
      const hold = await db.query<{ id: string }>(
        "SELECT ensure_ledger_account('school', $1, 'wallet_hold') AS id",
        [input.seed.schoolId],
      );
      const entries = JSON.stringify([
        { account_id: cash.rows[0]!.id, amount_cents: -price },
        { account_id: hold.rows[0]!.id, amount_cents: price },
      ]);
      const txn = await db.query<{ txn_id: string }>(
        "SELECT * FROM post_ledger_txn($1, 'hold', 'booking_slot', $2, $3::jsonb)",
        [`hold:slot:${slotId}`, slotId, entries],
      );
      await db.query("UPDATE booking_slot SET hold_txn_id = $2, updated_at = now() WHERE id = $1", [
        slotId,
        txn.rows[0]!.txn_id,
      ]);
    }

    if (input.teacherId) {
      await db.query(
        `INSERT INTO assignment (slot_id, teacher_id, status, starts_at, ends_at)
         VALUES ($1, $2, 'confirmed', $3, $4)`,
        [slotId, input.teacherId, input.startsAt, input.endsAt],
      );
    }
    return slotId;
  });
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

/** Şimdiden offsetMin dakika sonrası (negatif = geçmiş). */
export function minutesFromNow(offsetMin: number): Date {
  return new Date(Date.now() + offsetMin * 60_000);
}
