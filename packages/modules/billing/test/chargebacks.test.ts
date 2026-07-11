// Chargeback ingest'i (0014): charge.dispute.* event'leri PARA HAREKETİ ÜRETMEDEN
// chargeback_event + audit + (created/lost'ta) platform_alert outbox kaydı açar.
// İdempotency iki katmanlı: webhook_event (provider,event_id) + chargeback_event
// stripe_event_id UNIQUE — aynı event'in tekrarı yapısal no-op.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { attachStripeRefs, createCardTopup, processStripeEvent } from "../src/index.js";

let tdb: TestDb;
let schoolId: string;

beforeAll(async () => {
  process.env.ALERT_EMAIL = "cb-alerts@test.example";
  tdb = await createTestDb();
  schoolId = await tdb.pool.withPlatform(async (db) => {
    const org = await db.query<{ id: string }>(
      "INSERT INTO organization (name) VALUES ('CB Org') RETURNING id",
    );
    const school = await db.query<{ id: string }>(
      "INSERT INTO school (organization_id, name) VALUES ($1, 'CB Okul') RETURNING id",
      [org.rows[0]!.id],
    );
    return school.rows[0]!.id;
  });
  // PI eşleşmesi için topup: yalnız stripe_payment_intent bağlanır, SETTLE EDİLMEZ.
  const topupId = await tdb.pool.withSchool([schoolId], (db) =>
    createCardTopup(db, { schoolId, amountCents: 50_000 }),
  );
  await tdb.pool.withSchool([schoolId], (db) =>
    attachStripeRefs(db, { topupId, checkoutId: "cs_cb_1", paymentIntentId: "pi_cb_1" }),
  );
});

afterAll(async () => {
  delete process.env.ALERT_EMAIL;
  await tdb.drop();
});

interface ChargebackRow {
  stripe_event_id: string;
  stripe_dispute_id: string;
  payment_intent_id: string | null;
  school_id: string | null;
  amount_cents: string;
  currency: string;
  status: string;
}

async function chargebackRows(): Promise<ChargebackRow[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<ChargebackRow>(
      `SELECT stripe_event_id, stripe_dispute_id, payment_intent_id, school_id,
              amount_cents, currency, status
         FROM chargeback_event ORDER BY created_at, stripe_event_id`,
    );
    return res.rows;
  });
}

async function alertRows(): Promise<{ recipient_email: string; payload: Record<string, unknown> }[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ recipient_email: string; payload: Record<string, unknown> }>(
      `SELECT recipient_email, payload FROM notification_outbox
        WHERE template = 'platform_alert' ORDER BY created_at`,
    );
    return res.rows;
  });
}

/** Para hesaplarının kımıldamadığının en sert kanıtı: ledger'da hiç kayıt yok. */
async function ledgerCounts(): Promise<{ txns: number; entries: number }> {
  return tdb.pool.withPlatform(async (db) => {
    const txns = await db.query<{ n: string }>("SELECT count(*) AS n FROM ledger_transaction");
    const entries = await db.query<{ n: string }>("SELECT count(*) AS n FROM ledger_entry");
    return { txns: Number(txns.rows[0]!.n), entries: Number(entries.rows[0]!.n) };
  });
}

describe("charge.dispute ingest", () => {
  it("created: kayıt + school eşleşmesi + audit + platform_alert; PARA KIMILDAMAZ", async () => {
    const before = await ledgerCounts();

    const res = await processStripeEvent(tdb.pool, {
      id: "evt_dp_1",
      type: "charge.dispute.created",
      paymentIntentId: "pi_cb_1",
      dispute: { disputeId: "dp_1", amountCents: 50_000, currency: "usd", status: "needs_response" },
    });
    expect(res).toEqual({ duplicate: false });

    const rows = await chargebackRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stripe_event_id: "evt_dp_1",
      stripe_dispute_id: "dp_1",
      payment_intent_id: "pi_cb_1",
      school_id: schoolId,
      currency: "USD",
      status: "needs_response",
    });
    expect(Number(rows[0]!.amount_cents)).toBe(50_000);

    // audit izi + webhook processed
    await tdb.pool.withPlatform(async (db) => {
      const audit = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit_log
          WHERE action = 'chargeback_event' AND after->>'stripe_dispute_id' = 'dp_1'`,
      );
      expect(Number(audit.rows[0]!.n)).toBe(1);
      const wh = await db.query<{ status: string }>(
        "SELECT status FROM webhook_event WHERE provider = 'stripe' AND event_id = 'evt_dp_1'",
      );
      expect(wh.rows[0]!.status).toBe("processed");
    });

    // created → insan alarmı (ALERT_EMAIL alıcısıyla)
    const alerts = await alertRows();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.recipient_email).toBe("cb-alerts@test.example");
    expect(alerts[0]!.payload["kind"]).toBe("chargeback");
    expect(alerts[0]!.payload["checks"]).toEqual(["chargeback_created"]);

    // PARA HAREKETİ YOK: ledger'da tek satır bile açılmadı
    expect(await ledgerCounts()).toEqual(before);
  });

  it("aynı event tekrar gelirse yapısal no-op: duplicate=true, kayıt/alarm çoğalmaz", async () => {
    const res = await processStripeEvent(tdb.pool, {
      id: "evt_dp_1",
      type: "charge.dispute.created",
      paymentIntentId: "pi_cb_1",
      dispute: { disputeId: "dp_1", amountCents: 50_000, currency: "usd" },
    });
    expect(res).toEqual({ duplicate: true });
    expect(await chargebackRows()).toHaveLength(1);
    expect(await alertRows()).toHaveLength(1);
  });

  it("updated: Stripe status'una göre eşlenir (under_review); alarm YAZILMAZ", async () => {
    await processStripeEvent(tdb.pool, {
      id: "evt_dp_2",
      type: "charge.dispute.updated",
      paymentIntentId: "pi_cb_1",
      dispute: { disputeId: "dp_1", amountCents: 50_000, currency: "usd", status: "under_review" },
    });
    const rows = await chargebackRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.stripe_event_id === "evt_dp_2")).toMatchObject({
      stripe_dispute_id: "dp_1",
      status: "under_review",
    });
    expect(await alertRows()).toHaveLength(1); // yalnız created alarmı
  });

  it("closed(lost): status lost + İKİNCİ platform_alert; closed(won) alarm üretmez", async () => {
    await processStripeEvent(tdb.pool, {
      id: "evt_dp_3",
      type: "charge.dispute.closed",
      paymentIntentId: "pi_cb_1",
      dispute: { disputeId: "dp_1", amountCents: 50_000, currency: "usd", status: "lost" },
    });
    const alerts = await alertRows();
    expect(alerts).toHaveLength(2);
    expect(alerts[1]!.payload["checks"]).toEqual(["chargeback_lost"]);

    await processStripeEvent(tdb.pool, {
      id: "evt_dp_4",
      type: "charge.dispute.closed",
      paymentIntentId: "pi_cb_1",
      dispute: { disputeId: "dp_2", amountCents: 10_000, currency: "usd", status: "won" },
    });
    const rows = await chargebackRows();
    expect(rows.find((r) => r.stripe_event_id === "evt_dp_3")!.status).toBe("lost");
    expect(rows.find((r) => r.stripe_event_id === "evt_dp_4")!.status).toBe("won");
    expect(await alertRows()).toHaveLength(2); // won yeni alarm üretmedi
  });

  it("PI eşleşmezse school_id NULL kalır; dispute özeti yoksa skipped", async () => {
    await processStripeEvent(tdb.pool, {
      id: "evt_dp_5",
      type: "charge.dispute.created",
      paymentIntentId: "pi_boyle_biri_yok",
      dispute: { disputeId: "dp_3", amountCents: 7_500, currency: "usd" },
    });
    const rows = await chargebackRows();
    expect(rows.find((r) => r.stripe_dispute_id === "dp_3")!.school_id).toBeNull();

    await processStripeEvent(tdb.pool, {
      id: "evt_dp_6",
      type: "charge.dispute.updated",
      paymentIntentId: "pi_cb_1",
      // dispute özeti yok → kayıt açılamaz, webhook skipped
    });
    await tdb.pool.withPlatform(async (db) => {
      const wh = await db.query<{ status: string }>(
        "SELECT status FROM webhook_event WHERE provider = 'stripe' AND event_id = 'evt_dp_6'",
      );
      expect(wh.rows[0]!.status).toBe("skipped");
    });
  });

  it("tüm süit boyunca ledger boş kaldı + invariant'lar temiz", async () => {
    expect(await ledgerCounts()).toEqual({ txns: 0, entries: 0 });
    await tdb.pool.withPlatform(async (db) => {
      const violations = await db.query("SELECT * FROM ledger_invariant_violations()");
      expect(violations.rows).toEqual([]);
    });
  });
});
