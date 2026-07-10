-- 0002: para çekirdeği — çift-kayıt ledger, hold hesapları, kill-switch, post_ledger_txn
-- SERT KISITLAR: append-only fiziksel; SUM=0 deferred; CHECK(balance>=0); tek yazım kapısı.

CREATE TABLE system_flag (
  key        text PRIMARY KEY,
  value      boolean NOT NULL DEFAULT false,
  detail     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
INSERT INTO system_flag (key, value, detail) VALUES ('payments_frozen', false, NULL);

CREATE OR REPLACE FUNCTION assert_payments_not_frozen() RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM system_flag WHERE key = 'payments_frozen' AND value) THEN
    RAISE EXCEPTION 'payments_frozen: para akışı kill-switch ile durduruldu'
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

CREATE TABLE ledger_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type    text NOT NULL CHECK (owner_type IN ('school', 'teacher', 'platform')),
  owner_id      uuid,          -- platform hesaplarında NULL (singleton)
  kind          text NOT NULL CHECK (kind IN (
                  'school_cash', 'school_promo', 'wallet_hold', 'school_receivable',
                  'teacher_payable',
                  'platform_revenue', 'stripe_clearing', 'bank_clearing', 'wise_clearing',
                  'fx_gain_loss', 'adjustment_reserve')),
  currency      char(3) NOT NULL DEFAULT 'USD',
  -- Guard'lar konfigürasyona değil tipe gömülü (02 F7):
  min_zero      boolean GENERATED ALWAYS AS
                (kind IN ('school_cash', 'school_promo', 'wallet_hold')) STORED,
  track_balance boolean GENERATED ALWAYS AS
                (kind IN ('school_cash', 'school_promo', 'wallet_hold', 'teacher_payable')) STORED,
  balance_cents bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT min_zero OR balance_cents >= 0),            -- negatif bakiye fiziksel imkânsız
  CHECK ((owner_type = 'platform') = (owner_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (owner_type, owner_id, kind, currency)
);
CREATE INDEX idx_ledger_account_owner ON ledger_account (owner_type, owner_id);

CREATE TABLE ledger_transaction (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  type            text NOT NULL,
  ref_type        text,
  ref_id          uuid,
  reverses_txn_id uuid REFERENCES ledger_transaction(id),
  reason_code     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (reverses_txn_id IS NULL OR reason_code IS NOT NULL)
);
CREATE UNIQUE INDEX ledger_txn_single_reversal
  ON ledger_transaction (reverses_txn_id) WHERE reverses_txn_id IS NOT NULL;
CREATE INDEX idx_ledger_txn_ref ON ledger_transaction (ref_type, ref_id);

CREATE TABLE ledger_entry (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txn_id     uuid NOT NULL REFERENCES ledger_transaction(id),
  account_id uuid NOT NULL REFERENCES ledger_account(id),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  currency   char(3) NOT NULL DEFAULT 'USD',
  school_id  uuid,   -- owner denorm (02 F19): entry-grain RLS/rapor için
  teacher_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ledger_entry_txn ON ledger_entry (txn_id);
CREATE INDEX idx_ledger_entry_account ON ledger_entry (account_id, created_at);
CREATE INDEX idx_ledger_entry_school ON ledger_entry (school_id, created_at) WHERE school_id IS NOT NULL;

-- Append-only: tarihçe fiziksel olarak değişmez (02 §8.2 sınıf-1)
CREATE TRIGGER trg_ledger_txn_append_only
  BEFORE UPDATE OR DELETE ON ledger_transaction
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_ledger_entry_append_only
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Seal (02 F49): tarihî txn'e sonradan entry enjekte edilemez.
CREATE OR REPLACE FUNCTION assert_entry_txn_fresh() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE t timestamptz;
BEGIN
  SELECT created_at INTO t FROM ledger_transaction WHERE id = NEW.txn_id;
  IF t IS NULL OR t <> transaction_timestamp() THEN
    RAISE EXCEPTION 'ledger_entry yalnız aynı transaction içinde açılan txn''e yazılabilir';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ledger_entry_seal
  BEFORE INSERT ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION assert_entry_txn_fresh();

-- SUM=0: txn başına, para birimi başına — commit anında zorunlu (deferred).
CREATE OR REPLACE FUNCTION assert_txn_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE bad record;
BEGIN
  SELECT currency, SUM(amount_cents) AS s INTO bad
  FROM ledger_entry WHERE txn_id = NEW.txn_id
  GROUP BY currency HAVING SUM(amount_cents) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'dengesiz ledger txn %: % % cent', NEW.txn_id, bad.currency, bad.s;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_ledger_entry_balanced
  AFTER INSERT ON ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_txn_balanced();

-- Hesap aç/bul (idempotent) — modüller doğrudan tabloya yazamaz.
CREATE OR REPLACE FUNCTION ensure_ledger_account(
  p_owner_type text, p_owner_id uuid, p_kind text, p_currency char(3) DEFAULT 'USD'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM ledger_account
   WHERE owner_type = p_owner_type AND owner_id IS NOT DISTINCT FROM p_owner_id
     AND kind = p_kind AND currency = p_currency;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO ledger_account (owner_type, owner_id, kind, currency)
  VALUES (p_owner_type, p_owner_id, p_kind, p_currency)
  ON CONFLICT (owner_type, owner_id, kind, currency) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM ledger_account
     WHERE owner_type = p_owner_type AND owner_id IS NOT DISTINCT FROM p_owner_id
       AND kind = p_kind AND currency = p_currency;
  END IF;
  RETURN v_id;
END $$;

-- TEK YAZIM KAPISI (02 §2.3): idempotency + kanonik kilit sırası + bakiye + kill-switch.
-- p_entries: [{"account_id": uuid, "amount_cents": bigint}]
CREATE OR REPLACE FUNCTION post_ledger_txn(
  p_idempotency_key text,
  p_type text,
  p_ref_type text,
  p_ref_id uuid,
  p_entries jsonb,
  p_reverses_txn_id uuid DEFAULT NULL,
  p_reason_code text DEFAULT NULL
) RETURNS TABLE (txn_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_txn_id uuid;
  v_acct record;
  e record;
BEGIN
  PERFORM assert_payments_not_frozen();

  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) < 2 THEN
    RAISE EXCEPTION 'post_ledger_txn: en az 2 bacaklı entries dizisi zorunlu';
  END IF;

  INSERT INTO ledger_transaction (idempotency_key, type, ref_type, ref_id, reverses_txn_id, reason_code)
  VALUES (p_idempotency_key, p_type, p_ref_type, p_ref_id, p_reverses_txn_id, p_reason_code)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_txn_id;

  IF v_txn_id IS NULL THEN
    -- Çift işleme = yapısal no-op: mevcut txn döner, hiçbir bakiye değişmez.
    SELECT id INTO v_txn_id FROM ledger_transaction WHERE idempotency_key = p_idempotency_key;
    RETURN QUERY SELECT v_txn_id, false;
    RETURN;
  END IF;

  -- Kanonik kilit sırası (02 F15/F41): hesaplar id sırasıyla kilitlenir → deadlock yok.
  FOR v_acct IN
    SELECT a.id, a.currency
      FROM ledger_account a
     WHERE a.id IN (SELECT (x->>'account_id')::uuid FROM jsonb_array_elements(p_entries) x)
     ORDER BY a.id
     FOR UPDATE
  LOOP NULL; END LOOP;

  FOR e IN
    SELECT (x->>'account_id')::uuid AS account_id, (x->>'amount_cents')::bigint AS amount_cents
      FROM jsonb_array_elements(p_entries) x
  LOOP
    INSERT INTO ledger_entry (txn_id, account_id, amount_cents, currency, school_id, teacher_id)
    SELECT v_txn_id, a.id, e.amount_cents, a.currency,
           CASE WHEN a.owner_type = 'school'  THEN a.owner_id END,
           CASE WHEN a.owner_type = 'teacher' THEN a.owner_id END
      FROM ledger_account a WHERE a.id = e.account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'post_ledger_txn: hesap yok: %', e.account_id;
    END IF;

    UPDATE ledger_account
       SET balance_cents = balance_cents + e.amount_cents
     WHERE id = e.account_id AND track_balance;
    -- min_zero CHECK'i burada patlar → negatif bakiye hiçbir kod yolundan yazılamaz.
  END LOOP;

  RETURN QUERY SELECT v_txn_id, true;
END $$;

-- Nöbetçi sorguları (01 §9): SQL tarafı — worker bunları saatlik koşar.
CREATE OR REPLACE FUNCTION ledger_invariant_violations()
RETURNS TABLE (check_name text, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- (a) global trial balance = 0 (para birimi başına)
  SELECT 'trial_balance'::text,
         'currency=' || currency || ' sum=' || SUM(amount_cents)::text
    FROM ledger_entry GROUP BY currency HAVING SUM(amount_cents) <> 0
  UNION ALL
  -- (b) cache bakiye = bacaklardan türetilmiş bakiye
  SELECT 'balance_cache_drift',
         'account=' || a.id || ' cache=' || a.balance_cents ||
         ' derived=' || COALESCE(SUM(e.amount_cents), 0)
    FROM ledger_account a
    LEFT JOIN ledger_entry e ON e.account_id = a.id
   WHERE a.track_balance
   GROUP BY a.id, a.balance_cents
  HAVING a.balance_cents <> COALESCE(SUM(e.amount_cents), 0);
$$;

-- RLS: okul kendi entry'lerini görür (entry-grain, 02 F19); yazım yalnız RPC'den.
ALTER TABLE ledger_account     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry       ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_acct_platform ON ledger_account FOR SELECT TO role_platform USING (true);
CREATE POLICY p_acct_school ON ledger_account FOR SELECT TO role_school
  USING (owner_type = 'school' AND owner_id = ANY (app_school_ids()));
CREATE POLICY p_entry_platform ON ledger_entry FOR SELECT TO role_platform USING (true);
CREATE POLICY p_entry_school ON ledger_entry FOR SELECT TO role_school
  USING (school_id = ANY (app_school_ids()));
CREATE POLICY p_txn_platform ON ledger_transaction FOR SELECT TO role_platform USING (true);

GRANT SELECT ON ledger_account, ledger_entry TO role_school;
GRANT SELECT ON ledger_account, ledger_transaction, ledger_entry TO role_platform;
GRANT SELECT ON system_flag TO role_platform, role_school;
GRANT UPDATE (value, detail, updated_at, updated_by) ON system_flag TO role_platform;
GRANT EXECUTE ON FUNCTION post_ledger_txn(text, text, text, uuid, jsonb, uuid, text)
  TO role_platform, role_school;
GRANT EXECUTE ON FUNCTION ensure_ledger_account(text, uuid, text, char)
  TO role_platform, role_school;
GRANT EXECUTE ON FUNCTION ledger_invariant_violations() TO role_platform;
GRANT EXECUTE ON FUNCTION app_school_ids(), assert_payments_not_frozen()
  TO role_platform, role_school;
