-- 0010: S5 — payout (Wise-manuel akış: ledger-otomatik, yürütme-insan, mutabakat-dosyayla).
-- SERT KISIT: external_ref UNIQUE + provider_idempotency_key UNIQUE + durum whitelist'i.
-- Para YALNIZ 'paid' onayında (Wise sonuç dosyası) ledger'a işler — insanın "gönderdim"
-- demesi hiçbir şeyi paid yapmaz (06 T1-②b).

CREATE TABLE payout_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start date NOT NULL,
  period_end   date NOT NULL CHECK (period_end >= period_start),
  rail         text NOT NULL DEFAULT 'wise' CHECK (rail IN ('wise', 'stripe_connect')),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'exported', 'closed')),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payout (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                 uuid NOT NULL REFERENCES payout_batch(id),
  teacher_id               uuid NOT NULL REFERENCES teacher(id),
  amount_cents             bigint NOT NULL CHECK (amount_cents > 0),
  currency                 char(3) NOT NULL DEFAULT 'USD',
  rail                     text NOT NULL DEFAULT 'wise' CHECK (rail IN ('wise', 'stripe_connect')),
  status                   text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'submitted', 'paid', 'failed', 'cancelled')),
  provider_idempotency_key text NOT NULL UNIQUE,   -- deterministik: 'payout:{teacher}:{batch}'
  external_ref             text UNIQUE,            -- Wise transfer id (sonuç dosyasından)
  failure_reason           text,
  paid_txn_id              uuid REFERENCES ledger_transaction(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  submitted_at             timestamptz,
  paid_at                  timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, teacher_id)                    -- batch'te eğitmen başına tek payout
);
CREATE INDEX idx_payout_teacher ON payout (teacher_id, created_at);
CREATE INDEX idx_payout_open ON payout (created_at) WHERE status IN ('pending', 'submitted');

-- Durum makinesi: manuel Wise akışı pending→submitted(insan beyanı)→paid|failed(sonuç dosyası).
-- 'failed' TERMİNALDİR (02 F38) — yeniden deneme YENİ payout satırıdır; alacak ledger'da korunur.
CREATE OR REPLACE FUNCTION payout_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'pending'   AND NEW.status IN ('submitted', 'cancelled')) OR
    (OLD.status = 'submitted' AND NEW.status IN ('paid', 'failed'))
  ) THEN
    RAISE EXCEPTION 'payout: geçersiz durum geçişi % → %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payout_status BEFORE UPDATE OF status ON payout
  FOR EACH ROW EXECUTE FUNCTION payout_transition();

-- Mali alan dondurma (02 sınıf-2): paid sonrası tutar/eğitmen/txn donuk; external_ref tek sefer yazılır.
CREATE OR REPLACE FUNCTION payout_freeze_cols() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_cents <> OLD.amount_cents OR NEW.teacher_id <> OLD.teacher_id
     OR NEW.currency <> OLD.currency
     OR NEW.provider_idempotency_key <> OLD.provider_idempotency_key THEN
    RAISE EXCEPTION 'payout: mali/kimlik kolonları değişmez';
  END IF;
  IF OLD.external_ref IS NOT NULL AND NEW.external_ref IS DISTINCT FROM OLD.external_ref THEN
    RAISE EXCEPTION 'payout: external_ref yalnız bir kez yazılır';
  END IF;
  IF OLD.status = 'paid' AND NEW.paid_txn_id IS DISTINCT FROM OLD.paid_txn_id THEN
    RAISE EXCEPTION 'payout: paid sonrası paid_txn_id donuk';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payout_freeze BEFORE UPDATE ON payout
  FOR EACH ROW EXECUTE FUNCTION payout_freeze_cols();

-- Bir settled ders hayatta EN FAZLA BİR payout satırına girer (çift ödemenin satır-düzeyi savunması)
CREATE TABLE payout_line (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payout_id    uuid NOT NULL REFERENCES payout(id),
  session_id   uuid NOT NULL REFERENCES class_session(id),
  amount_cents bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- İptal/failed payout'un satırları serbest kalsın diye tekillik canlı payout'larla sınırlı tutulamaz
-- (satır payout'a bağlı); pratik kural: import failed→yeni batch aynı session'ları yeni payout'a bağlar.
-- Çift-CANLI koruması partial değil uygulamada: yeni batch yalnız 'cancelled/failed dışı payout_line'ı
-- OLMAYAN session'ları toplar. Yine de aynı payout içinde tekrarı DB engeller:
CREATE UNIQUE INDEX payout_line_session_per_payout ON payout_line (payout_id, session_id);
CREATE INDEX idx_payout_line_session ON payout_line (session_id);

ALTER TABLE payout_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_line  ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_payout_batch_platform ON payout_batch FOR ALL TO role_platform USING (true);
CREATE POLICY p_payout_platform ON payout FOR ALL TO role_platform USING (true);
CREATE POLICY p_payout_line_platform ON payout_line FOR ALL TO role_platform USING (true);

GRANT SELECT, INSERT, UPDATE ON payout_batch, payout TO role_platform;
GRANT SELECT, INSERT ON payout_line TO role_platform;
