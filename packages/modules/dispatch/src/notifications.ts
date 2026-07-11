// Transactional bildirim outbox'ı (0012): domain yazımıyla AYNI transaction'da INSERT.
// Gönderim worker dispatcher'ın işi — burada yalnız kayıt açılır. recipient_email PII'dır:
// yalnız DB'ye yazılır, ASLA loglanmaz.
import type { Db } from "@teachernow/db";

export type NotificationTemplate =
  | "teacher_offer"
  | "teacher_invite"
  | "teacher_portal"
  | "school_sla_escalated"
  | "school_low_balance"
  | "teacher_doc_reminder";

export interface EnqueueNotificationInput {
  recipientEmail: string;
  template: NotificationTemplate;
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
