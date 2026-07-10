// Stripe webhook ingest'i: ham gövde + imza doğrulama → tek-transaction idempotent işleme.
// Başarıyla işlenen (duplicate dahil) her event 200 döner; imza hatası 400, sır yoksa 503.
import { processStripeEvent, verifyStripeWebhook } from "@teachernow/billing";
import { getPool } from "../../../../lib/pool";

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: "stripe webhook yapılandırılmadı" }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "stripe-signature başlığı eksik" }, { status: 400 });
  }

  const rawBody = await req.text();
  let event;
  try {
    event = verifyStripeWebhook(rawBody, signature, secret);
  } catch {
    return Response.json({ error: "imza doğrulanamadı" }, { status: 400 });
  }

  // payment_intent alanı olmayan event'lerde nesnenin kendi id'si denenir (skip edilir).
  const obj = event.data.object as { payment_intent?: string | null; id?: string };
  const paymentIntentId =
    typeof obj.payment_intent === "string" ? obj.payment_intent : obj.id;

  try {
    const result = await processStripeEvent(getPool(), {
      id: event.id,
      type: event.type,
      ...(paymentIntentId ? { paymentIntentId } : {}),
    });
    // Duplicate = yapısal no-op; Stripe'a yine 200 (tekrar denemesin).
    return Response.json({ received: true, duplicate: result.duplicate });
  } catch {
    // İşleme hatası: 500 → Stripe tekrar dener; idempotency yarım işlemeyi engeller.
    return Response.json({ error: "event işlenemedi" }, { status: 500 });
  }
}
