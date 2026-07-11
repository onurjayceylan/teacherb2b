-- 0018: P1-D (docs/denetim-3-rol-tur2.md) — Wise fonlamasının ÇİFT-KAYIT modeli.
-- Sorun: Wise gerçek bakiyesi = (kurucunun Wise'a yatırdığı) − (öğretmenlere ödenen). Ledger
-- yalnız "ödenen" tarafını (wise_clearing +X/payout) biliyor; "yatırılan" hiç modellenmiyordu,
-- bu yüzden mutabakat farkı DAİMA devasa çıkıp yanlış alarm üretiyordu (alarm yorgunluğu).
-- Çözüm: kurucu "Wise'a $X yatırdım" dediğinde ledger'a [wise_clearing −X, platform_capital +X]
-- yazılır. Böylece −SUM(wise_clearing) = (fonlama − ödenen) = GERÇEK bakiye olur ve mutabakat
-- (external-reconciler değişmeden) anlamlı hâle gelir — yalnız gerçek anomali alarm verir.
-- Kural (kurucu kararı: B — tam çift-kayıt): fonlama invariant-korumalı ledger'dan geçer.

-- Yeni hesap türü: platform_capital — kurucunun payout float'una enjekte ettiği sermaye.
-- clearing hesapları gibi track_balance DIŞI (min_zero değil) — tek doğru kaynak bacak toplamı;
-- GENERATED min_zero/track_balance ifadeleri bu kind'ı içermediğinden ikisi de false olur.
ALTER TABLE ledger_account DROP CONSTRAINT IF EXISTS ledger_account_kind_check;
ALTER TABLE ledger_account ADD CONSTRAINT ledger_account_kind_check
  CHECK (kind IN (
    'school_cash', 'school_promo', 'wallet_hold', 'school_receivable',
    'teacher_payable',
    'platform_revenue', 'stripe_clearing', 'bank_clearing', 'wise_clearing',
    'fx_gain_loss', 'adjustment_reserve',
    'platform_capital'));

-- Fonlama olay tarihçesi: her "Wise'a $X yatırdım" kaydı (kim, ne zaman, not). Ledger txn'i
-- bu satırı ref'ler (ref_type='wise_funding', ref_id=event.id) — para izi + admin listesi.
CREATE TABLE wise_funding_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  currency      char(3) NOT NULL DEFAULT 'USD',
  note          text,
  txn_id        uuid REFERENCES ledger_transaction(id),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_wise_funding_created ON wise_funding_event (created_at DESC);

ALTER TABLE wise_funding_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_wise_funding_platform ON wise_funding_event FOR ALL TO role_platform USING (true);
GRANT SELECT, INSERT, UPDATE ON wise_funding_event TO role_platform;
