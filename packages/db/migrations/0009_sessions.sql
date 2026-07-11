-- 0009: S4 — ders oturumu, append-only session_event (ödeme trigger'ının TEK kaynağı),
-- isimli yoklama, eğitmen portal token'ı, dispute.

CREATE TABLE class_session (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id        uuid NOT NULL UNIQUE REFERENCES booking_slot(id),
  school_id      uuid NOT NULL REFERENCES school(id),
  teacher_id     uuid NOT NULL REFERENCES teacher(id),
  class_group_id uuid NOT NULL REFERENCES class_group(id),
  video_provider text NOT NULL DEFAULT 'manual' CHECK (video_provider IN ('manual', 'superclass')),
  provider_ref   text,
  status         text NOT NULL DEFAULT 'created'
                 CHECK (status IN ('created', 'started', 'ended', 'settled')),
  started_at     timestamptz,
  ended_at       timestamptz,
  dosage_min     int CHECK (dosage_min IS NULL OR dosage_min >= 0),
  settle_txn_id  uuid REFERENCES ledger_transaction(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_session_school ON class_session (school_id, created_at);
CREATE INDEX idx_session_teacher ON class_session (teacher_id, created_at);
CREATE INDEX idx_session_unsettled ON class_session (ended_at) WHERE status = 'ended';

CREATE OR REPLACE FUNCTION class_session_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'created' AND NEW.status = 'started') OR
    (OLD.status = 'started' AND NEW.status = 'ended') OR
    (OLD.status = 'ended'   AND NEW.status = 'settled')
  ) THEN
    RAISE EXCEPTION 'class_session: geçersiz durum geçişi % → %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_class_session_status BEFORE UPDATE OF status ON class_session
  FOR EACH ROW EXECUTE FUNCTION class_session_transition();

-- Settle sonrası mali alanlar donuk (02 sınıf-2 değişmezlik):
CREATE OR REPLACE FUNCTION class_session_freeze_after_settle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'settled' AND (
       NEW.dosage_min IS DISTINCT FROM OLD.dosage_min
       OR NEW.settle_txn_id IS DISTINCT FROM OLD.settle_txn_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.ended_at IS DISTINCT FROM OLD.ended_at) THEN
    RAISE EXCEPTION 'class_session: settle sonrası dosaj/zaman alanları donuk';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_class_session_freeze BEFORE UPDATE ON class_session
  FOR EACH ROW EXECUTE FUNCTION class_session_freeze_after_settle();

-- Ödeme trigger'ının tek kaynağı: append-only olay logu (harici provider olsa bile burası yazılır).
CREATE TABLE session_event (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES class_session(id),
  kind        text NOT NULL CHECK (kind IN ('join', 'leave', 'check_in', 'check_out', 'heartbeat', 'note')),
  role        text NOT NULL CHECK (role IN ('teacher', 'class', 'system')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  meta        jsonb
);
CREATE INDEX idx_session_event_session ON session_event (session_id, occurred_at);
CREATE TRIGGER trg_session_event_append_only
  BEFORE UPDATE OR DELETE ON session_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- İsimli yoklama (kurucu kararı #4): eğitmen roster checklist'inden işaretler.
CREATE TABLE session_attendance (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES class_session(id),
  student_id uuid NOT NULL REFERENCES student(id),
  present    boolean NOT NULL,
  marked_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, student_id)
);

-- Eğitmen paneli (login'siz, kalıcı imzalı link — davet deseninin devamı)
CREATE TABLE teacher_portal_token (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES teacher(id),
  token_hash text NOT NULL UNIQUE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_portal_token_teacher ON teacher_portal_token (teacher_id);

-- Okul itirazı: karar Faz-1'de insanda (kurucu), para düzeltmesi daima ters kayıtla.
CREATE TABLE session_dispute (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL REFERENCES class_session(id),
  school_id       uuid NOT NULL REFERENCES school(id),
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'resolved_refund', 'rejected')),
  resolution_note text,
  refund_txn_id   uuid REFERENCES ledger_transaction(id),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX idx_dispute_open ON session_dispute (created_at) WHERE status = 'open';

-- ---- RLS ----
ALTER TABLE class_session       ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_event       ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_attendance  ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_portal_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_dispute     ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_session_platform ON class_session FOR ALL TO role_platform USING (true);
CREATE POLICY p_session_school_read ON class_session FOR SELECT TO role_school
  USING (school_id = ANY (app_school_ids()));
CREATE POLICY p_sevent_platform ON session_event FOR ALL TO role_platform USING (true);
CREATE POLICY p_sattendance_platform ON session_attendance FOR ALL TO role_platform USING (true);
CREATE POLICY p_sattendance_school_read ON session_attendance FOR SELECT TO role_school
  USING (EXISTS (SELECT 1 FROM class_session s
                  WHERE s.id = session_id AND s.school_id = ANY (app_school_ids())));
CREATE POLICY p_portal_platform ON teacher_portal_token FOR ALL TO role_platform USING (true);
CREATE POLICY p_dispute_platform ON session_dispute FOR ALL TO role_platform USING (true);
CREATE POLICY p_dispute_school ON session_dispute FOR ALL TO role_school
  USING (school_id = ANY (app_school_ids()))
  WITH CHECK (school_id = ANY (app_school_ids()));

-- ---- Grant'ler ----
GRANT SELECT, INSERT, UPDATE ON class_session, session_attendance, teacher_portal_token TO role_platform;
GRANT SELECT, INSERT ON session_event TO role_platform;
GRANT UPDATE (status, resolution_note, refund_txn_id, resolved_at) ON session_dispute TO role_platform;
GRANT SELECT, INSERT ON session_dispute TO role_platform;
GRANT SELECT ON class_session, session_attendance TO role_school;
GRANT SELECT, INSERT ON session_dispute TO role_school;
