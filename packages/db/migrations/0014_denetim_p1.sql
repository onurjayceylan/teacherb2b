-- 0014: Üç-rol denetiminin P1 düzeltmeleri için şema desteği.
-- (a) kart itirazı (chargeback) görünürlüğü — para hareketi YOK, yalnız kayıt + alarm;
--     para düzeltmesi admin'in mevcut reversal yollarıyla yapılır (02-veri-modeli: düzeltme=reversal).
-- (b) dış mutabakat iskeleti: Stripe/Wise gerçek bakiye anlık görüntüleri; ledger
--     clearing hesabıyla fark alarmı worker'da (external-reconciler cron).

-- (a) chargeback_event: Stripe charge.dispute.* webhook'larından beslenir.
CREATE TABLE chargeback_event (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id   text NOT NULL UNIQUE,      -- webhook idempotency (aynı event iki kez işlenmez)
  stripe_dispute_id text NOT NULL,
  payment_intent_id text,
  school_id         uuid REFERENCES school(id), -- PI→topup eşleşirse dolar; eşleşmezse NULL kalır
  amount_cents      bigint NOT NULL,
  currency          text NOT NULL DEFAULT 'USD',
  status            text NOT NULL
                    CHECK (status IN ('needs_response', 'under_review', 'won', 'lost')),
  raw               jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Aynı dispute'un yaşam döngüsü (created → closed) ayrı event'lerle gelir; son durumu
-- dispute_id üstünden güncelleriz ama her event satırı da kalır (denetim izi).
CREATE INDEX idx_chargeback_dispute ON chargeback_event (stripe_dispute_id);
CREATE INDEX idx_chargeback_open ON chargeback_event (created_at)
  WHERE status IN ('needs_response', 'under_review');

ALTER TABLE chargeback_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_chargeback_platform ON chargeback_event FOR ALL TO role_platform USING (true);
GRANT SELECT, INSERT, UPDATE ON chargeback_event TO role_platform;

-- (b) external_balance_snapshot: sağlayıcının BİZE söylediği bakiye (api) ya da kurucunun
-- elle girdiği değer (manual). Mutabakat = snapshot vs ledger clearing hesabı farkı.
CREATE TABLE external_balance_snapshot (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL CHECK (provider IN ('stripe', 'wise')),
  balance_cents bigint NOT NULL,
  currency      text NOT NULL DEFAULT 'USD',
  source        text NOT NULL CHECK (source IN ('api', 'manual')),
  note          text,
  captured_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ext_balance_provider ON external_balance_snapshot (provider, captured_at DESC);

ALTER TABLE external_balance_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_ext_balance_platform ON external_balance_snapshot FOR ALL TO role_platform USING (true);
GRANT SELECT, INSERT ON external_balance_snapshot TO role_platform;
