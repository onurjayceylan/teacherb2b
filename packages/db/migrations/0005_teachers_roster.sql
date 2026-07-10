-- 0005: S2 — eğitmen/HR hattı, havuzlar, evrak durum makinesi, İK görüşmesi,
-- isimli roster (çocuk-PII v3) ve Wizard-of-Oz manuel ders kaydı.

-- Havuzlar (Faz-1: native_esl motor + admission_strategist mıknatıs)
CREATE TABLE pool (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL UNIQUE,
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pool (key, name) VALUES
  ('native_esl', 'Native ESL Speaking Club'),
  ('admission_strategist', 'Admission Strategist');

-- Eğitmen: platform-scoped varlık (havuz tenant'lar-arası). Okul bu tabloyu GÖRMEZ —
-- okul-yüzlü maskeli profil (ad+pool+vetting rozetleri) S3'te ayrı view ile açılır.
CREATE TABLE teacher (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         text NOT NULL,             -- PII
  email             citext NOT NULL UNIQUE,    -- PII
  phone             text,                      -- PII
  country           char(2),
  timezone          text NOT NULL DEFAULT 'Europe/Istanbul',
  source            text NOT NULL CHECK (source IN ('site', 'ilan', 'hrmasterz')),
  status            text NOT NULL DEFAULT 'invited' CHECK (status IN
                    ('invited', 'profile', 'docs_pending', 'interview', 'active', 'rejected', 'suspended')),
  -- İki bağımsız kapı (plan #5 hibrit karar): dispatch import'la hemen açılabilir,
  -- payout YALNIZ evrak setinin tamamı verified olunca (trigger hesaplar) açılır.
  dispatch_ready    boolean NOT NULL DEFAULT false,
  payout_ready      boolean NOT NULL DEFAULT false,
  hourly_cost_cents bigint,                    -- okul ASLA görmez (disintermediation)
  notes             text,
  invited_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_teacher_status ON teacher (status);
CREATE INDEX idx_teacher_source ON teacher (source);

-- Pipeline geçiş whitelist'i: durum makinesi delik bırakmaz (03 kabul kriteri).
CREATE OR REPLACE FUNCTION teacher_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'invited'      AND NEW.status IN ('profile', 'active', 'rejected')) OR -- 'active': toplu import yolu
    (OLD.status = 'profile'      AND NEW.status IN ('docs_pending', 'rejected')) OR
    (OLD.status = 'docs_pending' AND NEW.status IN ('interview', 'rejected')) OR
    (OLD.status = 'interview'    AND NEW.status IN ('active', 'rejected')) OR
    (OLD.status = 'active'       AND NEW.status = 'suspended') OR
    (OLD.status = 'suspended'    AND NEW.status = 'active')
  ) THEN
    RAISE EXCEPTION 'teacher: geçersiz durum geçişi % → %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_teacher_status BEFORE UPDATE OF status ON teacher
  FOR EACH ROW EXECUTE FUNCTION teacher_status_transition();

CREATE TABLE teacher_pool (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES teacher(id),
  pool_id    uuid NOT NULL REFERENCES pool(id),
  level      text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, pool_id)
);
CREATE INDEX idx_teacher_pool_pool ON teacher_pool (pool_id) WHERE active;

-- Evrak seti: payout hard-gate'inin veri tabanı. PII vendor'da kalır (bizde yalnız status+ref).
CREATE TABLE teacher_document (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid NOT NULL REFERENCES teacher(id),
  kind        text NOT NULL CHECK (kind IN
              ('contract', 'id_verification', 'country_clearance', 'tax_form', 'payout_method')),
  status      text NOT NULL DEFAULT 'missing'
              CHECK (status IN ('missing', 'submitted', 'verified', 'rejected', 'expired')),
  vendor      text,          -- persona | docusign | manual ...
  vendor_ref  text,          -- vendor tarafındaki kayıt işaretçisi (PII bizde durmaz)
  note        text,
  valid_until date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, kind)
);
CREATE INDEX idx_teacher_document_teacher ON teacher_document (teacher_id);

-- payout_ready TÜRETİLİR, elle yazılamaz: zorunlu evrak setinin tamamı 'verified' olmalı.
CREATE OR REPLACE FUNCTION recompute_teacher_payout_ready() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t_id uuid := COALESCE(NEW.teacher_id, OLD.teacher_id);
  ready boolean;
BEGIN
  SELECT COUNT(*) FILTER (WHERE kind IN ('contract', 'id_verification', 'country_clearance', 'tax_form', 'payout_method')
                            AND status = 'verified') = 5
    INTO ready
    FROM teacher_document WHERE teacher_id = t_id;
  UPDATE teacher SET payout_ready = COALESCE(ready, false), updated_at = now() WHERE id = t_id;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_teacher_doc_payout_gate
  AFTER INSERT OR UPDATE OR DELETE ON teacher_document
  FOR EACH ROW EXECUTE FUNCTION recompute_teacher_payout_ready();

-- Merkezi İK görüşmesi (kurucu kararı: zorunlu insan adımı; agent etrafını otomatize eder)
CREATE TABLE hr_interview (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id          uuid NOT NULL REFERENCES teacher(id),
  scheduled_at        timestamptz,
  interviewer_user_id uuid REFERENCES app_user(id),
  status              text NOT NULL DEFAULT 'scheduled'
                      CHECK (status IN ('scheduled', 'done', 'no_show', 'cancelled')),
  experience_score    int CHECK (experience_score BETWEEN 1 AND 5),
  energy_score        int CHECK (energy_score BETWEEN 1 AND 5),
  scores              jsonb,          -- serbest skor kartı (agent taslağı + insan düzeltmesi)
  decision            text CHECK (decision IN ('accept', 'reject', 'hold')),
  decided_pool_id     uuid REFERENCES pool(id),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_hr_interview_teacher ON hr_interview (teacher_id);
CREATE INDEX idx_hr_interview_open ON hr_interview (scheduled_at) WHERE status = 'scheduled';

-- ---- Roster (çocuk-PII v3): yalnız ad + sınıf; doğum tarihi/iletişim/veli TOPLANMAZ ----
CREATE TABLE class_group (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES school(id),
  name       text NOT NULL,
  level      text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX class_group_name_uq ON class_group (school_id, name) WHERE active;

CREATE TABLE student (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES school(id),
  class_group_id uuid REFERENCES class_group(id),
  full_name      text NOT NULL,      -- PII (yalnız ad-soyad; saklama politikası: dönem + 6 ay)
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz
);
CREATE INDEX idx_student_school ON student (school_id) WHERE status = 'active';
CREATE INDEX idx_student_class ON student (class_group_id) WHERE status = 'active';

-- ---- Wizard-of-Oz manuel ders kaydı (S2-S3 köprüsü): gerçek ücretli ders, ledger disipliniyle ----
CREATE TABLE manual_lesson_charge (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES school(id),
  teacher_id        uuid NOT NULL REFERENCES teacher(id),
  class_group_id    uuid REFERENCES class_group(id),
  lesson_date       date NOT NULL,
  minutes           int NOT NULL CHECK (minutes > 0),
  charge_cents      bigint NOT NULL CHECK (charge_cents > 0),      -- okuldan düşülen (satış)
  teacher_pay_cents bigint NOT NULL CHECK (teacher_pay_cents >= 0), -- eğitmen alacağı (maliyet)
  txn_id            uuid REFERENCES ledger_transaction(id),
  note              text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (teacher_pay_cents <= charge_cents)  -- negatif marj yapısal temsil edilemez
);
CREATE INDEX idx_manual_lesson_school ON manual_lesson_charge (school_id, lesson_date);
CREATE INDEX idx_manual_lesson_teacher ON manual_lesson_charge (teacher_id, lesson_date);

-- ---- RLS ----
ALTER TABLE teacher              ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_pool         ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_document     ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_interview         ENABLE ROW LEVEL SECURITY;
ALTER TABLE pool                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_group          ENABLE ROW LEVEL SECURITY;
ALTER TABLE student              ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_lesson_charge ENABLE ROW LEVEL SECURITY;

-- Eğitmen/HR tabloları: yalnız platform (okul eğitmenin maliyetini/iletişimini asla görmez).
CREATE POLICY p_teacher_platform ON teacher FOR ALL TO role_platform USING (true);
CREATE POLICY p_teacher_pool_platform ON teacher_pool FOR ALL TO role_platform USING (true);
CREATE POLICY p_teacher_doc_platform ON teacher_document FOR ALL TO role_platform USING (true);
CREATE POLICY p_hr_interview_platform ON hr_interview FOR ALL TO role_platform USING (true);
CREATE POLICY p_pool_platform ON pool FOR ALL TO role_platform USING (true);
CREATE POLICY p_pool_school_read ON pool FOR SELECT TO role_school USING (active);

-- Roster: okul kendi verisinin sahibi; platform destek için okur.
CREATE POLICY p_class_group_school ON class_group FOR ALL TO role_school
  USING (school_id = ANY (app_school_ids())) WITH CHECK (school_id = ANY (app_school_ids()));
CREATE POLICY p_class_group_platform ON class_group FOR SELECT TO role_platform USING (true);
CREATE POLICY p_student_school ON student FOR ALL TO role_school
  USING (school_id = ANY (app_school_ids())) WITH CHECK (school_id = ANY (app_school_ids()));
CREATE POLICY p_student_platform ON student FOR SELECT TO role_platform USING (true);

-- WoZ ders kaydı: platform yazar; okul kendi kayıtlarını maliyet KOLONU OLMADAN okur (kolon-grant).
CREATE POLICY p_manual_lesson_platform ON manual_lesson_charge FOR ALL TO role_platform USING (true);
CREATE POLICY p_manual_lesson_school ON manual_lesson_charge FOR SELECT TO role_school
  USING (school_id = ANY (app_school_ids()));

-- ---- Grant'ler ----
GRANT SELECT, INSERT, UPDATE ON teacher, teacher_pool, teacher_document, hr_interview, pool
  TO role_platform;
GRANT SELECT (id, key, name, active) ON pool TO role_school;
GRANT SELECT, INSERT, UPDATE ON class_group, student TO role_school;
GRANT SELECT ON class_group, student TO role_platform;
GRANT SELECT, INSERT ON manual_lesson_charge TO role_platform;
-- Okul ders kaydında SATIŞI görür, eğitmen MALİYETİNİ asla (teacher_pay_cents grant dışı):
GRANT SELECT (id, school_id, class_group_id, lesson_date, minutes, charge_cents, note, created_at)
  ON manual_lesson_charge TO role_school;
