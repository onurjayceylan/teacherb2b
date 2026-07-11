import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { createTestDb, type TestDb } from "@teachernow/db";
import {
  adminSettleBankTopup,
  attachStripeRefs,
  createBankTopup,
  createCardTopup,
  processStripeEvent,
  verifyStripeWebhook,
  type StripeEventResult,
} from "../src/index.js";

let tdb: TestDb;
let schoolId: string;

beforeAll(async () => {
  tdb = await createTestDb();
  schoolId = await tdb.pool.withPlatform(async (db) => {
    const org = await db.query<{ id: string }>(
      "INSERT INTO organization (name) VALUES ('Test Org') RETURNING id",
    );
    const school = await db.query<{ id: string }>(
      "INSERT INTO school (organization_id, name) VALUES ($1, 'Test Okul') RETURNING id",
      [org.rows[0]!.id],
    );
    return school.rows[0]!.id;
  });
});

afterAll(async () => {
  await tdb.drop();
});

async function cashBalance(sId: string): Promise<number> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM ledger_account
        WHERE owner_type = 'school' AND owner_id = $1 AND kind = 'school_cash'`,
      [sId],
    );
    const row = res.rows[0];
    return row ? Number(row.balance_cents) : 0;
  });
}

describe("kart top-up akışı", () => {
  it("aynı stripe eventi 5 kez → tek settle, bakiye tek artış, 4'ü duplicate", async () => {
    const before = await cashBalance(schoolId);

    const topupId = await tdb.pool.withSchool([schoolId], (db) =>
      createCardTopup(db, { schoolId, amountCents: 50_000 }),
    );
    await tdb.pool.withSchool([schoolId], (db) =>
      attachStripeRefs(db, { topupId, checkoutId: "cs_test_1", paymentIntentId: "pi_test_1" }),
    );

    const results: StripeEventResult[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await processStripeEvent(tdb.pool, {
          id: "evt_card_1",
          type: "payment_intent.succeeded",
          paymentIntentId: "pi_test_1",
        }),
      );
    }

    expect(results[0]).toEqual({ duplicate: false, settledTopupId: topupId });
    expect(results.filter((r) => r.duplicate)).toHaveLength(4);
    expect(await cashBalance(schoolId)).toBe(before + 50_000);

    await tdb.pool.withPlatform(async (db) => {
      const topup = await db.query<{ status: string; settled_txn_id: string | null }>(
        "SELECT status, settled_txn_id FROM topup_attempt WHERE id = $1",
        [topupId],
      );
      expect(topup.rows[0]!.status).toBe("settled");
      expect(topup.rows[0]!.settled_txn_id).toBeTruthy();

      const wh = await db.query<{ status: string }>(
        "SELECT status FROM webhook_event WHERE provider = 'stripe' AND event_id = 'evt_card_1'",
      );
      expect(wh.rows).toHaveLength(1);
      expect(wh.rows[0]!.status).toBe("processed");

      // Ledger değişmezleri temiz kalmalı
      const violations = await db.query("SELECT * FROM ledger_invariant_violations()");
      expect(violations.rows).toEqual([]);
    });
  });
});

describe("stripe event işleme", () => {
  it("bilinmeyen event type → skipped, duplicate=false", async () => {
    const res = await processStripeEvent(tdb.pool, { id: "evt_unknown_1", type: "customer.created" });
    expect(res.duplicate).toBe(false);
    expect(res.settledTopupId).toBeUndefined();

    const status = await tdb.pool.withPlatform(async (db) => {
      const r = await db.query<{ status: string }>(
        "SELECT status FROM webhook_event WHERE provider = 'stripe' AND event_id = 'evt_unknown_1'",
      );
      return r.rows[0]!.status;
    });
    expect(status).toBe("skipped");
  });

  it("payment_intent eşleşmezse → skipped", async () => {
    const res = await processStripeEvent(tdb.pool, {
      id: "evt_orphan_1",
      type: "payment_intent.succeeded",
      paymentIntentId: "pi_boyle_biri_yok",
    });
    expect(res).toEqual({ duplicate: false });

    const status = await tdb.pool.withPlatform(async (db) => {
      const r = await db.query<{ status: string }>(
        "SELECT status FROM webhook_event WHERE provider = 'stripe' AND event_id = 'evt_orphan_1'",
      );
      return r.rows[0]!.status;
    });
    expect(status).toBe("skipped");
  });
});

describe("banka top-up akışı", () => {
  it("settle bakiyeyi bir kez artırır; ikinci settle no-op", async () => {
    const before = await cashBalance(schoolId);

    const { id, referenceCode } = await tdb.pool.withSchool([schoolId], (db) =>
      createBankTopup(db, { schoolId, amountCents: 75_000 }),
    );
    expect(referenceCode).toMatch(/^TN-[0-9A-F]{8}$/);

    const first = await tdb.pool.withPlatform((db) =>
      adminSettleBankTopup(db, { topupId: id, fxSourceCurrency: "TRY", fxSourceAmount: 2_500_000 }),
    );
    expect(first.alreadySettled).toBe(false);
    expect(first.txnId).toBeTruthy();
    expect(await cashBalance(schoolId)).toBe(before + 75_000);

    const second = await tdb.pool.withPlatform((db) => adminSettleBankTopup(db, { topupId: id }));
    expect(second).toEqual({ alreadySettled: true });
    expect(await cashBalance(schoolId)).toBe(before + 75_000);

    await tdb.pool.withPlatform(async (db) => {
      const topup = await db.query<{ status: string; fx_source_currency: string | null }>(
        "SELECT status, fx_source_currency FROM topup_attempt WHERE id = $1",
        [id],
      );
      expect(topup.rows[0]!.status).toBe("settled");
      expect(topup.rows[0]!.fx_source_currency).toBe("TRY");

      const audit = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE action = 'bank_topup_settled' AND entity_id = $1`,
        [id],
      );
      expect(audit.rows[0]!.n).toBe(1);
    });
  });

  it("settle sonrası okulun owner/admin'ine school_topup_settled düşer; finance almaz", async () => {
    // Okul üyeleri: owner + admin bildirim alır, finance almaz (SLA eskalasyon deseni)
    await tdb.pool.withPlatform(async (db) => {
      for (const [email, role] of [
        ["topup.owner@okul.com", "owner"],
        ["topup.admin@okul.com", "admin"],
        ["topup.finance@okul.com", "finance"],
      ] as const) {
        const user = await db.query<{ id: string }>(
          "INSERT INTO app_user (email, name) VALUES ($1, 'Topup Kullanıcısı') RETURNING id",
          [email],
        );
        await db.query("INSERT INTO school_user (school_id, user_id, role) VALUES ($1, $2, $3)", [
          schoolId,
          user.rows[0]!.id,
          role,
        ]);
      }
    });

    const { id, referenceCode } = await tdb.pool.withSchool([schoolId], (db) =>
      createBankTopup(db, { schoolId, amountCents: 33_000 }),
    );
    await tdb.pool.withPlatform((db) => adminSettleBankTopup(db, { topupId: id }));

    const rows = await tdb.pool.withPlatform(async (db) => {
      const res = await db.query<{
        recipient_email: string;
        status: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT recipient_email, status, payload
           FROM notification_outbox
          WHERE template = 'school_topup_settled'
          ORDER BY recipient_email`,
      );
      return res.rows;
    });
    expect(rows.map((r) => r.recipient_email)).toEqual([
      "topup.admin@okul.com",
      "topup.owner@okul.com",
    ]);
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.payload["amountCents"]).toBe(33_000);
      expect(row.payload["referenceCode"]).toBe(referenceCode);
      expect(row.payload["schoolName"]).toBe("Test Okul");
    }

    // Replay (alreadySettled) bildirim ÇOĞALTMAZ
    await tdb.pool.withPlatform((db) => adminSettleBankTopup(db, { topupId: id }));
    const again = await tdb.pool.withPlatform(async (db) => {
      const res = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM notification_outbox WHERE template = 'school_topup_settled'",
      );
      return Number(res.rows[0]!.n);
    });
    expect(again).toBe(2);
  });

  it("payments_frozen iken settle exception atar ve bakiye değişmez", async () => {
    const before = await cashBalance(schoolId);
    const { id } = await tdb.pool.withSchool([schoolId], (db) =>
      createBankTopup(db, { schoolId, amountCents: 10_000 }),
    );

    await tdb.pool.withPlatform((db) =>
      db.query("UPDATE system_flag SET value = true, updated_at = now() WHERE key = 'payments_frozen'"),
    );
    try {
      await expect(
        tdb.pool.withPlatform((db) => adminSettleBankTopup(db, { topupId: id })),
      ).rejects.toThrow(/payments_frozen/);
    } finally {
      await tdb.pool.withPlatform((db) =>
        db.query("UPDATE system_flag SET value = false, updated_at = now() WHERE key = 'payments_frozen'"),
      );
    }

    expect(await cashBalance(schoolId)).toBe(before);
    const status = await tdb.pool.withPlatform(async (db) => {
      const r = await db.query<{ status: string }>(
        "SELECT status FROM topup_attempt WHERE id = $1",
        [id],
      );
      return r.rows[0]!.status;
    });
    expect(status).toBe("pending_review");
  });
});

describe("verifyStripeWebhook", () => {
  it("geçerli imzayı doğrular, bozuk imzada exception atar", () => {
    const stripe = new Stripe("sk_test_dummy");
    const payload = JSON.stringify({
      id: "evt_sig_1",
      object: "event",
      type: "payment_intent.succeeded",
      data: { object: {} },
    });
    const secret = "whsec_test_123";
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });

    const event = verifyStripeWebhook(payload, header, secret);
    expect(event.id).toBe("evt_sig_1");
    expect(event.type).toBe("payment_intent.succeeded");

    expect(() => verifyStripeWebhook(payload, header, "whsec_yanlis")).toThrow();
    expect(() => verifyStripeWebhook(payload, "t=1,v1=bozuk", secret)).toThrow();
  });
});
