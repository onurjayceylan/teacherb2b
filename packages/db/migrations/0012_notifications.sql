-- 0012: transactional bildirim outbox'ı (01-mimari §4 outbox deseni; S3'ün e-posta katmanı).
-- Domain yazımıyla AYNI transaction'da INSERT edilir; worker dispatcher gönderir.
-- RESEND_API_KEY yokken kayıtlar 'pending' birikir (anahtar girilince akar); 7 günden
-- eski pending'ler bayatlamış sayılır (expired) — eski teklifleri sonradan göndermeyiz.

CREATE TABLE notification_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  recipient_email citext NOT NULL,             -- PII: yalnız gönderim için; loglanmaz
  template        text NOT NULL CHECK (template IN (
                  'teacher_offer', 'teacher_invite', 'teacher_portal',
                  'school_sla_escalated', 'school_low_balance', 'teacher_doc_reminder')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- template değişkenleri (token, adlar, tutarlar)
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed', 'expired')),
  attempt         int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX idx_notification_pending ON notification_outbox (created_at)
  WHERE status = 'pending';

ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_notification_platform ON notification_outbox FOR ALL TO role_platform USING (true);
GRANT SELECT, INSERT, UPDATE ON notification_outbox TO role_platform;
