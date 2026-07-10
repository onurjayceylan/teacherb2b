-- 0003: ödeme ingest'i — webhook idempotency, top-up (kart + banka), admin banka hesapları

-- Webhook: (provider, event_id) UNIQUE; idempotency insert'i + işleme AYNI transaction'da.
-- Sınıf-2 değişmezlik (02 §8.2): durum kolonları serbest, mali/kimlik kolonları donuk.
CREATE TABLE webhook_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL CHECK (provider IN ('stripe', 'persona', 'docusign', 'superclass', 'wise')),
  event_id     text NOT NULL,
  kind         text NOT NULL,
  payload_min  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- whitelist'lenmiş alanlar; ham gövde TUTULMAZ
  status       text NOT NULL DEFAULT 'received'
               CHECK (status IN ('received', 'processed', 'failed', 'skipped')),
  attempt      int NOT NULL DEFAULT 0,
  last_error   text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_id)
);
CREATE INDEX idx_webhook_pending ON webhook_event (received_at)
  WHERE status IN ('received', 'failed');

CREATE OR REPLACE FUNCTION webhook_event_freeze_cols() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider <> OLD.provider OR NEW.event_id <> OLD.event_id
     OR NEW.kind <> OLD.kind OR NEW.payload_min <> OLD.payload_min
     OR NEW.received_at <> OLD.received_at THEN
    RAISE EXCEPTION 'webhook_event: kimlik/payload kolonları değişmez';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_webhook_freeze BEFORE UPDATE ON webhook_event
  FOR EACH ROW EXECUTE FUNCTION webhook_event_freeze_cols();
CREATE TRIGGER trg_webhook_no_delete BEFORE DELETE ON webhook_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Admin-yönetimli banka hesapları (kurucu kararı #11): EFT TL + SWIFT USD talimatları.
CREATE TABLE bank_account (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label      text NOT NULL,
  rail       text NOT NULL CHECK (rail IN ('eft_tr', 'swift_usd')),
  currency   char(3) NOT NULL,
  holder     text NOT NULL,
  iban       text NOT NULL,
  bank_name  text NOT NULL,
  swift_bic  text,
  notes      text,
  active     boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Top-up: kart (Stripe) + banka havalesi; cleared-funds kuralının veri tabanı (06 T1-②).
CREATE TABLE topup_attempt (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id           uuid NOT NULL REFERENCES school(id),
  method              text NOT NULL CHECK (method IN ('card', 'bank_transfer')),
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  currency            char(3) NOT NULL DEFAULT 'USD',
  status              text NOT NULL DEFAULT 'initiated'
                      CHECK (status IN ('initiated', 'pending_review', 'settled', 'failed', 'refunded')),
  -- kart: Stripe referansları; deterministik idempotency key üretiminin temeli
  stripe_checkout_id  text UNIQUE,
  stripe_payment_intent text UNIQUE,
  -- banka: okulun dekontuyla eşleşecek referans kodu
  bank_reference_code text UNIQUE,
  bank_account_id     uuid REFERENCES bank_account(id),
  evidence_note       text,
  fx_source_currency  char(3),          -- EFT TL girişinde kaynak para birimi
  fx_source_amount    bigint,
  settled_txn_id      uuid REFERENCES ledger_transaction(id),
  settled_at          timestamptz,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (method <> 'bank_transfer' OR bank_reference_code IS NOT NULL)
);
CREATE INDEX idx_topup_school ON topup_attempt (school_id, created_at);
CREATE INDEX idx_topup_open ON topup_attempt (created_at)
  WHERE status IN ('initiated', 'pending_review');

-- Mali alanlar settle sonrası donuk (sınıf-2): tutar/okul/settled_txn_id değişemez.
CREATE OR REPLACE FUNCTION topup_freeze_after_settle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'settled' AND (
       NEW.amount_cents <> OLD.amount_cents OR NEW.school_id <> OLD.school_id
       OR NEW.currency <> OLD.currency
       OR NEW.settled_txn_id IS DISTINCT FROM OLD.settled_txn_id
       OR NEW.status NOT IN ('settled', 'refunded')) THEN
    RAISE EXCEPTION 'topup_attempt: settle sonrası mali alanlar donuk';
  END IF;
  IF NEW.amount_cents <> OLD.amount_cents AND OLD.status <> 'initiated' THEN
    RAISE EXCEPTION 'topup_attempt: tutar yalnız initiated durumunda değişebilir';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_topup_freeze BEFORE UPDATE ON topup_attempt
  FOR EACH ROW EXECUTE FUNCTION topup_freeze_after_settle();

-- RLS
ALTER TABLE webhook_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_account  ENABLE ROW LEVEL SECURITY;
ALTER TABLE topup_attempt ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_webhook_platform ON webhook_event FOR ALL TO role_platform USING (true);
CREATE POLICY p_bank_platform ON bank_account FOR ALL TO role_platform USING (true);
CREATE POLICY p_bank_school_read ON bank_account FOR SELECT TO role_school USING (active);
CREATE POLICY p_topup_platform ON topup_attempt FOR ALL TO role_platform USING (true);
CREATE POLICY p_topup_school ON topup_attempt FOR ALL TO role_school
  USING (school_id = ANY (app_school_ids()))
  WITH CHECK (school_id = ANY (app_school_ids()));

GRANT SELECT, INSERT, UPDATE ON webhook_event TO role_platform;
GRANT SELECT, INSERT, UPDATE ON bank_account TO role_platform;
GRANT SELECT (id, label, rail, currency, holder, iban, bank_name, swift_bic, active)
  ON bank_account TO role_school;
GRANT SELECT, INSERT ON topup_attempt TO role_platform, role_school;
GRANT UPDATE ON topup_attempt TO role_platform;
GRANT UPDATE (status, stripe_checkout_id, stripe_payment_intent, evidence_note, updated_at)
  ON topup_attempt TO role_school;
