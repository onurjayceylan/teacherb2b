// Transactional bildirim outbox'ı (0012): domain yazımıyla AYNI transaction'da INSERT.
// dispatch/notifications.ts'in billing-yerel eşi — modüller birbirini import etmez
// (boundary), desen aynıdır. recipient_email PII'dır: yalnız DB'ye yazılır, ASLA loglanmaz.
import type { Db } from "@teachernow/db";

/** billing'in yazdığı şablonlar (0013 CHECK'inin alt kümesi). */
export type BillingNotificationTemplate = "school_topup_settled" | "platform_alert";

export interface EnqueueNotificationInput {
  recipientEmail: string;
  template: BillingNotificationTemplate;
  payload: Record<string, unknown>;
}

/** Outbox'a tek pending e-posta kaydı açar (çağıranın transaction'ı içinde). */
export async function enqueueNotification(
  db: Db,
  input: EnqueueNotificationInput,
): Promise<void> {
  await db.query(
    `INSERT INTO notification_outbox (channel, recipient_email, template, payload)
     VALUES ('email', $1, $2, $3::jsonb)`,
    [input.recipientEmail, input.template, JSON.stringify(input.payload)],
  );
}
