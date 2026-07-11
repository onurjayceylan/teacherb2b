-- 0016: İkinci üç-rol denetiminin (docs/denetim-3-rol-tur2.md) P0/P1 düzeltmeleri için şema.
-- (a) eğitmen ödeme-düzeltme bildirimi (P1-A clawback şeffaflığı + P1-B ret bilgisi),
-- (b) reddedilen settle'ın para çözümü: slot 'voided_review' terminal durumu (P1-B),
-- (c) reddedilme işareti: hangi ended session'ın çözüm beklediğini ayırt eder (P1-B),
-- (d) bloke slot retry taraması için kısmi indeks (P0-B).

-- (a) notification_outbox.template CHECK genişler
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
    'platform_alert', 'teacher_payment_adjusted'));

-- (b) booking_slot durum listesi += 'voided_review' (geçmişte kalmış, settle'ı REDDEDİLMİŞ
-- dersin admin kararıyla kapanışı: hold okula TAM iade edilir, ders hiç ücretlendirilmez).
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'booking_slot'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%scheduled%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE booking_slot DROP CONSTRAINT %I', c);
  END IF;
END $$;
ALTER TABLE booking_slot ADD CONSTRAINT booking_slot_status_check
  CHECK (status IN (
    'scheduled', 'blocked_insufficient_funds',
    'cancelled_school_early', 'cancelled_school_late',
    'cancelled_teacher', 'no_show_teacher', 'completed', 'escalated',
    'voided_review'));

-- Geçiş whitelist'i: scheduled → voided_review eklenir (yalnız admin çözüm yolu kullanır).
CREATE OR REPLACE FUNCTION booking_slot_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'scheduled' AND NEW.status IN
      ('cancelled_school_early', 'cancelled_school_late', 'cancelled_teacher',
       'no_show_teacher', 'completed', 'escalated', 'voided_review')) OR
    (OLD.status = 'blocked_insufficient_funds' AND NEW.status IN ('scheduled', 'cancelled_school_early')) OR
    (OLD.status = 'cancelled_teacher' AND NEW.status IN ('scheduled', 'escalated'))
  ) THEN
    RAISE EXCEPTION 'booking_slot: geçersiz durum geçişi % → %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- (c) settle-reddi işareti: reject anında damgalanır; slot voided/iade edilince liste
-- sorgusu slot durumundan düşürür (kolon tarihçe olarak kalır).
ALTER TABLE class_session ADD COLUMN review_rejected_at timestamptz;

-- (d) P0-B: bloke slot retry taraması (backfill-sweeper her koşumda okur).
CREATE INDEX idx_slot_blocked_retry ON booking_slot (school_id, starts_at)
  WHERE status = 'blocked_insufficient_funds';
