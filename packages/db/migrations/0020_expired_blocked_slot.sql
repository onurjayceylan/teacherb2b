-- 0020: Denetim tur 3 [P2] — geçmiş-tarihli bloke slotlar STRANDED kalmasın (süresi dolar).
-- Sorun: retryBlockedSlots yalnız starts_at > now bloke slotları açar; okul bakiyeyi ders
-- gününden SONRA yüklerse slot 'blocked_insufficient_funds'ta sonsuza dek kalır — ne denenir
-- ne temizlenir, e-posta da (bilinçli) ölü olduğundan okul dersin hiç yapılmadığını öğrenmez.
-- Bloke slotta HOLD YOKTUR (bakiye yetmediği için hiç alınmadı) → para etkisi SIFIR; kapanış
-- yalnız durum geçişidir. Yeni terminal durum 'expired_blocked' + geçiş whitelist'i eklenir.
ALTER TABLE booking_slot DROP CONSTRAINT IF EXISTS booking_slot_status_check;
ALTER TABLE booking_slot ADD CONSTRAINT booking_slot_status_check
  CHECK (status IN (
    'scheduled', 'blocked_insufficient_funds',
    'cancelled_school_early', 'cancelled_school_late',
    'cancelled_teacher', 'no_show_teacher', 'completed', 'escalated',
    'voided_review', 'expired_blocked'));

-- Geçiş whitelist'i: blocked_insufficient_funds → expired_blocked (yalnız sweeper kullanır).
CREATE OR REPLACE FUNCTION booking_slot_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'scheduled' AND NEW.status IN
      ('cancelled_school_early', 'cancelled_school_late', 'cancelled_teacher',
       'no_show_teacher', 'completed', 'escalated', 'voided_review')) OR
    (OLD.status = 'blocked_insufficient_funds' AND NEW.status IN
      ('scheduled', 'cancelled_school_early', 'expired_blocked')) OR
    (OLD.status = 'cancelled_teacher' AND NEW.status IN ('scheduled', 'escalated'))
  ) THEN
    RAISE EXCEPTION 'booking_slot: geçersiz durum geçişi % → %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
