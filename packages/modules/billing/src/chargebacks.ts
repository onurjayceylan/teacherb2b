// Kart itirazı (chargeback) ingest'i — 0014: PARA HAREKETİ YOK, yalnız kayıt + alarm.
// Para düzeltmesi admin'in mevcut reversal yollarıyla yapılır (02-veri-modeli:
// düzeltme=reversal); burada ledger'a ASLA yazılmaz. processStripeEvent'in
// transaction'ı içinde çağrılır — kayıt + audit + alarm ya hep ya hiç.
import type { Db } from "@teachernow/db";
import { enqueueNotification } from "./notifications.js";

export type ChargebackStatus = "needs_response" | "under_review" | "won" | "lost";

/** charge.dispute.* event'lerinde web route'un event.data.object'ten çıkardığı özet. */
export interface StripeDisputeInput {
  /** Stripe dispute id (dp_...) */
  disputeId: string;
  amountCents: number;
  /** Stripe küçük harf gönderir ('usd') — kayıtta büyük harfe çevrilir. */
  currency?: string;
  /** Stripe dispute.status (needs_response, under_review, won, lost, warning_*). */
  status?: string;
}

/**
 * Event tipi + Stripe status'u → bizim durum sözlüğümüz (0014 CHECK):
 * created→needs_response; closed→won/lost (obje status'undan); updated→Stripe
 * status'una göre (bilinmeyen ara durumlar under_review sayılır).
 */
export function mapDisputeStatus(eventType: string, stripeStatus?: string): ChargebackStatus {
  if (eventType === "charge.dispute.created") return "needs_response";
  if (eventType === "charge.dispute.closed") return stripeStatus === "won" ? "won" : "lost";
  switch (stripeStatus) {
    case "needs_response":
    case "warning_needs_response":
      return "needs_response";
    case "won":
      return "won";
    case "lost":
      return "lost";
    default:
      return "under_review";
  }
}

export interface IngestDisputeEventInput {
  /** Stripe event id (evt_...) — chargeback_event idempotency anahtarı. */
  eventId: string;
  eventType: string;
  paymentIntentId?: string;
  dispute: StripeDisputeInput;
}

export interface IngestDisputeEventResult {
  /** false = aynı stripe_event_id daha önce işlendi (yapısal no-op). */
  inserted: boolean;
  chargebackId?: string;
  schoolId: string | null;
  status: ChargebackStatus;
}

export async function ingestDisputeEvent(
  db: Db,
  input: IngestDisputeEventInput,
): Promise<IngestDisputeEventResult> {
  const status = mapDisputeStatus(input.eventType, input.dispute.status);

  // PI→topup eşleşirse school_id dolar; eşleşmezse NULL kalır (platform yine görür).
  let schoolId: string | null = null;
  if (input.paymentIntentId) {
    const topup = await db.query<{ school_id: string }>(
      "SELECT school_id FROM topup_attempt WHERE stripe_payment_intent = $1 LIMIT 1",
      [input.paymentIntentId],
    );
    schoolId = topup.rows[0]?.school_id ?? null;
  }

  // stripe_event_id UNIQUE: aynı event'in tekrarı hiçbir yan etki üretmeden no-op olur.
  // raw'a webhook_event.payload_min disiplinindeki gibi asgari özet yazılır (tam gövde değil).
  const ins = await db.query<{ id: string }>(
    `INSERT INTO chargeback_event
       (stripe_event_id, stripe_dispute_id, payment_intent_id, school_id,
        amount_cents, currency, status, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (stripe_event_id) DO NOTHING
     RETURNING id`,
    [
      input.eventId,
      input.dispute.disputeId,
      input.paymentIntentId ?? null,
      schoolId,
      input.dispute.amountCents,
      (input.dispute.currency ?? "USD").toUpperCase(),
      status,
      JSON.stringify({
        event_type: input.eventType,
        dispute_status: input.dispute.status ?? null,
      }),
    ],
  );
  const row = ins.rows[0];
  if (!row) return { inserted: false, schoolId, status };

  await db.query(
    `INSERT INTO audit_log (actor_kind, school_id, action, entity_type, entity_id, after)
     VALUES ('webhook', $1, 'chargeback_event', 'chargeback_event', $2, $3::jsonb)`,
    [
      schoolId,
      row.id,
      JSON.stringify({
        stripe_event_id: input.eventId,
        stripe_dispute_id: input.dispute.disputeId,
        event_type: input.eventType,
        status,
        amount_cents: input.dispute.amountCents,
      }),
    ],
  );

  // İnsan alarmı: yeni itiraz (created) ve kaybedilen itiraz (lost) outbox'a düşer —
  // sentinel'in P0 deseni: ALERT_EMAIL yoksa placeholder alıcıyla yine yazılır.
  if (input.eventType === "charge.dispute.created" || status === "lost") {
    const alertRecipient = process.env.ALERT_EMAIL ?? "alerts@yerel";
    await enqueueNotification(db, {
      recipientEmail: alertRecipient,
      template: "platform_alert",
      payload: {
        kind: "chargeback",
        checks: [
          input.eventType === "charge.dispute.created" ? "chargeback_created" : "chargeback_lost",
        ],
        detail:
          `dispute=${input.dispute.disputeId} amount_cents=${input.dispute.amountCents} ` +
          `status=${status}` +
          (schoolId ? ` school=${schoolId}` : " school=eşleşmedi"),
      },
    });
  }

  return { inserted: true, chargebackId: row.id, schoolId, status };
}
