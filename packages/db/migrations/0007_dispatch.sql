-- 0007: S3 dispatch çekirdeği — availability, dosaj reçetesi, materialize slot + hold,
-- assignment (EXCLUDE ile çift-booking imkânsız), teklif token'ı, strike sayacı.

-- Eğitmen strike sayacı (no-show matrisi: 3 strike = havuzdan çıkarma)
ALTER TABLE teacher ADD COLUMN strike_count int NOT NULL DEFAULT 0;

-- Haftalık müsaitlik pencereleri — pencere KENDİ timezone'unu taşır (eğitmen taşınırsa eski
-- pencereler anlam kaybetmesin); dakika cinsinden duvar saati.
CREATE TABLE teacher_availability (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id   uuid NOT NULL REFERENCES teacher(id),
  weekday      int NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0=Pazartesi (ISO)
  start_minute int NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   int NOT NULL CHECK (end_minute > start_minute AND end_minute <= 1440),
  timezone     text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_availability_teacher ON teacher_availability (teacher_id) WHERE active;

-- Dosaj reçetesi: "bu sınıfa, bu havuzdan, her hafta şu gün-saatte, N hafta".
-- Fiyat REÇETEDE sabitlenir (fiyat kartı snapshot'ı): zam mevcut taahhüde ulaşmaz.
CREATE TABLE dosage_plan (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES school(id),
  class_group_id    uuid NOT NULL REFERENCES class_group(id),
  pool_id           uuid NOT NULL REFERENCES pool(id),
  weekday           int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute      int NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  duration_min      int NOT NULL CHECK (duration_min BETWEEN 15 AND 240),
  school_tz         text NOT NULL,
  price_cents       bigint NOT NULL CHECK (price_cents > 0),
  teacher_pay_cents bigint NOT NULL CHECK (teacher_pay_cents >= 0 AND teacher_pay_cents <= price_cents),
  start_date        date NOT NULL,
  weeks             int NOT NULL CHECK (weeks BETWEEN 1 AND 52),
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_dosage_plan_school ON dosage_plan (school_id) WHERE status = 'active';

-- Pause/skip-week primitifi (tatil/sınav haftası — kurucu onaylı, koşulsuz Faz-1)
CREATE TABLE plan_exception (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id    uuid NOT NULL REFERENCES dosage_plan(id),
  skip_date  date NOT NULL,          -- okul-lokal occurrence tarihi
  reason     text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, skip_date)
);

-- Materialize edilmiş ders slotu. Occurrence kimliği DUVAR SAATİ tarihidir (DST/tz
-- değişimi çift kayıt üretmez); UNIQUE(plan_id, occurrence_key) materializer'ı idempotent kılar.
CREATE TABLE booking_slot (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id            uuid NOT NULL REFERENCES school(id),
  plan_id              uuid NOT NULL REFERENCES dosage_plan(id),
  class_group_id       uuid NOT NULL REFERENCES class_group(id),
  pool_id              uuid NOT NULL REFERENCES pool(id),
  occurrence_key       date NOT NULL,             -- okul-lokal ders tarihi
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL CHECK (ends_at > starts_at),
  price_cents          bigint NOT NULL CHECK (price_cents > 0),
  teacher_pay_cents    bigint NOT NULL CHECK (teacher_pay_cents >= 0 AND teacher_pay_cents <= price_cents),
  status               text NOT NULL DEFAULT 'scheduled' CHECK (status IN (
                       'scheduled',                    -- hold açık, eğitmen aranıyor/atandı
                       'blocked_insufficient_funds',   -- bakiye yetmedi; dispatch bu okulda durdu
                       'cancelled_school_early',       -- ≥24s: ücretsiz
                       'cancelled_school_late',        -- <24s: %50 kesinti
                       'cancelled_teacher',            -- eğitmen düştü (re-offer/backfill konusu)
                       'no_show_teacher',              -- %100 iade + strike
                       'completed',                    -- settle S4'te hold→charge yapar
                       'escalated')),
  hold_txn_id          uuid REFERENCES ledger_transaction(id),
  hold_released_txn_id uuid REFERENCES ledger_transaction(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, occurrence_key)
);
CREATE INDEX idx_slot_school_time ON booking_slot (school_id, starts_at);
CREATE INDEX idx_slot_needs_teacher ON booking_slot (starts_at) WHERE status = 'scheduled';

-- Slot durum makinesi: whitelist dışı geçiş yok (para etkileri modülde, geçiş güvenliği DB'de).
CREATE OR REPLACE FUNCTION booking_slot_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'scheduled' AND NEW.status IN
      ('cancelled_school_early', 'cancelled_school_late', 'cancelled_teacher',
       'no_show_teacher', 'completed', 'escalated')) OR
    (OLD.status = 'blocked_insufficient_funds' AND NEW.status IN ('scheduled', 'cancelled_school_early')) OR
    (OLD.status = 'cancelled_teacher' AND NEW.status IN ('scheduled', 'escalated'))  -- re-offer/backfill
  ) THEN
    RAISE EXCEPTION 'booking_slot: geçersiz durum geçişi % → %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_booking_slot_status BEFORE UPDATE OF status ON booking_slot
  FOR EACH ROW EXECUTE FUNCTION booking_slot_transition();

-- Atama + teklif. starts/ends denormu exclusion constraint içindir.
CREATE TABLE assignment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id          uuid NOT NULL REFERENCES booking_slot(id),
  teacher_id       uuid NOT NULL REFERENCES teacher(id),
  status           text NOT NULL DEFAULT 'offered' CHECK (status IN
                   ('offered', 'confirmed', 'declined', 'expired', 'dropped', 'cancelled')),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  offer_token_hash text UNIQUE,                -- imzalı e-posta linki için (login'siz kabul/red)
  offer_expires_at timestamptz,
  responded_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- ÇİFT BOOKING FİZİKSEL İMKÂNSIZ: aynı eğitmen, çakışan zaman aralığı, canlı statü.
ALTER TABLE assignment ADD CONSTRAINT assignment_no_overlap EXCLUDE USING gist
  (teacher_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status IN ('offered', 'confirmed'));
-- Slot başına tek canlı atama:
CREATE UNIQUE INDEX assignment_active_per_slot ON assignment (slot_id)
  WHERE status IN ('offered', 'confirmed');
CREATE INDEX idx_assignment_teacher ON assignment (teacher_id, status);
CREATE INDEX idx_assignment_offer_timeout ON assignment (offer_expires_at)
  WHERE status = 'offered';

-- Atama durum makinesi: her geçiş modülde CAS'la yapılır, whitelist DB'de.
CREATE OR REPLACE FUNCTION assignment_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'offered'   AND NEW.status IN ('confirmed', 'declined', 'expired', 'cancelled')) OR
    (OLD.status = 'confirmed' AND NEW.status IN ('dropped', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'assignment: geçersiz durum geçişi % → %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_assignment_status BEFORE UPDATE OF status ON assignment
  FOR EACH ROW EXECUTE FUNCTION assignment_transition();

-- ---- RLS ----
ALTER TABLE teacher_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE dosage_plan          ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_exception       ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_slot         ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment           ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_availability_platform ON teacher_availability FOR ALL TO role_platform USING (true);
CREATE POLICY p_dosage_platform ON dosage_plan FOR ALL TO role_platform USING (true);
CREATE POLICY p_dosage_school ON dosage_plan FOR ALL TO role_school
  USING (school_id = ANY (app_school_ids())) WITH CHECK (school_id = ANY (app_school_ids()));
CREATE POLICY p_plan_exc_platform ON plan_exception FOR ALL TO role_platform USING (true);
CREATE POLICY p_plan_exc_school ON plan_exception FOR ALL TO role_school
  USING (EXISTS (SELECT 1 FROM dosage_plan p WHERE p.id = plan_id AND p.school_id = ANY (app_school_ids())))
  WITH CHECK (EXISTS (SELECT 1 FROM dosage_plan p WHERE p.id = plan_id AND p.school_id = ANY (app_school_ids())));
CREATE POLICY p_slot_platform ON booking_slot FOR ALL TO role_platform USING (true);
CREATE POLICY p_slot_school_read ON booking_slot FOR SELECT TO role_school
  USING (school_id = ANY (app_school_ids()));
CREATE POLICY p_assignment_platform ON assignment FOR ALL TO role_platform USING (true);

-- ---- Grant'ler ----
GRANT SELECT, INSERT, UPDATE ON teacher_availability, assignment TO role_platform;
GRANT SELECT, INSERT, UPDATE ON dosage_plan, plan_exception, booking_slot TO role_platform;
GRANT SELECT, INSERT, UPDATE (status, updated_at) ON dosage_plan TO role_school;
GRANT SELECT, INSERT ON plan_exception TO role_school;
-- Okul slotları görür; eğitmen maliyet kolonu (teacher_pay_cents) okula KAPALI:
GRANT SELECT (id, school_id, plan_id, class_group_id, pool_id, occurrence_key,
              starts_at, ends_at, price_cents, status, created_at)
  ON booking_slot TO role_school;
