// P0-B: bloke slot otomatik retry — yetersiz bakiyede sweep dokunmaz; top-up sonrası
// hold + scheduled + teklif; ikinci sweep idempotent (çift hold imkânsız); kısmi bakiyede
// kronolojik ilk slot açılır, kalan bloke kalır; kill-switch para yolunu kapatır.
// Testler sıralı bir hikâye anlatır: aynı okulun durumu testler arasında taşınır.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { materializePlans, retryBlockedSlots } from "../src/index.js";
import {
  allWeekAvailability,
  assertInvariantsClean,
  balance,
  completePlan,
  futureDate,
  seedPlan,
  seedPool,
  seedSchool,
  seedTeacher,
  topupSchool,
} from "./helpers.js";

const TZ = "Europe/Istanbul";
const PRICE = 10_000;

let tdb: TestDb;
let schoolA: string;
let planA: string;
let schoolB: string;
let planB: string;

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

interface SlotState {
  id: string;
  occurrence_key: string;
  status: string;
  starts_at: Date;
  hold_txn_id: string | null;
}

async function planSlots(planId: string): Promise<SlotState[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<SlotState>(
      `SELECT id, occurrence_key::text AS occurrence_key, status, starts_at, hold_txn_id
         FROM booking_slot WHERE plan_id = $1 ORDER BY starts_at`,
      [planId],
    );
    return res.rows;
  });
}

/** Slotun 'hold:slot:<id>' anahtarlı ledger txn sayısı — çift hold kanıtı için. */
async function holdTxnCount(slotId: string): Promise<number> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM ledger_transaction WHERE idempotency_key = $1",
      [`hold:slot:${slotId}`],
    );
    return Number(res.rows[0]!.n);
  });
}

async function setFrozen(value: boolean): Promise<void> {
  await tdb.pool.withPlatform((db) =>
    db.query("UPDATE system_flag SET value = $1, updated_at = now() WHERE key = 'payments_frozen'", [
      value,
    ]),
  );
}

describe("retryBlockedSlots", () => {
  it("kurulum: bakiyesiz plan 2 bloke slot üretir; sweep bakiye yokken DOKUNMAZ", async () => {
    const a = await seedSchool(tdb.pool, "Retry Okul A");
    schoolA = a.schoolId;
    const poolId = await seedPool(tdb.pool, "retry_pool_a");
    await seedTeacher(tdb.pool, {
      email: "retry.teacher.a@example.com",
      timezone: TZ,
      poolId,
      availability: allWeekAvailability(),
    });
    const start = futureDate(TZ, 3);
    planA = await seedPlan(tdb.pool, {
      schoolId: schoolA,
      classGroupId: a.classGroupId,
      poolId,
      weekday: start.weekday,
      startMinute: 720,
      durationMin: 60,
      schoolTz: TZ,
      priceCents: PRICE,
      teacherPayCents: 6_000,
      startDate: start.dateISO,
      weeks: 2,
    });

    // Hiç bakiye yok → iki occurrence da bloke doğar
    expect(await materializePlans(tdb.pool)).toEqual({ created: 0, blocked: 2, skipped: 0 });
    await completePlan(tdb.pool, planA);

    // Sweep: bakiye hâlâ yok → iki slot da bloke KALIR, para izi yok
    expect(await retryBlockedSlots(tdb.pool)).toEqual({ retried: 0, stillBlocked: 2, offered: 0 });
    const slots = await planSlots(planA);
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      expect(slot.status).toBe("blocked_insufficient_funds");
      expect(slot.hold_txn_id).toBeNull();
    }
    expect(await balance(tdb.pool, "school", schoolA, "school_cash")).toBe(0);
    expect(await balance(tdb.pool, "school", schoolA, "wallet_hold")).toBe(0);
    await assertInvariantsClean(tdb.pool);
  });

  it("top-up sonrası sweep: hold post + scheduled + teklif; audit 'slot_unblocked' düşer", async () => {
    await topupSchool(tdb.pool, schoolA, 2 * PRICE); // iki slota da yetecek bakiye

    expect(await retryBlockedSlots(tdb.pool)).toEqual({ retried: 2, stillBlocked: 0, offered: 2 });

    const slots = await planSlots(planA);
    for (const slot of slots) {
      expect(slot.status).toBe("scheduled");
      expect(slot.hold_txn_id).not.toBeNull();
    }
    expect(await balance(tdb.pool, "school", schoolA, "school_cash")).toBe(0);
    expect(await balance(tdb.pool, "school", schoolA, "wallet_hold")).toBe(2 * PRICE);

    await tdb.pool.withPlatform(async (db) => {
      // Her slot için audit izi + canlı teklif + payload'da ücret/son-geçerlilik
      for (const slot of slots) {
        const audit = await db.query(
          "SELECT 1 FROM audit_log WHERE action = 'slot_unblocked' AND entity_id = $1",
          [slot.id],
        );
        expect(audit.rowCount).toBe(1);
        const offer = await db.query(
          "SELECT 1 FROM assignment WHERE slot_id = $1 AND status = 'offered'",
          [slot.id],
        );
        expect(offer.rowCount).toBe(1);
      }
      const outbox = await db.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM notification_outbox
          WHERE template = 'teacher_offer' AND recipient_email = 'retry.teacher.a@example.com'`,
      );
      expect(outbox.rows).toHaveLength(2);
      for (const row of outbox.rows) {
        expect(row.payload["payCents"]).toBe(6_000);
        expect(typeof row.payload["expiresAt"]).toBe("string");
      }
    });
    await assertInvariantsClean(tdb.pool);
  });

  it("ikinci sweep idempotent: çift hold yok, bakiyeler oynamaz, invariant temiz", async () => {
    expect(await retryBlockedSlots(tdb.pool)).toEqual({ retried: 0, stillBlocked: 0, offered: 0 });

    const slots = await planSlots(planA);
    for (const slot of slots) {
      expect(slot.status).toBe("scheduled");
      expect(await holdTxnCount(slot.id)).toBe(1); // 'hold:slot:<id>' anahtarı TEK txn
    }
    expect(await balance(tdb.pool, "school", schoolA, "school_cash")).toBe(0);
    expect(await balance(tdb.pool, "school", schoolA, "wallet_hold")).toBe(2 * PRICE);
    await assertInvariantsClean(tdb.pool);
  });

  it("kısmi bakiye: 2 bloke slottan yalnız kronolojik İLKİ açılır, kalan bloke sayılır", async () => {
    const b = await seedSchool(tdb.pool, "Retry Okul B");
    schoolB = b.schoolId;
    const poolId = await seedPool(tdb.pool, "retry_pool_b"); // havuzda eğitmen yok
    const start = futureDate(TZ, 4);
    planB = await seedPlan(tdb.pool, {
      schoolId: schoolB,
      classGroupId: b.classGroupId,
      poolId,
      weekday: start.weekday,
      startMinute: 600,
      durationMin: 60,
      schoolTz: TZ,
      priceCents: PRICE,
      teacherPayCents: 6_000,
      startDate: start.dateISO,
      weeks: 2,
    });
    // planA 'completed' olduğundan materializer'ın dışında (yalnız active planlar) →
    // skipped 0; yalnız planB'nin 2 occurrence'ı bakiyesiz bloke doğar.
    expect(await materializePlans(tdb.pool)).toEqual({ created: 0, blocked: 2, skipped: 0 });
    await completePlan(tdb.pool, planB);

    await topupSchool(tdb.pool, schoolB, PRICE); // yalnız 1 derse yetiyor
    // Aday yoksa teklif çıkmaz (offered=0) — bu sorun değil, backfill zaten tarar
    expect(await retryBlockedSlots(tdb.pool)).toEqual({ retried: 1, stillBlocked: 1, offered: 0 });

    const slots = await planSlots(planB);
    expect(slots[0]!.status).toBe("scheduled"); // en yakın ders fonlandı
    expect(slots[0]!.hold_txn_id).not.toBeNull();
    expect(slots[1]!.status).toBe("blocked_insufficient_funds");
    expect(slots[1]!.hold_txn_id).toBeNull();
    expect(await balance(tdb.pool, "school", schoolB, "school_cash")).toBe(0);
    expect(await balance(tdb.pool, "school", schoolB, "wallet_hold")).toBe(PRICE);
    await assertInvariantsClean(tdb.pool);
  });

  it("kill-switch: payments_frozen iken sweep para yoluna girmez; açılınca slot kurtulur", async () => {
    await topupSchool(tdb.pool, schoolB, PRICE); // kalan bloke slota yetecek bakiye
    await setFrozen(true);
    try {
      // P0001 → koşu durur, kalan aday stillBlocked sayılır; slot bloke KALIR
      expect(await retryBlockedSlots(tdb.pool)).toEqual({
        retried: 0,
        stillBlocked: 1,
        offered: 0,
      });
      const slots = await planSlots(planB);
      expect(slots[1]!.status).toBe("blocked_insufficient_funds");
      expect(await balance(tdb.pool, "school", schoolB, "wallet_hold")).toBe(PRICE);
    } finally {
      await setFrozen(false);
    }

    // Kill-switch kalktı → aynı sweep slotu açar
    expect(await retryBlockedSlots(tdb.pool)).toEqual({ retried: 1, stillBlocked: 0, offered: 0 });
    expect((await planSlots(planB))[1]!.status).toBe("scheduled");
    expect(await balance(tdb.pool, "school", schoolB, "school_cash")).toBe(0);
    expect(await balance(tdb.pool, "school", schoolB, "wallet_hold")).toBe(2 * PRICE);
    await assertInvariantsClean(tdb.pool);
  });
});
