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
}

export interface StripeEventResult {
  duplicate: boolean;
  settledTopupId?: string;
}

async function markWebhook(db: Db, webhookId: string, status: "processed" | "skipped"): Promise<void> {
  await db.query(
    "UPDATE webhook_event SET status = $2, processed_at = now() WHERE id = $1",
    [webhookId, status],
  );
}

/**
 * Aynı event ikinci kez gelirse hiçbir yan etki üretmeden { duplicate: true } döner:
 * idempotency insert'i işlemeyle aynı transaction'da olduğu için yarım işleme kalamaz.
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

    if (evt.type !== "payment_intent.succeeded") {
      await markWebhook(db, webhookId, "skipped");
      return { duplicate: false };
    }

    let topup:
      | { id: string; school_id: string; amount_cents: string; currency: string }
      | undefined;
    if (evt.paymentIntentId) {
      const res = await db.query<{
        id: string;
        school_id: string;
        amount_cents: string;
        currency: string;
      }>(
        `SELECT id, school_id, amount_cents, currency
           FROM topup_attempt WHERE stripe_payment_intent = $1 FOR UPDATE`,
        [evt.paymentIntentId],
      );
      topup = res.rows[0];
    }
    if (!topup) {
      await markWebhook(db, webhookId, "skipped");
      return { duplicate: false };
    }

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
    await markWebhook(db, webhookId, "processed");
    return { duplicate: false, settledTopupId: topup.id };
  });
}
