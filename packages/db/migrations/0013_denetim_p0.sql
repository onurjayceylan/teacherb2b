-- 0013: Üç-rol denetiminin P0/P1 düzeltmeleri için şema desteği.
-- (a) bildirim şablon listesi genişler, (b) worker heartbeat (görünmezlik bulgusu),
-- (c) eğitmen payout detayları (Wise hesap bilgisi sistemde tutulmuyordu),
-- (d) settle insan-onay kuyruğu (ders zaman-penceresi bulgusu).

-- (a) notification_outbox.template CHECK'ini genişlet
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'notification_outbox'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%template%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notification_outbox DROP CONSTRAINT %I', c);
  END IF;
END $$;
ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_template_check
  CHECK (template IN (
    'teacher_offer', 'teacher_invite', 'teacher_portal',
    'school_sla_escalated', 'school_low_balance', 'teacher_doc_reminder',
    'teacher_slot_cancelled', 'teacher_interview_scheduled',
    'school_dispute_resolved', 'school_topup_settled',
    'platform_alert'));

-- (b) worker heartbeat: her cron koşumu buraya damga basar; healthz/probe tazeliği denetler.
CREATE TABLE worker_heartbeat (
  job         text PRIMARY KEY,
  last_run_at timestamptz NOT NULL DEFAULT now(),
  last_result jsonb
);
ALTER TABLE worker_heartbeat ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_heartbeat_platform ON worker_heartbeat FOR ALL TO role_platform USING (true);
GRANT SELECT, INSERT, UPDATE ON worker_heartbeat TO role_platform;

-- (c) Eğitmen ödeme hesap bilgisi (Wise e-postası / IBAN vb.) — PII, platform-only;
-- payout CSV'sine buradan taşınır. Okul rolünün teacher'a zaten hiç erişimi yok.
ALTER TABLE teacher ADD COLUMN payout_details jsonb;

-- (d) Settle insan-onayı: zaman-penceresi/süre eşiği ihlalinde ders otomatik settle
-- edilmez; 'ended' kalır + review bayrağıyla admin kuyruğuna düşer.
ALTER TABLE class_session ADD COLUMN review_required boolean NOT NULL DEFAULT false;
ALTER TABLE class_session ADD COLUMN review_reason text;
CREATE INDEX idx_session_review ON class_session (created_at) WHERE review_required;
