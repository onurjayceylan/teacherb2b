// Kart akışının uçtan uca settle zinciri: checkout.session.completed ↔ payment_intent.succeeded.
// İki yol da settle edebilir; hangisi önce gelirse gelsin bakiye TEK kez artar.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { attachStripeRefs, createCardTopup, processStripeEvent } from "../src/index.js";

let t: TestDb;
let schoolId: string;

async function seedSchool(): Promise<string> {
  return t.pool.withPlatform(async (db) => {
    const org = await db.query<{ id: string }>(
      `INSERT INTO organization (name) VALUES ('Checkout Test Org') RETURNING id`,
    );
    const school = await db.query<{ id: string }>(
      `INSERT INTO school (organization_id, name) VALUES ($1, 'Checkout Okulu') RETURNING id`,
      [org.rows[0]!.id],
    );
    return school.rows[0]!.id;
  });
}

async function cashBalance(sid: string): Promise<number> {
  return t.pool.withPlatform(async (db) => {
    const res = await db.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM ledger_account
        WHERE owner_type = 'school' AND owner_id = $1 AND kind = 'school_cash'`,
      [sid],
    );
    return Number(res.rows[0]?.balance_cents ?? 0);
  });
}

async function newCardTopup(amountCents: number, checkoutId: string): Promise<string> {
  return t.pool.withPlatform(async (db) => {
    const id = await createCardTopup(db, { schoolId, amountCents });
    await attachStripeRefs(db, { topupId: id, checkoutId });
    return id;
  });
}

beforeAll(async () => {
  t = await createTestDb();
  schoolId = await seedSchool();
});
afterAll(async () => {
  await t.drop();
});

describe("checkout.session.completed", () => {
  it("payment_status=paid: topup'ı settle eder, PI'yi bağlar; aynı event replay'i no-op", async () => {
    const topupId = await newCardTopup(40000, "cs_paid_1");
    const before = await cashBalance(schoolId);

    const r1 = await processStripeEvent(t.pool, {
      id: "evt_cs_1",
      type: "checkout.session.completed",
      checkoutSessionId: "cs_paid_1",
      paymentIntentId: "pi_paid_1",
      paymentStatus: "paid",
    });
    expect(r1).toEqual({ duplicate: false, settledTopupId: topupId });
    expect(await cashBalance(schoolId)).toBe(before + 40000);

    const r2 = await processStripeEvent(t.pool, {
      id: "evt_cs_1",
      type: "checkout.session.completed",
      checkoutSessionId: "cs_paid_1",
      paymentIntentId: "pi_paid_1",
      paymentStatus: "paid",
    });
    expect(r2.duplicate).toBe(true);
    expect(await cashBalance(schoolId)).toBe(before + 40000);
  });

  it("sonradan gelen payment_intent.succeeded (farklı event id) çift settle ÜRETMEZ", async () => {
    const before = await cashBalance(schoolId);
    const r = await processStripeEvent(t.pool, {
      id: "evt_pi_after_cs",
      type: "payment_intent.succeeded",
      paymentIntentId: "pi_paid_1", // checkout işleyicisi bağlamıştı
    });
    expect(r.duplicate).toBe(false);
    expect(r.settledTopupId).toBeUndefined(); // zaten settled → para yolu hiç açılmadı
    expect(await cashBalance(schoolId)).toBe(before);
  });

  it("payment_status=unpaid: settle ETMEZ ama PI'yi bağlar; settle'ı PI.succeeded yapar", async () => {
    const topupId = await newCardTopup(15000, "cs_async_1");
    const before = await cashBalance(schoolId);

    const r1 = await processStripeEvent(t.pool, {
      id: "evt_cs_async",
      type: "checkout.session.completed",
      checkoutSessionId: "cs_async_1",
      paymentIntentId: "pi_async_1",
      paymentStatus: "unpaid",
    });
    expect(r1).toEqual({ duplicate: false });
    expect(await cashBalance(schoolId)).toBe(before); // henüz para yok

    const r2 = await processStripeEvent(t.pool, {
      id: "evt_pi_async",
      type: "payment_intent.succeeded",
      paymentIntentId: "pi_async_1",
    });
    expect(r2).toEqual({ duplicate: false, settledTopupId: topupId });
    expect(await cashBalance(schoolId)).toBe(before + 15000);
  });

  it("bilinmeyen checkout session id → skipped, para yolu açılmaz", async () => {
    const before = await cashBalance(schoolId);
    const r = await processStripeEvent(t.pool, {
      id: "evt_cs_unknown",
      type: "checkout.session.completed",
      checkoutSessionId: "cs_yok",
      paymentStatus: "paid",
    });
    expect(r).toEqual({ duplicate: false });
    expect(await cashBalance(schoolId)).toBe(before);
    const status = await t.pool.withPlatform(async (db) => {
      const res = await db.query<{ status: string }>(
        `SELECT status FROM webhook_event WHERE provider = 'stripe' AND event_id = 'evt_cs_unknown'`,
      );
      return res.rows[0]?.status;
    });
    expect(status).toBe("skipped");
  });
});
