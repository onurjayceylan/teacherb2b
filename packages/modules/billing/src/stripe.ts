// Stripe webhook ingest'i: (provider, event_id) idempotency insert'i + işleme AYNI transaction'da.
import Stripe from "stripe";
import type { ActorPool, Db } from "@teachernow/db";
import { ensureAccount, postTxn } from "./ledger.js";

// Yalnız imza doğrulama için; hiçbir API çağrısı yapılmaz.
const stripeStatic = new Stripe("sk_test_dummy");

export function verifyStripeWebhook(rawBody: string, signature: string, secret: string): Stripe.Event {
  return stripeStatic.webhooks.constructEvent(rawBody, signature, secret);
}

export interface StripeEventInput {
  id: string;
  type: string;
  paymentIntentId?: string;
  /** checkout.session.* event'lerinde session id (topup'ı bununla buluruz). */
  checkoutSessionId?: string;
  /** checkout.session.completed'daki payment_status: 'paid' | 'unpaid' | 'no_payment_required'. */
  paymentStatus?: string;
}

export interface StripeEventResult {
  duplicate: boolean;
  settledTopupId?: string;
}

interface TopupRow {
  id: string;
  school_id: string;
  amount_cents: string;
  currency: string;
  status: string;
  stripe_payment_intent: string | null;
}

const TOPUP_COLS = "id, school_id, amount_cents, currency, status, stripe_payment_intent";

async function markWebhook(db: Db, webhookId: string, status: "processed" | "skipped"): Promise<void> {
  await db.query(
    "UPDATE webhook_event SET status = $2, processed_at = now() WHERE id = $1",
    [webhookId, status],
  );
}

/**
 * Settle idempotenttir iki katmanda: (1) status='settled' guard'ı — aynı topup için ikinci
 * event (örn. checkout.completed sonrası payment_intent.succeeded) para yolunu hiç açmaz;
 * (2) post_ledger_txn'in 'topup:{id}' key'i — guard bir yarışta kaçsa bile çift bakiye imkânsız.
 */
async function settleTopup(db: Db, topup: TopupRow): Promise<{ settled: boolean }> {
  if (topup.status === "settled") return { settled: false };

  const cashId = await ensureAccount(db, "school", topup.school_id, "school_cash", topup.currency);
  const clearingId = await ensureAccount(db, "platform", null, "stripe_clearing", topup.currency);
  const { txnId } = await postTxn(db, {
    key: `topup:${topup.id}`,
    type: "topup",
    refType: "topup_attempt",
    refId: topup.id,
    entries: [
      { accountId: cashId, amountCents: topup.amount_cents },
      { accountId: clearingId, amountCents: `-${topup.amount_cents}` },
    ],
  });

  await db.query(
    `UPDATE topup_attempt
        SET status = 'settled', settled_txn_id = $2, settled_at = now(), updated_at = now()
      WHERE id = $1`,
    [topup.id, txnId],
  );
  return { settled: true };
}

/**
 * Aynı event ikinci kez gelirse hiçbir yan etki üretmeden { duplicate: true } döner:
 * idempotency insert'i işlemeyle aynı transaction'da olduğu için yarım işleme kalamaz.
 *
 * Kart akışının iki yolu vardır ve ikisi de settle edebilir (hangisi önce gelirse):
 * - checkout.session.completed (payment_status='paid'): topup'ı checkout id ile bulur,
 *   payment_intent'i bağlar ve settle eder. Asenkron ödeme yöntemlerinde 'unpaid' gelir —
 *   yalnız payment_intent bağlanır, settle'ı payment_intent.succeeded yapar.
 * - payment_intent.succeeded: topup'ı payment_intent ile bulur ve settle eder.
 */
export async function processStripeEvent(
  pool: ActorPool,
  evt: StripeEventInput,
): Promise<StripeEventResult> {
  return pool.withPlatform(async (db) => {
    const ins = await db.query<{ id: string }>(
      `INSERT INTO webhook_event (provider, event_id, kind, payload_min)
       VALUES ('stripe', $1, $2, $3::jsonb)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      [evt.id, evt.type, JSON.stringify({ type: evt.type })],
    );
    const webhookRow = ins.rows[0];
    if (!webhookRow) return { duplicate: true };
    const webhookId = webhookRow.id;

    if (evt.type === "checkout.session.completed") {
      let topup: TopupRow | undefined;
      if (evt.checkoutSessionId) {
        const res = await db.query<TopupRow>(
          `SELECT ${TOPUP_COLS} FROM topup_attempt WHERE stripe_checkout_id = $1 FOR UPDATE`,
          [evt.checkoutSessionId],
        );
        topup = res.rows[0];
      }
      if (!topup) {
        await markWebhook(db, webhookId, "skipped");
        return { duplicate: false };
      }

      // payment_intent'i bağla: 'unpaid' senaryosunda settle'ı PI.succeeded'ın bulabilmesi için şart.
      if (evt.paymentIntentId && !topup.stripe_payment_intent) {
        await db.query(
          `UPDATE topup_attempt SET stripe_payment_intent = $2, updated_at = now() WHERE id = $1`,
          [topup.id, evt.paymentIntentId],
        );
      }

      if (evt.paymentStatus === "paid") {
        const { settled } = await settleTopup(db, topup);
        await markWebhook(db, webhookId, "processed");
        return settled ? { duplicate: false, settledTopupId: topup.id } : { duplicate: false };
      }
      await markWebhook(db, webhookId, "processed");
      return { duplicate: false };
    }

    if (evt.type === "payment_intent.succeeded") {
      let topup: TopupRow | undefined;
      if (evt.paymentIntentId) {
        const res = await db.query<TopupRow>(
          `SELECT ${TOPUP_COLS} FROM topup_attempt WHERE stripe_payment_intent = $1 FOR UPDATE`,
          [evt.paymentIntentId],
        );
        topup = res.rows[0];
      }
      if (!topup) {
        await markWebhook(db, webhookId, "skipped");
        return { duplicate: false };
      }
      const { settled } = await settleTopup(db, topup);
      await markWebhook(db, webhookId, "processed");
      return settled ? { duplicate: false, settledTopupId: topup.id } : { duplicate: false };
    }

    await markWebhook(db, webhookId, "skipped");
    return { duplicate: false };
  });
}
