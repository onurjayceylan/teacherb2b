# Scholege Lite — Çekirdek Veri Modeli v2 (FINAL — adversarial doğrulama sonrası)

Taslak (v1), 57 bulguluk adversarial doğrulamadan geçirildi. Bu doküman **nihai** modeldir: tüm düzeltmeler DDL'e işlenmiş, reddedilen/birleştirilen bulgular sonda "Bulgu kararları" tablosunda gerekçelendirilmiştir.

---

## 0. Genel konvansiyonlar

- **PK**: `uuid DEFAULT gen_random_uuid()` — dağıtık agent'ların çakışmasız ID üretimi + enumeration-IDOR yüzeyinin küçültülmesi.
- **Para**: `bigint` cent. İş para birimi USD; **şema çok-para-birimine hazır** (entry-düzeyi `currency`, para-birimi-başına denge, fx hesapları) ama Faz-1'de "USD-only" bir **işlem kuralıdır**, şema kısıtı değil (F46).
- **Zaman**: her yerde `timestamptz` (UTC); lokal anlam gereken yerde IANA `timezone text`. **Occurrence kimliği duvar saatidir, UTC instant değildir** (F29/F42, §4.4).
- **Yuvarlama (normatif, F13)**: para hesabı zincirinde tüm çarpanlar rasyonel (numeric) çarpılır, cent'e **tek seferde, half-even** yuvarlanır: `cents_round()` (§3.4). Yuvarlanmış değer bir kez yazılır; **hiçbir downstream tüketici (invoice_line, rapor, statement) yeniden hesaplayamaz**, ledger'daki değeri kopyalar.
- **Enum**: Postgres `ENUM` sadece durum makinelerinde; açık uçlu listeler `text + CHECK`.
- **Değişmezlik sınıfları (F6/F53 ile yeniden tanımlandı, §8.2)**: (1) salt-append, (2) durum-mutable/mali-alan-immutable, (3) durumla-silinen, (4) `deleted_at` soft-delete — **`deleted_at` taşıyan tabloda tam UNIQUE yasak, daima partial** (F45).
- **Para yazım yolu tektir**: tüm ledger yazımları `post_ledger_txn()` SECURITY DEFINER fonksiyonundan geçer; uygulama rolleri ledger tablolarına doğrudan INSERT/UPDATE **edemez** (F15/F18/F49).
- **DB rolleri (F17/F18)**: `role_platform`, `role_school`, `role_teacher` — bağlantı havuzu aktör türüne göre `SET ROLE` yapar; hassas kolonlar (maliyet, PII, ledger tabanı) kolon-grant ile rol bazında kapalıdır.
- **Migration disiplini (SERT KISIT)**: kolon/constraint önce migration ile DB'de doğrulanır, ORM'e sonra girer; CI'da "ORM ↔ information_schema diff" zorunlu.
- **CI linter'ları (genişletildi)**: (a) pii-etiketli kolon maskesiz view'da mı; (b) `school_id` taşıyan ve parent FK'li her tablo **bileşik FK** içeriyor mu (F20); (c) FK'si olup index'i olmayan kolon var mı (F52); (d) `deleted_at`'li tabloda tam UNIQUE var mı (F45).

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;
```

---

## 1. Parti, tenancy, kimlik, AuthZ

### 1.1 Organizasyon katmanı (F47)

Faz-3 distribütör / Faz-4 B2C için parti katmanı **şimdi** eklenir (Faz-1'de okul:org = 1:1, maliyeti sıfır). RLS tek-değer GUC yerine **üyelik-temelli** yazılır: oturum açılışında aktörün erişebildiği okul kümesi `app.school_ids` (virgüllü uuid listesi) olarak set edilir — Faz-1'de tek eleman, Faz-3'te distribütörün tüm okulları. Politika metni hiç değişmez.

```sql
CREATE TABLE organization (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'school_owner'
             CHECK (kind IN ('school_owner','distributor')),
  created_at timestamptz NOT NULL DEFAULT now()
);
```

### 1.2 Kimlik ve tenant tabloları

```sql
CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,            -- PII
  password_hash text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  token_version int  NOT NULL DEFAULT 1,           -- bump = tüm JWT'ler fail-closed düşer
  last_login_at timestamptz,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE school (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL REFERENCES organization(id),   -- F47
  name                       text NOT NULL,
  region                     text NOT NULL CHECK (region IN ('MENA','TR','USA')),
  country_code               char(2) NOT NULL,
  timezone                   text NOT NULL,
  default_locale             text NOT NULL DEFAULT 'en',   -- 'ar' → RTL
  billing_email              text NOT NULL,                -- PII
  status                     text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('onboarding','active','suspended','churned')),
  auto_topup_threshold_cents bigint,
  auto_topup_amount_cents    bigint,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
-- v1'deki dairesel wallet_account_id kaldırıldı: cüzdan hesapları
-- ledger_account(owner_type='school', owner_id) üzerinden bulunur.

CREATE TYPE school_role AS ENUM ('owner','admin','scheduler','finance','viewer');

CREATE TABLE school_user (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES school(id),
  user_id    uuid NOT NULL REFERENCES app_user(id),
  role       school_role NOT NULL,
  status     text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, user_id)
);

CREATE TABLE teacher_user (
  user_id    uuid PRIMARY KEY REFERENCES app_user(id),
  teacher_id uuid NOT NULL UNIQUE REFERENCES teacher(id)
);

CREATE TABLE platform_admin (
  user_id uuid PRIMARY KEY REFERENCES app_user(id),
  role    text NOT NULL CHECK (role IN ('superadmin','ops','finance','curation'))
);
```

### 1.3 RLS kalıbı v2 (F18/F47)

Oturum middleware'i her bağlantıda set eder: `app.school_ids` (uuid CSV), `app.school_role`, `app.teacher_id`, `app.actor_kind`, `app.platform_role`. GUC yoksa → NULL → **fail-closed**.

```sql
-- Yardımcı: fail-closed okul kümesi
CREATE FUNCTION app_school_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT string_to_array(NULLIF(current_setting('app.school_ids', true), ''), ',')::uuid[]
$$;

-- Kanonik kalıp (okul-sahipli her tabloya):
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE session FORCE ROW LEVEL SECURITY;
CREATE POLICY p_school   ON session USING (school_id = ANY (app_school_ids()));
CREATE POLICY p_teacher  ON session USING (teacher_id = NULLIF(current_setting('app.teacher_id', true), '')::uuid);
CREATE POLICY p_platform ON session USING (current_setting('app.actor_kind', true) = 'platform_admin');
```

**Intra-tenant RBAC (F18):** finans verisi taşıyan tablolarda (invoice, ledger view'ları, topup_attempt) `p_school` politikası ek koşul taşır: `current_setting('app.school_role', true) IN ('owner','admin','finance')`. Platform tarafında `p_platform_finance` politikaları `app.platform_role IN ('superadmin','finance')` ister — kürasyon admini ledger/payout **okuyamaz**.

**Kolon-seviye yazma koruması (F18):** `session`'ın para/dozaj kolonlarına (`charged_cents`, `billed_min`, `counted_min`, `charge_status`, `finalized_at`, ...) tüm uygulama rollerinden `UPDATE` REVOKE edilir; finalize/adjustment **yalnız** SECURITY DEFINER fonksiyonlarından yürür. Status geçişleri uygulamada daima CAS (`UPDATE ... WHERE status = beklenen`) + DB'de geçiş-whitelist trigger'ı (§4.2).

### 1.4 Teacher-scoped tablolarda RLS (F17)

`teacher`, `verification_check`, `tax_form`, `teacher_payout_method`, `teacher_availability`, `teacher_time_off` platform-scoped olsalar da **RLS ENABLE + FORCE** alır:

```sql
ALTER TABLE teacher ENABLE ROW LEVEL SECURITY; ALTER TABLE teacher FORCE ROW LEVEL SECURITY;
CREATE POLICY p_self     ON teacher USING (id = NULLIF(current_setting('app.teacher_id', true), '')::uuid);
CREATE POLICY p_platform ON teacher USING (current_setting('app.actor_kind', true) = 'platform_admin');
-- Okul bağlamında HİÇBİR policy eşleşmez → 0 satır (fail-closed).
```

Ek savunma: `REVOKE SELECT ON teacher FROM role_school;` — okul rolü taban tabloya SQL düzeyinde dahi erişemez; okula açık tek yüzey `teacher_directory_v`'dir ve **`security_invoker = true`** ile yaratılır (view sahibi üzerinden RLS bypass'ı kapanır):

```sql
CREATE VIEW teacher_directory_v WITH (security_invoker = false) AS  -- bilinçli: definer-view,
SELECT t.id, t.display_name, t.country_code, t.timezone,             -- ama SADECE maskeli kolonlar
       t.reliability_score, tp.pool_id
FROM teacher t JOIN teacher_pool tp ON tp.teacher_id = t.id AND tp.status = 'active'
WHERE t.onboarding_status = 'active' AND t.deleted_at IS NULL;
GRANT SELECT ON teacher_directory_v TO role_school;
-- legal_name/email/phone bu view'da YOK: PII + disintermediation tek mekanizmada.
```

(Not: dizin view'ı bilinçli olarak definer'dır çünkü amaç okulun göremediği satırları maskeli göstermektir; PII kolonları view'da fiziksel olarak yoktur ve CI pii-linter'ı bunu doğrular. Kendi verisini gösteren tüm diğer view'lar `security_invoker=true`'dur.)

### 1.5 PII işaretleme

- PII kolonları `COMMENT ON COLUMN ... IS 'pii:<sınıf>'`; CI linter maskesiz view'a pii kolonu girişini bloklar.
- `webhook_event` ham payload PII'sı §2.5'te vendor-offload ilkesine geri bağlandı (F21).

---

## 2. PARA — append-only çift-kayıt ledger

### 2.1 Hesap planı (genişletilmiş — F2, F9, F10, F46)

| Hesap | Tür | Normal taraf | Sahip | Not |
|---|---|---|---|---|
| `school_wallet_cash` | Yükümlülük | credit | okul başına 1 | **nakit-karşılıklı**; yalnız buradan refund |
| `school_wallet_promo` | Yükümlülük | credit | okul başına 1 | SLA/promosyon; **iade edilemez** (F9) |
| `school_receivable` | Varlık | debit | okul başına 1 | teslim edilmiş-tahsil edilmemiş (F2) |
| `teacher_payable` | Yükümlülük | credit | eğitmen başına 1 | |
| `platform_revenue` | Gelir | credit | platform | materialized bakiye YOK (F15/F41) |
| `stripe_clearing` | Varlık | debit | platform | |
| `wise_balance` / `deel_balance` | Varlık | debit | platform | provider nakit hesapları (F10) |
| `payout_clearing` | Varlık | debit | provider başına 1 | |
| `payment_fees` / `payout_fees` | Gider | debit | platform | payout ücreti ayrıştı (F10) |
| `sla_credit_expense` | Gider | debit | platform | |
| `bad_debt` | Gider | debit | platform | receivable write-off (F2) |
| `fx_gain_loss` | Karma | — | platform | non-USD settle farkı (F46) |
| `adjustment` | Karma | — | platform | |

**Akışlar** (hepsi tek `post_ledger_txn()` çağrısı, entry'ler para-birimi-başına dengeli):

1. **Top-up**: DR `stripe_clearing` / CR `school_wallet_cash` (+ DR `payment_fees` / CR `stripe_clearing`).
2. **Session finalize — İKİ bağımsız idempotent txn'e bölündü (F2/F30):**
   - **`session_delivery:<id>`** (teslim gerçeği; **her koşulda commit olur**): DR `school_receivable` (charged) / CR `teacher_payable` (teacher_paid) / CR `platform_revenue` (marj). Eğitmen alacağı okulun cüzdanına asla rehin değildir.
   - **`session_settle:<id>`** (tahsilat): DR `school_wallet_promo` (önce, promo bakiyesi kadar) + DR `school_wallet_cash` (kalan) / CR `school_receivable`. Bakiye yetmezse txn atılmaz, `session.charge_status='pending_funds'`; her top-up webhook'unda aynı sabit idempotency key ile CAS retry. Cüzdan taban CHECK'i hard guard olarak kalır.
3. **Payout gönderim**: DR `teacher_payable` / CR `payout_clearing`; **settle**: DR `payout_clearing` / CR **`payout.provider`'a göre** `stripe_clearing`|`wise_balance`|`deel_balance` (+ DR `payout_fees`, fark varsa DR/CR `fx_gain_loss`) (F10).
4. **Refund**: DR `school_wallet_cash` / CR `stripe_clearing` — kurallar §2.5'te (F9).
5. **SLA kredisi**: DR `sla_credit_expense` / CR `school_wallet_promo`.
6. **Write-off** (tanımlı fallback, insan onaylı tek istisna): DR `bad_debt` / CR `school_receivable`.

**Suspend kuralı (F2c):** okul `suspended` olduğunda (a) yeni occurrence materialize edilmez, (b) ufuktaki `scheduled`/`pending_backfill` seanslar 48 saatlik koruma penceresi dışında toplu **`void`**'e alınır (§4.2), (c) receivable yaşlanma alarmı platform finansına düşer. Dispatch agent'ının soft-guard'ı (ufuk taahhüdü vs bakiye → auto-top-up/uyarı) aynen kalır.

### 2.2 Ledger tabloları

```sql
CREATE TYPE ledger_side AS ENUM ('debit','credit');
CREATE TYPE ledger_account_type AS ENUM (
  'school_wallet_cash','school_wallet_promo','school_receivable',
  'platform_revenue','teacher_payable',
  'stripe_clearing','wise_balance','deel_balance','payout_clearing',
  'payment_fees','payout_fees','sla_credit_expense','bad_debt','fx_gain_loss','adjustment');
CREATE TYPE txn_kind AS ENUM (
  'wallet_topup','session_delivery','session_settle','wallet_refund',
  'payout','payout_reversal','sla_credit','receivable_writeoff',
  'manual_adjustment','reversal');

CREATE TABLE ledger_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          ledger_account_type NOT NULL,
  owner_type    text CHECK (owner_type IN ('school','teacher','platform','organization')), -- F47
  owner_id      uuid,
  normal_side   ledger_side NOT NULL,
  -- F7: politika tipten TÜRETİLİR, satır bayrağına emanet edilmez
  min_zero      boolean GENERATED ALWAYS AS
                (type IN ('school_wallet_cash','school_wallet_promo')) STORED,
  -- F15/F41: materialized bakiye YALNIZ per-parti hesaplarda; singleton'lar rollup'tan okunur
  track_balance boolean GENERATED ALWAYS AS
                (type IN ('school_wallet_cash','school_wallet_promo',
                          'school_receivable','teacher_payable')) STORED,
  balance_cents bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT balance_floor CHECK (NOT min_zero OR balance_cents >= 0),
  UNIQUE NULLS NOT DISTINCT (type, owner_type, owner_id)
);

CREATE TABLE ledger_transaction (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            txn_kind NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  ref_type        text,
  ref_id          uuid,
  reverses_txn_id uuid REFERENCES ledger_transaction(id),
  note            text,
  created_by      uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_txn_ref ON ledger_transaction (ref_type, ref_id);          -- F52
-- F4: bir txn'in EN FAZLA BİR ters kaydı olur; kısmi düzeltme = tam ters + yeni doğru txn
CREATE UNIQUE INDEX ledger_reversal_once
  ON ledger_transaction (reverses_txn_id) WHERE reverses_txn_id IS NOT NULL;

-- F54: en yüksek hacimli tablo baştan partitioned
CREATE TABLE ledger_entry (
  id             bigint GENERATED ALWAYS AS IDENTITY,
  transaction_id uuid NOT NULL REFERENCES ledger_transaction(id),
  account_id     uuid NOT NULL REFERENCES ledger_account(id),
  owner_type     text NOT NULL,            -- F19: hesaptan denorm (post_ledger_txn doldurur)
  owner_id       uuid,
  side           ledger_side NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'USD',   -- F46
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX idx_entry_account ON ledger_entry (account_id, created_at);
CREATE INDEX idx_entry_txn     ON ledger_entry (transaction_id);
```

**Entry-grain tenant erişimi (F19):** okul/eğitmen **asla transaction-grain veri görmez** — bir txn tanımı gereği çok-partilidir. RLS entry düzeyindedir ve kardeş entry'ler hiç dönmez:

```sql
ALTER TABLE ledger_entry ENABLE ROW LEVEL SECURITY; ALTER TABLE ledger_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY p_school ON ledger_entry
  USING (owner_type = 'school' AND owner_id = ANY (app_school_ids())
         AND current_setting('app.school_role', true) IN ('owner','admin','finance'));
CREATE POLICY p_teacher ON ledger_entry
  USING (owner_type = 'teacher' AND owner_id = NULLIF(current_setting('app.teacher_id', true), '')::uuid);
CREATE POLICY p_platform ON ledger_entry
  USING (current_setting('app.actor_kind', true) = 'platform_admin'
         AND current_setting('app.platform_role', true) IN ('superadmin','finance','ops'));
```

### 2.3 Bütünlük mekanizması (tek yazım yolu + trigger'lar)

**`post_ledger_txn()` — SECURITY DEFINER, tüm para yazımlarının tek kapısı (F15/F18/F49):**
- `idempotency_key` üzerinde `INSERT ... ON CONFLICT DO NOTHING`; kaybeden çağrı mevcut txn id'sini döner (idempotent, çift-işleme yapısal imkânsız).
- Entry'leri **`account_id ASC` kanonik sırayla** insert eder → topup×refund AB-BA deadlock'u yapısal olarak biter (F15).
- Entry'nin `owner_type/owner_id`'sini hesaptan doldurur (F19).
- Uygulama rollerinin ledger tablolarında INSERT/UPDATE/DELETE grant'i yoktur.

```sql
-- 1) Salt-append (ledger_entry, ledger_transaction, attendance_event, audit_log)
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'append-only table: %', TG_TABLE_NAME; END $$;
CREATE TRIGGER trg_entry_immutable BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- + REVOKE UPDATE, DELETE ... FROM tüm uygulama rolleri

-- 2) F49: txn mühürleme — entry yalnız txn'in yaratıldığı DB transaction'ında eklenebilir
CREATE FUNCTION assert_txn_open() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT created_at FROM ledger_transaction WHERE id = NEW.transaction_id)
     <> transaction_timestamp()
  THEN RAISE EXCEPTION 'sealed ledger transaction %', NEW.transaction_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_txn_sealed BEFORE INSERT ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION assert_txn_open();

-- 3) Denge: PARA BİRİMİ BAŞINA sıfır (F46), commit'te (deferred)
CREATE FUNCTION assert_txn_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ledger_entry
    WHERE transaction_id = NEW.transaction_id
    GROUP BY currency
    HAVING SUM(CASE side WHEN 'debit' THEN amount_cents ELSE -amount_cents END) <> 0)
  THEN RAISE EXCEPTION 'unbalanced ledger transaction %', NEW.transaction_id;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_txn_balanced
  AFTER INSERT ON ledger_entry DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_txn_balanced();

-- 4) Materialized bakiye: YALNIZ track_balance hesaplarda (F15/F41 — singleton hot-row yok)
CREATE FUNCTION apply_entry_to_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ledger_account
  SET balance_cents = balance_cents +
      CASE WHEN NEW.side = normal_side THEN NEW.amount_cents ELSE -NEW.amount_cents END
  WHERE id = NEW.account_id AND track_balance;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_apply_balance AFTER INSERT ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION apply_entry_to_balance();
```

`platform_revenue`/`stripe_clearing` gibi singleton hesapların bakiyesi trigger'la tutulmaz; gece rollup + rapor SUM'ı yeterlidir — finalize'lar artık global tek satırda serileşmez.

### 2.4 Reversal kuralları (F4)

- Düzeltme modeli: **tam ters + yeni doğru txn** ("kısmi reversal" yok — `ledger_reversal_once` UNIQUE bunu şemada mühürler).
- Deterministik idempotency key: `reversal:<orig_txn_id>` (retry bug'ı ikinci reversal yaratamaz).
- Constraint trigger `assert_reversal_mirror`: ters kaydın entry seti orijinalin **aynası** olmalıdır (aynı hesaplar, ters taraflar, aynı tutar/para birimi); değilse RAISE.
- `manual_adjustment` → `created_by NOT NULL` + audit_log zorunlu (değişmedi).

### 2.5 Dış para olayları: webhook, top-up, refund

```sql
CREATE TABLE webhook_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  event_id      text NOT NULL,
  event_type    text NOT NULL,
  payload_min   jsonb NOT NULL,   -- F21: whitelist'lenmiş minimum alanlar; PII strip edilir
  raw_ptr       text,             -- F21: ham gövde şifreli, kısa-TTL ayrı store'da (gerekirse)
  status        text NOT NULL DEFAULT 'received'
                CHECK (status IN ('received','processing','processed','skipped','failed')),
  attempt_count int NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  error         text,
  processed_at  timestamptz,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
CREATE INDEX idx_webhook_retry ON webhook_event (COALESCE(next_retry_at, received_at))
  WHERE status IN ('received','failed');                                   -- F52
-- Erişim: yalnız role_platform (F21). Retention: processed + 90 gün sonra payload_min
-- boşaltılır, satır + unique anahtar kalır (idempotency bozulmaz) (F54).
```

**İşleme semantiği (F3 — "kazanamayan hiç işlemez" kuralı DÜZELTİLDİ):**
1. `INSERT ... ON CONFLICT (provider, event_id) DO NOTHING`.
2. Ardından **her koşulda**: `SELECT ... FOR UPDATE SKIP LOCKED`; `status NOT IN ('processed','skipped')` ise işle (aşağı katman zaten `idempotency_key` UNIQUE ile korunuyor — yeniden işleme güvenlidir).
3. Sweep job: N dakikadan eski `received/failed` satırlarını yeniden kuyruğa alır.
4. **Dış mutabakat**: gece işi `SUM(entries)=balance`'a ek olarak Stripe balance ↔ `stripe_clearing`, provider bakiyeleri ↔ `wise_balance`/`deel_balance` karşılaştırır — "ledger içi tutarlı ama dışarıda para eksik" sınıfı görünür olur.

```sql
-- F5: auto top-up idempotency çapası — Stripe çağrısını yalnız INSERT'i kazanan yapar
CREATE TABLE topup_attempt (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                 uuid NOT NULL REFERENCES school(id),
  kind                      text NOT NULL CHECK (kind IN ('auto','manual')),
  idempotency_key           text NOT NULL UNIQUE,  -- auto: 'auto:'||school_id||':'||pencere_başlangıcı
  amount_cents              bigint NOT NULL CHECK (amount_cents > 0),
  status                    text NOT NULL DEFAULT 'created'
                            CHECK (status IN ('created','sent','succeeded','failed','abandoned')),
  stripe_payment_intent_ref text UNIQUE,
  cooldown_until            timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);
```
Attempt satırı Stripe çağrısından **önce** commit edilir; `idempotency_key` Stripe'a `Idempotency-Key` header'ı olarak gider — çift çekim hem bizde hem provider'da tekilleşir.

**Refund kuralları (F9):**
- Refund yalnız `school_wallet_cash`'ten yapılabilir (promo cüzdanı iade edilemez); tavan = nakit alt-bakiye.
- Her `wallet_refund` txn'i `ref_type='ledger_transaction', ref_id=<orijinal topup txn>` taşımak **zorundadır**; trigger `assert_refund_capacity`: aynı topup'a bağlı refund'ların kümülatifi ≤ topup tutarı (charge-başına kalan-iade-kapasitesi).
- Harcama sırası (settle akışında): önce promo, sonra nakit — promo kredisi hiçbir yoldan nakde dönemez.

### 2.6 Payout + batch

```sql
CREATE TYPE payout_status       AS ENUM ('pending','processing','in_transit','paid','failed','reversed');
CREATE TYPE payout_batch_status AS ENUM ('open','locked','submitted','reconciling','completed','failed');

CREATE TABLE payout_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL CHECK (provider IN ('stripe_connect','deel','wise')),
  status       payout_batch_status NOT NULL DEFAULT 'open',
  period_start date NOT NULL,
  period_end   date NOT NULL,
  total_cents  bigint NOT NULL DEFAULT 0,
  locked_at    timestamptz, submitted_at timestamptz, completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

CREATE TABLE payout (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id               uuid NOT NULL REFERENCES teacher(id),
  batch_id                 uuid REFERENCES payout_batch(id),
  provider                 text NOT NULL CHECK (provider IN ('stripe_connect','deel','wise')),
  amount_cents             bigint NOT NULL CHECK (amount_cents > 0),
  currency                 char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'), -- payable tarafı USD
  target_currency          char(3),                       -- F46: vendor'a talimat (EGP, TRY, ...)
  fx_rate                  numeric(18,8),                 -- F10/F46: settle anı snapshot
  settled_amount_cents     bigint,
  provider_fee_cents       bigint,
  -- F1: ÇAĞRIDAN ÖNCE persist edilen, client-üretimi anahtar; Stripe Idempotency-Key /
  -- Wise customerTransactionId olarak gönderilir → çift ÇAĞRI provider'da da tekilleşir
  provider_idempotency_key text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  external_ref             text,                          -- provider yanıt id'si (yazım: NULL→değer, tek sefer)
  status                   payout_status NOT NULL DEFAULT 'pending',
  claimed_by               text,                          -- F1: worker lease
  claimed_at               timestamptz,
  failure_reason           text,
  ledger_transaction_id    uuid REFERENCES ledger_transaction(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  submitted_at             timestamptz, settled_at timestamptz,
  UNIQUE (id, teacher_id)                                 -- F51: payout_line bileşik FK hedefi
);
CREATE UNIQUE INDEX payout_external_ref_uq
  ON payout (provider, external_ref) WHERE external_ref IS NOT NULL;   -- SERT KISIT korunur
CREATE INDEX idx_payout_teacher ON payout (teacher_id, status);
CREATE INDEX idx_payout_claim   ON payout (created_at) WHERE status = 'pending';

CREATE TABLE payout_line (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payout_id    uuid NOT NULL,
  teacher_id   uuid NOT NULL,
  session_id   uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  released_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- F51: satır ancak payout ile AYNI eğitmene ait olabilir
  FOREIGN KEY (payout_id, teacher_id) REFERENCES payout (id, teacher_id),
  -- F51: satır ancak finalize edilmiş ve AYNI eğitmene ait ekonomi kaydına bağlanabilir
  FOREIGN KEY (session_id, teacher_id) REFERENCES session_economics (session_id, teacher_id)
);
CREATE UNIQUE INDEX payout_line_session_once
  ON payout_line (session_id) WHERE released_at IS NULL;
CREATE INDEX idx_payout_line_payout ON payout_line (payout_id);        -- F52
```

**Payout işletim kuralları:**
- **Tek-worker garantisi (F1):** `pending` satır alma = `SELECT ... FOR UPDATE SKIP LOCKED` + `claimed_by/claimed_at` yazımı. `processing`'de takılan payout'lar reconciler tarafından provider'dan `provider_idempotency_key` ile sorgulanıp duruma eşlenir — crash penceresi çift transfer üretemez.
- **Durum makinesi trigger'ı (F38):** geçiş whitelist'i `pending→processing→in_transit→paid`, `pending|processing|in_transit→failed`, `paid→reversed`. **`failed` terminaldir; `failed→paid` DB'de reddedilir.** Geç gelen "aslında ödendi" event'i webhook'ta `skipped` işaretlenir ve mutabakat kuyruğuna düşer; ödeme provider requery ile doğrulanırsa süreç `payout_reversal`/`manual_adjustment` üzerinden insan-onaylı çözülür.
- **Release kuralı (F38):** `released_at` yalnız reconciler'ın **aktif requery ile doğruladığı** terminal failure sonrası yazılır; webhook tek başına release tetiklemez.
- **Kolon dondurma (F6):** BEFORE UPDATE trigger — `amount_cents`, `teacher_id`, `provider`, `currency`, `provider_idempotency_key` değişimi RAISE; `external_ref` yalnız NULL→değer (tek sefer). Yeniden deneme daima **yeni payout satırı**dır.
- **Toplam kısıtları (F12):** `status→processing` geçişinde trigger: `amount_cents = Σ(payout_line WHERE released_at IS NULL)`. Batch `lock` anında constraint trigger: seans başına **released dahil** `Σ(payout_line.amount_cents) ≤ session_economics.teacher_paid_cents` (çifte ödemeye son savunma) ve `batch.total_cents = Σ(payout.amount_cents)`.

---

## 3. FİYAT — Pool / PriceCard / Package / marj

### 3.1 Katalog

```sql
CREATE TABLE pool (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  is_magnet  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE price_card (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id                uuid NOT NULL REFERENCES pool(id),
  sell_cents_per_hour    int NOT NULL CHECK (sell_cents_per_hour > 0),
  cost_cents_per_hour    int NOT NULL CHECK (cost_cents_per_hour > 0
                                         AND cost_cents_per_hour < sell_cents_per_hour),
  -- F11: birleşik indirim tavanı ŞEMADA; tavan uygulansa bile satış ≥ maliyet garantisi
  max_total_discount_bps int NOT NULL DEFAULT 4000 CHECK (max_total_discount_bps BETWEEN 0 AND 5000),
  effective              daterange NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (sell_cents_per_hour * (10000 - max_total_discount_bps) >= cost_cents_per_hour * 10000),
  EXCLUDE USING gist (pool_id WITH =, effective WITH &&)
);
-- F50: mutation trigger — UPDATE yalnız effective üst sınırını KAPATABİLİR (kartı emekli etme);
-- başka her kolon değişikliği RAISE. Yeni fiyat = yeni satır. + generic satır-audit trigger'ı.
-- F23: REVOKE SELECT (cost_cents_per_hour, max_total_discount_bps) ON price_card FROM role_school;
CREATE VIEW price_card_public_v WITH (security_invoker = true) AS
  SELECT id, pool_id, sell_cents_per_hour, effective FROM price_card;
GRANT SELECT ON price_card_public_v TO role_school;

CREATE TABLE package (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id        uuid NOT NULL REFERENCES pool(id),
  name           text NOT NULL,
  hours_per_week numeric(4,1) NOT NULL CHECK (hours_per_week > 0),
  min_weeks      int NOT NULL DEFAULT 4 CHECK (min_weeks > 0),
  discount_bps   int NOT NULL DEFAULT 0 CHECK (discount_bps BETWEEN 0 AND 3000),
  active         boolean NOT NULL DEFAULT true,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

**Finalize assert'i (F11):** birleşik indirim = `LEAST(paket_bps + tier_bps, price_card.max_total_discount_bps)`; finalize fonksiyonu `effective_sell ≥ cost` doğrular (CHECK sayesinde matematiksel olarak garantidir ama savunma-derinliği için assert kalır). Negatif marj yapısal olarak temsil edilmez; bilinçli zarar isteniyorsa tek yol açık `manual_adjustment`tır.

### 3.2 Fiyat sabitleme (F56)

- Fiyat snapshot'ı **booking'den session'a indirildi**: her occurrence materialize edilirken **o günkü** geçerli karttan `session.sell_cents_per_hour` (+ economics'e cost) yazılır. Geçmişin değişmezliği zaten session-düzeyi snapshot'tadır.
- Booking yalnız `price_card_id` soy izi + opsiyonel `price_locked_until date` taşır: kilit süresi boyunca occurrence'lar kilitli karttan, sonrasında güncel karttan açılır. Fiyat artışı mevcut tabana **yapısal olarak** ulaşır; cancel+recreate operasyonu gerekmez.

### 3.3 Disintermediation marj mekaniği (F37, F50)

```sql
-- F50: tier tanımı append-only tarihçe (price_card ile aynı disiplin)
CREATE TABLE margin_schedule (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tier         smallint NOT NULL,
  min_hours    numeric(7,1) NOT NULL,
  discount_bps int NOT NULL CHECK (discount_bps BETWEEN 0 AND 5000),
  effective    daterange NOT NULL,
  EXCLUDE USING gist (tier WITH =, effective WITH &&)
);

-- F37: İNDİRİM BİRİKİMİ (okul, havuz) DÜZEYİNDE — eğitmen rotasyonu/backfill fiyatı etkilemez
CREATE TABLE school_pool_volume (
  school_id           uuid NOT NULL REFERENCES school(id),
  pool_id             uuid NOT NULL REFERENCES pool(id),
  completed_min_total bigint NOT NULL DEFAULT 0,
  current_tier        smallint NOT NULL DEFAULT 1,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, pool_id)
);

-- Disintermediation ANALİTİĞİ için pair tablosu kalır (fiyatlamada kullanılmaz)
CREATE TABLE school_teacher_pair (
  school_id           uuid NOT NULL REFERENCES school(id),
  teacher_id          uuid NOT NULL REFERENCES teacher(id),
  first_session_at    timestamptz,
  completed_min_total bigint NOT NULL DEFAULT 0,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, teacher_id)
);
```

**Yazma disiplini (F50):** `school_pool_volume`/`school_teacher_pair` sayaçları **yalnız** finalize SECURITY DEFINER path'inden artar (uygulama rollerine UPDATE grant'i yok); elle düzeltme `manual_adjustment` benzeri onaylı ayrı satırdır. `margin_schedule`/`price_card`/`school_pool_volume` üçlüsünde generic satır-audit trigger'ı (before/after → audit_log) DB'de zorlanır.

Disintermediation ekonomisi değişmedi: yeni okul↔havuz ilişkisi tier-1 (tam marj), hacimle indirim; snapshot `session.applied_discount_bps`'te.

### 3.4 Yuvarlama fonksiyonu (F13)

```sql
-- Pozitif tutarlar için half-even; TÜM para türetmelerinin tek yuvarlama noktası
CREATE FUNCTION cents_round(x numeric) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN x - floor(x) = 0.5
              THEN (floor(x)::bigint + (floor(x)::bigint % 2))   -- .5 → çift komşuya
              ELSE round(x)::bigint END
$$;
-- charged  = cents_round(sell_cph  * billed_min  / 60.0 * (10000 - toplam_bps) / 10000.0)
-- teacher  = cents_round(cost_cph  * payable_min / 60.0)
-- invoice_line/statement bu değerleri KOPYALAR; yeniden hesap CI/trigger ile yasak.
```

---

## 4. DISPATCH — Booking / Assignment / Session / Slot / Backfill

### 4.1 Recurrence kararı (korundu) + occurrence kimliği (değişti — F29/F40/F42)

Booking RRULE+timezone tutar; dispatch agent rolling 6 haftalık ufku `session` satırlarına açar. **Occurrence kimliği artık UTC instant değil, duvar-saati kimliğidir**: `occurrence_key = 'YYYY-MM-DD#n'` (booking timezone'unda lokal tarih + gün-içi slot sırası). tzdata/DST değişiminde henüz başlamamış seansların `starts_at/ends_at`'i **UPDATE ile düzeltilir** — kimlik sabit kaldığı için duplikasyon imkânsız. Deterministik politika: **nonexistent lokal saat → sonraki geçerli an; ambiguous → ilk offset.**

### 4.2 Durum makineleri (delikler kapatıldı — F33, F36)

- **booking**: `draft → pending_assignment → active ⇄ paused → ended`; pre-ended her durumdan `cancelled`. **Pause/cancel akışı aynı işlemde ufuktaki canlı seansları toplu `void`'e alır ve açık backfill_request'leri kapatır** (void tanımı genişletildi: *hatalı üretim VEYA plan iptali; para-nötr*).
- **assignment**: `offered → accepted → active → replaced|withdrawn|ended`; `offered → declined|expired`.
- **session** geçiş whitelist'i (DB'de `session_transition(from_status,to_status)` tablosu + trigger ile zorlanır):
  - `scheduled → in_progress | pending_backfill | cancelled_by_school | cancelled_by_teacher | no_show_teacher | void`
  - `in_progress → completed | no_show_school` *(F33a: eğitmen girdi, öğrenci gelmedi)*
  - `pending_backfill → scheduled | unfilled | cancelled_by_school | void` *(F33c: backfill beklerken iptal meşru; aynı txn'de request `revoked/failed`)*
  - Eğitmen ders-anı no-show tespiti `scheduled → pending_backfill` (reason `teacher_no_show`) ile **canlı backfill'e girer** (F33b); pencere yoksa `scheduled → no_show_teacher`.

```sql
CREATE TYPE booking_status    AS ENUM ('draft','pending_assignment','active','paused','ended','cancelled');
CREATE TYPE assignment_role   AS ENUM ('primary','reserve');
CREATE TYPE assignment_status AS ENUM ('offered','accepted','declined','expired','active','replaced','withdrawn','ended');
CREATE TYPE session_status    AS ENUM ('scheduled','pending_backfill','in_progress','completed',
                                       'cancelled_by_school','cancelled_by_teacher',
                                       'no_show_teacher','no_show_school','unfilled','void');
CREATE TYPE video_provider    AS ENUM ('superclass','zoom','ms_teams','google_meet','perculus');

CREATE TABLE class_group (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES school(id),
  name       text NOT NULL,
  grade      text,
  size       int CHECK (size > 0),
  timezone   text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, school_id)
);
-- F45: soft-delete'li tabloda tekillik daima partial
CREATE UNIQUE INDEX class_group_name_uq
  ON class_group (school_id, name) WHERE deleted_at IS NULL;

CREATE TABLE booking (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES school(id),
  class_group_id    uuid NOT NULL,
  pool_id           uuid NOT NULL REFERENCES pool(id),
  package_id        uuid REFERENCES package(id),
  dosage_plan_id    uuid NOT NULL,
  price_card_id     uuid NOT NULL REFERENCES price_card(id),   -- soy izi
  price_locked_until date,                                     -- F56
  rrule             text NOT NULL,
  timezone          text NOT NULL,
  duration_min      int  NOT NULL CHECK (duration_min BETWEEN 20 AND 240),
  starts_on         date NOT NULL,
  ends_on           date,
  status            booking_status NOT NULL DEFAULT 'draft',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, school_id),
  FOREIGN KEY (class_group_id, school_id) REFERENCES class_group (id, school_id),
  -- F20/F39: dosage bağı bileşik FK — tenant + sınıf + havuz hizası ŞEMADA
  FOREIGN KEY (dosage_plan_id, school_id, class_group_id, pool_id)
    REFERENCES dosage_plan (id, school_id, class_group_id, pool_id)
);
-- F16: v1'deki sell/cost snapshot kolonları booking'den KALDIRILDI (session + economics'e taşındı)
CREATE INDEX idx_booking_school ON booking (school_id, status);

CREATE TABLE assignment (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                uuid NOT NULL,
  school_id                 uuid NOT NULL,
  teacher_id                uuid NOT NULL REFERENCES teacher(id),
  role                      assignment_role   NOT NULL,
  status                    assignment_status NOT NULL DEFAULT 'offered',
  offered_at                timestamptz NOT NULL DEFAULT now(),
  expires_at                timestamptz,
  responded_at              timestamptz,
  -- F34: kabul anındaki offset damgaları; DST revalidation job offset değişince re-confirm ister
  accepted_teacher_offset_min smallint,
  accepted_school_offset_min  smallint,
  created_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (booking_id, school_id) REFERENCES booking (id, school_id)
);
-- F36: tekillik KABUL aşamasını da kapsar — iki 'accepted' primary imkânsız
CREATE UNIQUE INDEX assignment_one_live_primary
  ON assignment (booking_id) WHERE role = 'primary' AND status IN ('accepted','active');
CREATE UNIQUE INDEX assignment_live_offer_uq
  ON assignment (booking_id, teacher_id) WHERE status IN ('offered','accepted','active');
CREATE INDEX idx_assignment_teacher ON assignment (teacher_id, status);            -- F52
CREATE INDEX idx_assignment_expiry  ON assignment (expires_at) WHERE status = 'offered';  -- F52
```
Accept akışı CAS'tır: `UPDATE assignment SET status='accepted' WHERE id=$a AND status='offered'`; unique'e takılan kabul aynı txn'de `expired` yapılır ve eğitmene "slot doldu" döner.

### 4.3 Rezervasyon çakışması: `session_slot` (F32, F43)

Çakışma EXCLUDE'ları en sıcak tablodan (session) **ince bir rezervasyon tablosuna** taşındı: predicate'siz GiST → durum makinesi evrimi constraint rebuild istemez, status geçişleri GiST churn üretmez; satırlar yalnız canlı rezervasyonlardır (küçük tablo).

```sql
CREATE TABLE session_slot (
  session_id     uuid PRIMARY KEY,
  school_id      uuid NOT NULL,
  teacher_id     uuid,                       -- NULL = backfill bekliyor
  class_group_id uuid NOT NULL,
  during         tstzrange NOT NULL,
  FOREIGN KEY (session_id, school_id) REFERENCES session (id, school_id) ON DELETE CASCADE,
  CONSTRAINT no_teacher_double_book EXCLUDE USING gist (teacher_id WITH =, during WITH &&)
    WHERE (teacher_id IS NOT NULL),
  CONSTRAINT no_class_double_book   EXCLUDE USING gist (class_group_id WITH =, during WITH &&)
);
```

**Yaşam döngüsü (trigger ile bakımlı):** session `scheduled|pending_backfill|in_progress` iken slot satırı vardır; terminal geçişte silinir. `pending_backfill`'de **sınıf slotu rezerve kalır** (teacher_id NULL'lanır) → F32'deki "doldurma anında geç exclusion patlaması" yapısal olarak biter; fill işlemi yalnız teacher tarafı exclusion'ına tabidir (bu da istenendir: eğitmen gerçekten çifte-book edilemesin).

### 4.4 Session

```sql
CREATE TABLE session (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                  uuid NOT NULL,
  school_id                   uuid NOT NULL,
  class_group_id              uuid NOT NULL,
  teacher_id                  uuid REFERENCES teacher(id),
  occurrence_key              text NOT NULL,          -- F29/F42: 'YYYY-MM-DD#n' (booking tz'si)
  starts_at                   timestamptz NOT NULL,
  ends_at                     timestamptz NOT NULL,
  status                      session_status NOT NULL DEFAULT 'scheduled',
  cancelled_late              boolean,
  video_provider              video_provider NOT NULL DEFAULT 'superclass',
  external_meeting_ref        text,
  join_url                    text,
  record_ptr                  text,
  -- F31: üç ayrı dakika — rapor / dozaj / tahsilat ayrışır
  attended_min                int CHECK (attended_min >= 0),  -- eğitmen∩öğrenci kesişimi (şeffaflık)
  counted_min                 int CHECK (counted_min  >= 0),  -- garanti dozaja sayılan (matris kuralı)
  billed_min                  int CHECK (billed_min   >= 0),  -- tahsilat tabanı
  sell_cents_per_hour         int NOT NULL,                   -- F56: materialize anı snapshot (okul-görünür)
  applied_discount_bps        int,
  charge_status               text NOT NULL DEFAULT 'none'
                              CHECK (charge_status IN ('none','pending_funds','charged','failed','waived')),
  charged_cents               bigint,
  finalize_revision           int NOT NULL DEFAULT 0,         -- F14: re-finalize sayacı
  ledger_transaction_id       uuid REFERENCES ledger_transaction(id),
  finalized_at                timestamptz,
  rescheduled_from_session_id uuid REFERENCES session(id),    -- F40: geri-alma/yeniden çizelge soy izi
  superseded_by_session_id    uuid REFERENCES session(id),    -- F42: supersede zinciri
  makeup_for_session_id       uuid REFERENCES session(id),    -- F35: telafi bağı
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (id, school_id),                                     -- F20/F44: bileşik-FK hedefi
  FOREIGN KEY (booking_id, school_id)     REFERENCES booking (id, school_id),
  FOREIGN KEY (class_group_id, school_id) REFERENCES class_group (id, school_id)
);
-- F42: occurrence başına TEK "güncel" satır; tombstone yeniden üretimi bloklamaz,
-- reinstate/reschedule = eski satıra superseded_by damgası + yeni satır
CREATE UNIQUE INDEX session_occurrence_current
  ON session (booking_id, occurrence_key) WHERE superseded_by_session_id IS NULL;
CREATE UNIQUE INDEX session_makeup_once
  ON session (makeup_for_session_id) WHERE makeup_for_session_id IS NOT NULL;
CREATE INDEX idx_session_school_time  ON session (school_id, starts_at);
CREATE INDEX idx_session_teacher_time ON session (teacher_id, starts_at);
CREATE INDEX idx_session_backfill     ON session (starts_at) WHERE status = 'pending_backfill';
-- F26: finalize taraması TÜM para-etkili terminal durumları kapsar
CREATE INDEX idx_session_to_finalize  ON session (ends_at)
  WHERE finalized_at IS NULL
    AND status IN ('completed','cancelled_by_school','cancelled_by_teacher',
                   'no_show_teacher','no_show_school','unfilled');
CREATE INDEX idx_session_stuck ON session (ends_at)
  WHERE status = 'in_progress';   -- grace aşımı süpürücüsü
```

**Trigger'lar:**
- **Geçiş whitelist'i** (`session_transition` tablo-güdümlü) — tanımsız geçiş RAISE (F33).
- **Finalize-sonrası dondurma (F51):** `OLD.finalized_at IS NOT NULL` iken `status/teacher_id/starts_at/ends_at/attended_min/counted_min/billed_min` değişimi RAISE — tek meşru yol `attendance_adjustment` + re-finalize akışı. "Cancelled ama charged" yarışı yapısal olarak kapanır (iptal CAS'ı finalize'dan sonra 0 satır günceller).
- **Finalize-outbox (F26):** para-etkili terminal duruma geçen ve `finalized_at IS NULL` olan satır trigger'la `finalize_outbox`'a düşer (`INSERT ... ON CONFLICT DO NOTHING`); index taraması backstop, gece mutabakatında "terminal + unfinalized + yaş>24h" alarmı.
- **Slot bakımı** (§4.3).

```sql
CREATE TABLE finalize_outbox (
  session_id  uuid PRIMARY KEY REFERENCES session(id),
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  attempts    int NOT NULL DEFAULT 0
);
```

### 4.5 Session ekonomisi — karşı-taraf maliyeti ayrı tabloda (F16)

```sql
CREATE TABLE session_economics (
  session_id          uuid PRIMARY KEY,
  school_id           uuid NOT NULL,
  teacher_id          uuid NOT NULL REFERENCES teacher(id),
  cost_cents_per_hour int NOT NULL,               -- materialize anı snapshot
  payable_min         int NOT NULL DEFAULT 0,
  teacher_paid_cents  bigint NOT NULL DEFAULT 0 CHECK (teacher_paid_cents >= 0),
  margin_cents        bigint,
  finalize_revision   int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, teacher_id),                -- payout_line bileşik FK hedefi (F51)
  FOREIGN KEY (session_id, school_id) REFERENCES session (id, school_id)
);
-- RLS: p_teacher (kendi teacher_id'si) + p_platform. role_school'a HİÇBİR grant yok.
-- Yazım yalnız finalize SECURITY DEFINER fonksiyonundan; re-finalize revizyonu audit'lenir.
```

**Kolon-grant matrisi (F16):**
- `role_school` → `session`: para kolonlarından yalnız `charged_cents`, `billed_min`, `applied_discount_bps` (kendi fiyatı/faturası); `session_economics`: erişim yok.
- `role_teacher` → `session`: kolon-listesi grant — `charged_cents/applied_discount_bps/sell_cents_per_hour` **listede yok** (satış fiyatı eğitmene kapalı); kendi kazancını `session_economics` RLS'inden okur.
- Çift yönlü ekonomi sızıntısı (okul→maliyet, eğitmen→satış) DB düzeyinde kapanır.

### 4.6 Backfill / reserve-pool (F28, F25)

```sql
CREATE TYPE backfill_status AS ENUM ('open','offering','filled','failed','revoked');
CREATE TYPE offer_status    AS ENUM ('sent','accepted','declined','expired','revoked');

CREATE TABLE backfill_request (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id           uuid NOT NULL,
  school_id            uuid NOT NULL,
  reason               text NOT NULL CHECK (reason IN
                       ('teacher_cancelled','teacher_no_show','assignment_withdrawn','availability_conflict')),
  dropped_teacher_id   uuid REFERENCES teacher(id),   -- F25: platform-only (grant/view ile)
  sla_deadline         timestamptz NOT NULL,
  status               backfill_status NOT NULL DEFAULT 'open',
  filled_by_teacher_id uuid REFERENCES teacher(id),
  filled_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, school_id) REFERENCES session (id, school_id)   -- F20/F44
);
CREATE UNIQUE INDEX backfill_one_open
  ON backfill_request (session_id) WHERE status IN ('open','offering');
-- F25: role_school bu tabloyu değil, dropped_teacher_id'siz + anonim-reason'lı
-- backfill_request_school_v (security_invoker) view'ını okur. Offer bağlamına düşen
-- eğitmenin kimliği hiç konmaz (cross-actor itibar sızıntısı yok).

CREATE TABLE backfill_offer (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backfill_request_id uuid NOT NULL REFERENCES backfill_request(id),
  teacher_id          uuid NOT NULL REFERENCES teacher(id),
  status              offer_status NOT NULL DEFAULT 'sent',
  sent_at             timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  responded_at        timestamptz,
  UNIQUE (backfill_request_id, teacher_id)
);
-- F28: request başına TEK kabul — ikinci accept DB'de düşer
CREATE UNIQUE INDEX backfill_offer_one_accept
  ON backfill_offer (backfill_request_id) WHERE status = 'accepted';
CREATE INDEX idx_offer_teacher ON backfill_offer (teacher_id) WHERE status = 'sent';   -- F52
CREATE INDEX idx_offer_expiry  ON backfill_offer (expires_at) WHERE status = 'sent';   -- F52
```

**Doldurma protokolü (F28, tek DB txn):**
1. `UPDATE backfill_offer SET status='accepted' WHERE id=$o AND status='sent'` (+ partial unique — kaybeden burada düşer).
2. `UPDATE backfill_request SET status='filled', filled_by_teacher_id=$t WHERE id=$r AND status IN ('open','offering')` — 0 satır = kaybettin.
3. `UPDATE session SET teacher_id=$t, status='scheduled' WHERE id=$s AND status='pending_backfill'` + slot teacher_id yazımı (teacher exclusion burada doğal kontrol).
4. **İptal-vs-kabul yarışı:** iptal akışı aynı request satırını kilitleyip `revoked` yapar ve açık offer'ları `revoked`'a çeker — kabul CAS'ı 0 satır günceller.

### 4.7 Eğitmen müsaitliği + DST yeniden doğrulama (F34)

```sql
CREATE TABLE teacher_availability (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid NOT NULL REFERENCES teacher(id),
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_local time NOT NULL,
  end_local   time NOT NULL,
  timezone    text NOT NULL,
  valid_from  date NOT NULL DEFAULT current_date,
  valid_to    date,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_local > start_local)
);
CREATE INDEX idx_avail_teacher ON teacher_availability (teacher_id, weekday);

CREATE TABLE teacher_time_off (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES teacher(id),
  period     tstzrange NOT NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (teacher_id WITH =, period WITH &&)
);
```

**Kurallar (F34):**
1. **Materialization'da zorunlu re-check:** her occurrence açılırken UTC projeksiyonu availability+time_off'a karşı doğrulanır; uyumsuz occurrence **sessizce eğitmenli doğmaz** — `teacher_id NULL + pending_backfill + reason='availability_conflict'` (enum değeri artık ölü kod değil, bunu üreten tanımlı mekanizma bu).
2. **DST-sınırı revalidation job'ı:** herhangi bir tarafın UTC offset'i değiştiğinde materialize ufku yeniden doğrular; kayan occurrence'lar 1'deki yola düşer.
3. `assignment.accepted_*_offset_min` damgaları: offset çifti değişince eğitmenden tek-tık yeniden onay istenir.

### 4.8 Finalize zamanlaması + re-finalize (F14, F26)

- **Gate:** finalize koşulu = `attendance-complete OR ends_at + grace(provider)` — superclass 5 dk; zoom/ms_graph/google_meet/perculus 60 dk.
- **Geç attendance:** finalized seansa geç event gelirse dakikalar yeniden türetilir; fark varsa **otomatik**: tam ters txn (`reversal:<orig>`) + yeni finalize txn (`session_refinal:<session_id>:r<n>`), `finalize_revision++`, economics revizyonu audit'li. İnsan gerekmiyor.
- **Tarama:** §4.4'teki genişletilmiş partial index + `finalize_outbox` + gece alarmı — geç iptal / no-show / unfilled artık para döngüsünün **içindedir** (F26).

### 4.9 İptal / no-show / geç-iptal matrisi (F31 ile üç-dakika modeline bağlandı)

Finalize anında `(attended_min, counted_min, billed_min, payable_min)` dörtlüsü **tek test edilebilir fonksiyonla** yazılır; `charged = f(billed_min)`, `teacher_paid = f(payable_min)`:

| Olay | attended | counted | billed | payable | Okul | Eğitmen | Ek etki |
|---|---|---|---|---|---|---|---|
| Tamamlanan ders | kesişim dk | duration | duration | duration | %100 | %100 | — |
| Okul iptali ≥24h | 0 | 0 | 0 | 0 | 0 | 0 | satır tombstone; occurrence supersede ile yeniden üretilebilir |
| Okul geç iptali <24h | 0 | duration | duration | duration | %100 | %100 | utilization'da "teslim edildi/kullanılmadı" (attended=0) |
| Eğitmen iptali ≥24h | 0 | 0 | 0 | 0 | 0 | 0 | backfill normal akış |
| Eğitmen geç iptali <24h | 0 | 0 | 0 | 0 | 0 | 0 | backfill; dolmazsa `unfilled`; strike |
| Eğitmen no-show | 0 | 0 | 0 | 0 | 0 (+SLA kredisi) | 0 | strike; `makeup_for_session_id` ile telafi |
| Okul no-show (eğitmen geldi) | 0 | duration | duration | duration | %100 | %100 | attended=0 dashboard'da görünür |
| `unfilled` (SLA kaçtı) | 0 | 0 | 0 | 0 | 0 + SLA kredisi | 0 | SLA raporu; makeup |

Rollup `delivered/missed`'i **counted_min**'den, "teslim edildi ama kullanılmadı" görünümünü **attended_min**'den okur; para daima **billed/payable**'dan türetilir — çelişki sınıfı kapandı.

### 4.10 Tatil/blackout takvimi (F35)

```sql
CREATE TABLE school_calendar_exception (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES school(id),
  period     daterange NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('holiday','closure')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (school_id WITH =, period WITH &&)
);
```
Materialization bu aralıkları **atlar** (occurrence hiç doğmaz → iptal/ücret riski sıfır); rollup muaf haftada `exempt_min` düşer (§6.2); telafi `session.makeup_for_session_id` ile denetlenebilir kapanır.

---

## 5. HR — Teacher + onboarding pipeline

Pipeline değişmedi: `invited → docs_pending → kyc_pending → contract_pending → payout_setup → curation_review → active`; yan durumlar `rejected/suspended/offboarded`. PII kararı değişmedi: içerik vendor'da, bizde `status + external_ref`.

```sql
CREATE TYPE onboarding_status AS ENUM ('invited','docs_pending','kyc_pending','contract_pending',
                                       'payout_setup','curation_review','active',
                                       'rejected','suspended','offboarded');

CREATE TABLE teacher (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name        text NOT NULL,          -- PII
  display_name      text NOT NULL,
  email             citext NOT NULL,        -- PII
  phone             text,                   -- PII
  country_code      char(2) NOT NULL,
  timezone          text NOT NULL,
  onboarding_status onboarding_status NOT NULL DEFAULT 'invited',
  reliability_score numeric(4,3) CHECK (reliability_score BETWEEN 0 AND 1),
  strikes           int NOT NULL DEFAULT 0,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- F45: tam UNIQUE yerine partial — offboarded eğitmen aynı email'le temiz yeniden başvurabilir
CREATE UNIQUE INDEX teacher_email_uq ON teacher (email) WHERE deleted_at IS NULL;
-- RLS + role_school grant yok (F17, §1.4)

CREATE TABLE teacher_pool (
  teacher_id uuid NOT NULL REFERENCES teacher(id),
  pool_id    uuid NOT NULL REFERENCES pool(id),
  status     text NOT NULL DEFAULT 'candidate'
             CHECK (status IN ('candidate','active','paused','removed')),
  since      date NOT NULL DEFAULT current_date,
  PRIMARY KEY (teacher_id, pool_id)
);
CREATE INDEX idx_pool_active_teachers ON teacher_pool (pool_id) WHERE status = 'active';  -- F52

CREATE TABLE verification_check (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id   uuid NOT NULL REFERENCES teacher(id),
  provider     text NOT NULL CHECK (provider IN ('checkr','persona')),
  check_type   text NOT NULL CHECK (check_type IN ('identity','background','education')),
  external_ref text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','clear','consider','failed','expired')),
  completed_at timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_ref)
);

-- F24/F57: polimorfik subject KALDIRILDI → gerçek FK'ler + RLS kalıbına giriş
CREATE TABLE esign_document (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid REFERENCES school(id),
  teacher_id   uuid REFERENCES teacher(id),
  doc_type     text NOT NULL CHECK (doc_type IN
               ('teacher_contract','school_msa','dpa','non_circumvention')),
  provider     text NOT NULL DEFAULT 'docusign',
  envelope_ref text NOT NULL,
  status       text NOT NULL DEFAULT 'sent'
               CHECK (status IN ('sent','viewed','signed','declined','voided')),
  signed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, envelope_ref),
  CHECK (num_nonnulls(school_id, teacher_id) = 1)
);

CREATE TABLE tax_form (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id   uuid NOT NULL REFERENCES teacher(id),
  form_type    text NOT NULL CHECK (form_type IN ('w9','w8ben','w8bene')),
  provider     text NOT NULL,
  external_ref text NOT NULL,
  status       text NOT NULL DEFAULT 'requested'
               CHECK (status IN ('requested','submitted','validated','expired')),
  valid_until  date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_ref)
);

CREATE TABLE teacher_payout_method (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id           uuid NOT NULL REFERENCES teacher(id),
  provider             text NOT NULL CHECK (provider IN ('stripe_connect','deel','wise')),
  external_account_ref text NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','verified','disabled')),
  is_default           boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- F45: disabled satır aynı IBAN'ın yeniden eklenmesini bloklamasın
CREATE UNIQUE INDEX payout_method_ref_uq
  ON teacher_payout_method (provider, external_account_ref) WHERE status <> 'disabled';
CREATE UNIQUE INDEX one_default_payout_method
  ON teacher_payout_method (teacher_id) WHERE is_default;

CREATE TABLE contract (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid REFERENCES school(id),      -- F24/F57
  teacher_id        uuid REFERENCES teacher(id),
  esign_document_id uuid REFERENCES esign_document(id),
  terms             jsonb NOT NULL,
  non_circumvention boolean NOT NULL DEFAULT true,
  effective_from    date NOT NULL,
  effective_to      date,
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','terminated','expired')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(school_id, teacher_id) = 1),
  UNIQUE (id, school_id)     -- dosage_plan bileşik FK hedefi (F24)
);
-- RLS (contract + esign_document): (school_id = ANY(app_school_ids()))
--   OR (teacher_id = app.teacher_id) OR platform — IDOR yapısal kapanır.
```

---

## 6. DOSAJ — guaranteed-dosage + utilization + attendance + öğrenci

### 6.1 Öğrenci/roster (F48 — Faz-2 efficacy verisi ilk günden biriksin)

```sql
CREATE TABLE student (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid NOT NULL REFERENCES school(id),
  class_group_id  uuid,
  external_source text NOT NULL CHECK (external_source IN ('clever','csv','manual')),
  external_ref    text,
  display_alias   text NOT NULL,           -- PII-hafif pseudonim; ad/soyad maskeli-view kalıbında
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (class_group_id, school_id) REFERENCES class_group (id, school_id)
);
CREATE UNIQUE INDEX student_ext_uq
  ON student (school_id, external_source, external_ref)
  WHERE external_ref IS NOT NULL AND deleted_at IS NULL;      -- F45 kuralı

CREATE TABLE student_identity (
  student_id      uuid NOT NULL REFERENCES student(id),
  provider        video_provider NOT NULL,
  participant_ref text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, provider, participant_ref),
  UNIQUE (provider, participant_ref)
);
```
Session-logger eşleştirebildiği katılımcıyı `attendance_event.student_id`'ye bağlar; eşleşmeyen opak kalır — cross-provider devamlılık serisi kurulabilir hale gelir.

### 6.2 Dosaj planı + rollup

```sql
CREATE TABLE dosage_plan (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id               uuid NOT NULL REFERENCES school(id),
  class_group_id          uuid NOT NULL,
  pool_id                 uuid NOT NULL REFERENCES pool(id),
  package_id              uuid REFERENCES package(id),
  contract_id             uuid,
  guaranteed_min_per_week int NOT NULL CHECK (guaranteed_min_per_week > 0),
  week_starts_on          smallint NOT NULL DEFAULT 1 CHECK (week_starts_on BETWEEN 0 AND 6),
  timezone                text NOT NULL,
  starts_on               date NOT NULL,
  ends_on                 date,
  status                  text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','paused','ended')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, school_id),                                     -- F20/F39
  UNIQUE (id, school_id, class_group_id, pool_id),            -- booking bileşik FK hedefi
  FOREIGN KEY (class_group_id, school_id) REFERENCES class_group (id, school_id),
  FOREIGN KEY (contract_id, school_id)    REFERENCES contract (id, school_id)  -- F57: okul sözleşmesi garantisi
);

CREATE TABLE dosage_week_rollup (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dosage_plan_id  uuid NOT NULL,
  school_id       uuid NOT NULL,
  week_start      date NOT NULL,
  guaranteed_min  int NOT NULL,
  exempt_min      int NOT NULL DEFAULT 0,   -- F35: tatil/blackout muafiyeti
  scheduled_min   int NOT NULL DEFAULT 0,
  delivered_min   int NOT NULL DEFAULT 0,   -- counted_min'den beslenir (F31)
  attended_min    int NOT NULL DEFAULT 0,   -- şeffaflık görünümü (F31)
  missed_min      int NOT NULL DEFAULT 0,
  makeup_owed_min int NOT NULL DEFAULT 0,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dosage_plan_id, week_start),
  FOREIGN KEY (dosage_plan_id, school_id) REFERENCES dosage_plan (id, school_id)  -- F44
);
CREATE INDEX idx_rollup_school ON dosage_week_rollup (school_id, week_start);      -- F52
```

### 6.3 Attendance — event-per-row (F27 çözümü)

Interval-satır modeli (join+left aynı satır, `left_at` UPDATE ister) append-only kuralıyla çelişiyordu; **salt-insert event modeline** geçildi:

```sql
CREATE TYPE attendance_source AS ENUM ('superclass','provider_webhook','provider_poll','manual');

CREATE TABLE attendance_event (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  session_id       uuid NOT NULL,
  school_id        uuid NOT NULL,
  source           attendance_source NOT NULL,
  provider         video_provider,
  kind             text NOT NULL CHECK (kind IN ('join','leave')),   -- F27
  participant_kind text NOT NULL CHECK (participant_kind IN ('teacher','student','other')),
  participant_ref  text,
  student_id       uuid REFERENCES student(id),   -- F48
  occurred_at      timestamptz NOT NULL,
  webhook_event_id uuid REFERENCES webhook_event(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at),
  FOREIGN KEY (session_id, school_id) REFERENCES session (id, school_id)   -- F20/F44
) PARTITION BY RANGE (occurred_at);                                        -- F54
CREATE INDEX idx_attendance_session ON attendance_event (session_id, occurred_at);
-- forbid_mutation trigger'ı artık modelle TUTARLI: satır hiç UPDATE edilmez.
-- Interval'ler finalize'da join/leave eşleştirilerek türetilir; eşleşmeyen join → ends_at'e kadar sayılır.
```

### 6.4 Manuel düzeltme (F8 guard'ı eklendi)

```sql
CREATE TABLE attendance_adjustment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid NOT NULL,
  school_id       uuid NOT NULL,
  old_counted_min int,
  new_counted_min int NOT NULL CHECK (new_counted_min >= 0),
  reason          text NOT NULL,
  adjusted_by     uuid NOT NULL REFERENCES app_user(id),
  approved_by     uuid REFERENCES app_user(id),   -- para etkisi varsa dört-göz zorunlu
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, school_id) REFERENCES session (id, school_id)   -- F44
);
```

**Payout-yarışı guard'ı (F8), INSERT trigger'ında:**
1. Seansın `released_at IS NULL` payout_line'ı **terminal olmayan** (`pending/processing/in_transit`) bir payout'taysa → adjustment **bloklanır** (payout sonuçlanana kadar).
2. Payout `paid` ise → adjustment "clawback" moduna düşer: ters ledger kaydı `teacher_payable`'ı eksiye çekebilir; negatif payable **platform alarmı** üretir ve bir sonraki payout submit trigger'ı `amount ≤ max(0, teacher_payable bakiyesi + Σyeni lines)` netting kuralını assert eder — fazla ödeme gelecek payout'tan otomatik kesilir.
3. Her düzeltme re-finalize akışını (§4.8) tetikler; hiçbir şey in-place değişmez.

---

## 7. FATURA — prepaid cüzdan + iki belge türü

```sql
CREATE TYPE invoice_kind   AS ENUM ('topup_receipt','consumption_statement');
CREATE TYPE invoice_status AS ENUM ('draft','issued','void');

-- F55: yarışsız, gapless seri — numara issue anında, fatura INSERT'iyle aynı txn'de alınır
CREATE TABLE invoice_series (
  region   text NOT NULL,
  year     int  NOT NULL,
  kind     invoice_kind NOT NULL,
  next_seq int  NOT NULL DEFAULT 1,
  PRIMARY KEY (region, year, kind)
);
-- Numara alma = UPDATE ... SET next_seq = next_seq + 1 RETURNING (satır kilidi serileştirir).
-- Draft numarasız kalır → void kaynaklı gap yok. Resmî TR e-belge numarası entegratörden
-- gelir ve e_invoice_ref'te saklanır; bizim seri iç-denetim serisidir.

CREATE TABLE invoice (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             uuid NOT NULL REFERENCES school(id),
  kind                  invoice_kind NOT NULL,
  number                text UNIQUE,               -- F55: issue'da atanır
  period_start          date,
  period_end            date,
  doc_currency          char(3) NOT NULL DEFAULT 'USD',   -- F46
  fx_rate               numeric(18,8),                    -- F46: TR/GİB kur snapshot'ı
  local_total_cents     bigint,                           -- F46: TRY karşılığı
  subtotal_cents        bigint NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents             bigint NOT NULL DEFAULT 0,
  total_cents           bigint NOT NULL,
  status                invoice_status NOT NULL DEFAULT 'draft',
  ledger_transaction_id uuid REFERENCES ledger_transaction(id),
  e_invoice_ref         text,                      -- yazım: NULL→değer, tek sefer
  issued_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (total_cents = subtotal_cents + tax_cents),        -- F12
  CHECK (status <> 'issued' OR number IS NOT NULL),
  CHECK (kind <> 'consumption_statement'
         OR (period_start IS NOT NULL AND period_end IS NOT NULL))
);
CREATE UNIQUE INDEX invoice_period_uq
  ON invoice (school_id, period_start) WHERE kind = 'consumption_statement';

CREATE TABLE invoice_line (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id   uuid NOT NULL REFERENCES invoice(id),
  ref_type     text NOT NULL CHECK (ref_type IN ('ledger_transaction','sla_credit','adjustment')),
  ref_id       uuid NOT NULL,          -- F13: ledger bağı ZORUNLU — satır tutarı ledger'dan KOPYALANIR
  description  text NOT NULL,
  qty          numeric(8,2) NOT NULL DEFAULT 1,
  unit_cents   bigint NOT NULL,
  amount_cents bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_invoice_line_invoice ON invoice_line (invoice_id);   -- F52
```

**Fatura kuralları:**
- `topup_receipt` mali belge (Stripe ödemesine 1:1), `consumption_statement` bilgilendirici özet — prepaid'de alacak/dunning tablosu yok (değişmedi).
- **Yeniden hesap yasağı (F13):** statement satırları dönemin wallet-debit ledger entry'lerini **kopyalar** (`ref_type='ledger_transaction'`); Σstatement = Σwallet-debit mutabakatı gece işinde assert edilir → PDF özet ile cüzdan ekstresi cent düzeyinde asla ayrışamaz.
- **Issue-sonrası dondurma (F6):** BEFORE UPDATE trigger — `issued` faturada yalnız `status→void` geçişi ve `e_invoice_ref` NULL→değer yazımı serbest; `total/subtotal/tax/number` değişimi RAISE.
- Erişim: `p_school` politikası `app.school_role IN ('owner','admin','finance')` ister (F18).

---

## 8. Audit, değişmezlik politikası, partition/retention, index eki

### 8.1 Audit log (F22)

```sql
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_kind  text NOT NULL CHECK (actor_kind IN
              ('school_user','teacher_user','platform_admin','agent','system','webhook')),
  actor_id    uuid,
  agent_name  text,
  school_id   uuid,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  request_id  text,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, occurred_at);
CREATE INDEX idx_audit_school ON audit_log (school_id, occurred_at);
```

**F22 düzeltmeleri:**
- Taban tablo **platform-only** (RLS + grant: yalnız `role_platform`).
- Okul, audit'i yalnız `audit_log_school_v` (security_invoker) üzerinden okur: action whitelist'i + `before/after`'dan hassas anahtarların (`cost_*`, `teacher_paid_*`, `margin_*`, `legal_name`, `email`, `phone`) **redakte edildiği** projeksiyon. Redaksiyon fonksiyonu tek yerde (`audit_redact(jsonb)`), CI pii-linter'ı view'ı denetler.
- `margin_schedule`/`price_card`/`school_pool_volume` satır-audit trigger'ları buraya yazar (F50) — audit yazımı app'e değil DB'ye emanet.

### 8.2 Değişmezlik politikası v2 (F6/F53 — dört sınıf)

1. **Salt-append (UPDATE/DELETE trigger'la yasak):** `ledger_transaction`, `ledger_entry`, `attendance_event`, `audit_log` — düzeltme daima ters/telafi kaydı.
2. **Durum-mutable, mali-alan-immutable (kolon-düzeyi trigger):** `webhook_event` (status/attempt/next_retry serbest; provider/event_id/payload_min donuk), `payout` (+ `external_ref` NULL→değer tek sefer), `payout_line` (yalnız `released_at` NULL→değer), `invoice` (issue sonrası §7 kuralı), `topup_attempt`. **v1'in "payout*/invoice asla güncellenmez" çelişkisi bu sınıfla çözüldü.**
3. **Durumla silinen:** `booking`, `session`, `assignment`, `contract`, `dosage_plan`, `backfill_request` — terminal durum silme yerine geçer; session'da ek olarak finalize-sonrası dondurma (F51) ve supersede zinciri (F42).
4. **`deleted_at` soft-delete:** `teacher`, `class_group`, `package`, `student` — **kural: bu tablolarda tam UNIQUE yasak, tekillik daima `WHERE deleted_at IS NULL` partial** (F45); CI linter'ı zorlar.

### 8.3 Partition + retention (F54)

- `ledger_entry`, `attendance_event`, `audit_log`: baştan `PARTITION BY RANGE` (aylık); PK'ler `(id, created_at/occurred_at)` — bugün bedava, yarın rewrite.
- `webhook_event`: partitionsız ama **retention'lı** — `processed + 90 gün` sonrası `payload_min` boşaltılır, `raw_ptr` store'u TTL ile kendi kendine düşer; satır + `UNIQUE(provider, event_id)` kalır → idempotency bozulmaz.
- `session`/`session_slot`: slot tablosu yalnız canlı rezervasyon tuttuğu için küçük kalır; session arşiv partitioning'i Faz-3 konusu (satır durumla silindiği için güvenli erteleme).

### 8.4 Index eki (F52 — tamamı yukarıdaki DDL'e işlendi, özet)

`webhook_event(received_at) WHERE status IN ('received','failed')` · `ledger_transaction(ref_type, ref_id)` · `payout_line(payout_id)` · `invoice_line(invoice_id)` · `assignment(teacher_id, status)` · `assignment(expires_at) WHERE status='offered'` · `backfill_offer(teacher_id)/(expires_at) WHERE status='sent'` · `teacher_pool(pool_id) WHERE status='active'` · `dosage_week_rollup(school_id, week_start)` · `payout(created_at) WHERE status='pending'` + CI "index'siz FK" linter'ı.

---

## 9. Karar özeti (tek bakış — güncel)

| Konu | Karar | Tek cümle gerekçe |
|---|---|---|
| Cüzdan bakiyesi | Materialized bakiye **yalnız per-parti hesaplarda** (`track_balance` GENERATED); `min_zero` tipten türetilir; ledger source-of-truth + gece iç/dış mutabakat | Negatif-bakiye guard'ı konfigürasyona değil şemaya gömülü; singleton hot-row serileşmesi yok. |
| Para yazım yolu | Tek SECURITY DEFINER `post_ledger_txn()`: idempotency, kanonik kilit sırası, owner-denorm, seal | Deadlock, çift-işleme ve tarihî-txn enjeksiyonu tek kapıda kapanır. |
| Finalize | **Delivery + settle iki bağımsız idempotent txn**; eğitmen alacağı her koşulda doğar, tahsilat `pending_funds` ile retry | Teslim edilmiş ders okul cüzdanına rehin olamaz; sıfır-insan korunur. |
| Payout | `provider_idempotency_key` çağrı-öncesi persist + provider'a header; lease + reconciler; `failed` terminal; kolon dondurma; Σline assert'leri | Çift ÇAĞRI da çift YANIT da her katmanda yapısal imkânsız. |
| Promosyon | cash/promo cüzdan ayrımı; promo-önce harcama; refund cash-tavanlı + orijinal charge bağlı | Karşılıksız kredi nakde dönemez, dış mutabakat bozulamaz. |
| Recurrence | RRULE + materialized session; **occurrence kimliği duvar saati** (`occurrence_key`) + supersede zinciri | DST/tzdata değişimi duplikasyon değil UPDATE üretir; tombstone yeniden üretimi bloklamaz. |
| Çakışma | Predicate'siz GiST EXCLUDE **`session_slot`** rezervasyon tablosunda | Durum makinesi evrimi rebuild istemez; pending_backfill'de slot rezerve kalır. |
| Dakikalar | `attended / counted / billed / payable` ayrımı; matris → tek test edilebilir fonksiyon | Para, dozaj ve şeffaflık raporu birbirini kirletemez. |
| Fiyat | Snapshot session-materialize anında; booking'te soy izi + `price_locked_until`; indirim tavanı `price_card` CHECK'inde | Zam mevcut tabana ulaşır; negatif marj yapısal temsil edilmez. |
| Disintermediation | İndirim birikimi `(school, pool)` hacminde; pair tablosu analitik; SuperClass-lock + iletişim maskesi | Backfill/rotasyon okula zam olarak yansımaz, teşvik bozulmaz. |
| Tenancy | `organization` + üyelik-temelli `app.school_ids` RLS + bileşik FK her yerde + CI linter | Faz-3 distribütör politika değişikliği istemez; melez-tenant satır şemada imkânsız. |
| AuthZ | Aktör-başına DB rolü + kolon-grant + intra-tenant rol GUC'u + para kolonlarına UPDATE REVOKE | IDOR'a ek olarak intra-tenant privilege ve ekonomi sızıntısı da DB'de kapalı. |
| PII | Vendor-offload + maskeli view + webhook payload redaksiyonu + audit redakte projeksiyonu | Offload'ın kapattığı yüzey arka kapılardan geri gelemez. |
| Attendance | Salt-insert join/leave event'leri; interval finalize'da türetilir; adjustment payout-guard'lı | Append-only ile ödeme trigger'ı artık çelişmiyor. |
| Fatura | topup_receipt + statement; satırlar ledger'dan kopyalanır; `invoice_series` gapless; issue-sonrası donuk | Cent-düzeyi tutarlılık ve TR/GİB uyumu yapısal. |

**Migration sırası (Faz-1):** extensions → organization/identity/tenancy (§1) → pool/price/margin (§3) → teacher/HR (§5) → dosage_plan (§6.2) → dispatch: class_group/booking/assignment/session/session_slot/backfill/calendar (§4) → student/attendance (§6) → ledger/payout/webhook/topup (§2) → invoice (§7) → audit + RLS + rol-grant'ları + trigger'lar (§8) → CI linter'ları. Her adımda DDL DB'de doğrulanmadan ORM'e kolon girmez.

---

## 10. Bulgu kararları

| # | Bulgu (kısa) | Karar | Nasıl / Gerekçe |
|---|---|---|---|
| F1 | Payout crash → çift transfer | Düzeltildi | `provider_idempotency_key` çağrı-öncesi persist + provider header; `claimed_by/at` lease + SKIP LOCKED; reconciler (§2.6) |
| F2 | Yetersiz bakiyede eğitmen alacağı doğmuyor | Düzeltildi | delivery/settle ayrımı + `school_receivable` + `pending_funds` retry + suspend'de ufuk void + `bad_debt` write-off (§2.1–2.2) |
| F3 | Webhook drop-on-crash | Düzeltildi | conflict'te skip yerine FOR UPDATE + yeniden işleme; attempt/next_retry + sweep; dış mutabakat (§2.5) |
| F4 | Reversal tekilliği/tutarı kısıtsız | Düzeltildi | partial UNIQUE(reverses_txn_id) + ayna-trigger + deterministik key; kısmi düzeltme = tam ters + yeni txn (§2.4) |
| F5 | Auto top-up çift çekim | Düzeltildi | `topup_attempt` + deterministik pencere anahtarı Stripe Idempotency-Key olarak + cooldown (§2.5) |
| F6 | Append-only ↔ payout/invoice durum makinesi çelişkisi | Düzeltildi | politika kolon-düzeyine indirildi: sınıf-2 "durum-mutable, mali-alan-immutable" trigger'ları (§8.2) |
| F7 | `min_zero` default false | Düzeltildi | `min_zero`/`track_balance` tipten GENERATED — konfig hatası sınıfı yok (§2.2) |
| F8 | Adjustment × uçuştaki payout | Düzeltildi | aktif payout_line'da adjustment blok; paid sonrası clawback + submit netting assert + negatif-payable alarmı (§6.4) |
| F9 | SLA kredisi nakde çevrilebiliyor | Düzeltildi | cash/promo cüzdan ayrımı; promo-önce harcama; refund cash-tavanlı + orijinal charge kapasite trigger'ı (§2.1, §2.5) |
| F10 | Settle stripe'a sabit; fx/fee yok | Düzeltildi | `wise_balance`/`deel_balance` + provider'a göre settle + `payout_fees` + fx/fee/settled kolonları (§2.1, §2.6) |
| F11 | İndirim istifi negatif marj | Düzeltildi | `price_card.max_total_discount_bps` + `CHECK(sell×(1−max) ≥ cost)` + finalize clamp/assert (§3.1) |
| F12 | Türetilmiş toplamlar kısıtsız | Düzeltildi | submit'te `amount=Σline` trigger; batch-lock toplam assert'leri; invoice total CHECK; mutabakata 3 karşılaştırma (§2.6, §7) |
| F13 | Yuvarlama tanımsız | Düzeltildi | tek `cents_round` (half-even, tek sefer) + downstream yeniden-hesap yasağı (invoice_line ledger'ı kopyalar) (§3.4, §7) |
| F14 | Geç attendance × erken finalize | Düzeltildi | provider-bazlı grace gate + otomatik re-finalize (`session_refinal:<id>:r<n>`, revision sayacı) (§4.8) |
| F15 | Balance trigger deadlock/serileşme | Düzeltildi | F41 ile birleşik: track_balance sınırlaması + kanonik account_id sırası `post_ledger_txn` içinde (§2.3) |
| F16 | Cost/marj okul- ve eğitmen-okunur | Düzeltildi | `session_economics` (teacher+platform RLS) + booking snapshot'ları kaldırıldı + kolon-listesi grant'ler (§4.5) |
| F17 | Teacher tabloları RLS dışı | Düzeltildi | tüm teacher-scoped tablolara FORCE RLS + `role_school`'dan taban REVOKE + security_invoker kuralı (§1.4) |
| F18 | Intra-tenant RBAC/yazma koruması yok | Düzeltildi | `app.school_role`/`app.platform_role` policy koşulları + para kolonlarına UPDATE REVOKE + SECURITY DEFINER finalize (§1.3) |
| F19 | Ledger tenant'sız, txn üç tarafı bundle'lar | Düzeltildi | entry'ye owner denorm + **entry-grain** RLS; txn-grain görünüm yasak kural olarak yazıldı (§2.2–2.3) |
| F20 | Tenant-composite olmayan FK'ler | Düzeltildi | F39/F44 ile birleşik: `UNIQUE(id, school_id)` session/dosage_plan/contract + tüm çocuklarda bileşik FK + CI linter (§4, §6) |
| F21 | webhook payload ham PII | Düzeltildi | `payload_min` whitelist + redaksiyon; ham gövde şifreli TTL store (`raw_ptr`); platform-only grant (§2.5) |
| F22 | audit_log sızıntısı | Düzeltildi | taban platform-only; okula redakte `audit_log_school_v` projeksiyonu (§8.1) |
| F23 | price_card.cost okula açık | Düzeltildi | cost/max_bps kolonlarına REVOKE + `price_card_public_v` (§3.1) |
| F24 | Polimorfik contract/esign IDOR | Düzeltildi | F57 ile birleşik: subject → nullable `school_id`/`teacher_id` FK + `num_nonnulls=1` + RLS + dosage_plan bileşik FK (§5) |
| F25 | dropped_teacher_id itibar sızıntısı | Düzeltildi | kolon platform-only; okul anonim-reason'lı view okur; offer bağlamına kimlik konmaz (§4.6) |
| F26 | Finalize taraması terminal durumları kaçırıyor | Düzeltildi | genişletilmiş partial index + geçiş-trigger'lı `finalize_outbox` + gece "terminal+unfinalized" alarmı (§4.4, §4.8) |
| F27 | attendance append-only ↔ left_at | Düzeltildi | event-per-row (kind join/leave, occurred_at); interval'ler finalize'da eşlenir — a şıkkı seçildi (temiz model) (§6.3) |
| F28 | Backfill çift-kabul / iptal-vs-kabul | Düzeltildi | partial UNIQUE accepted + tek-txn CAS doldurma protokolü + iptal request kilidi/revoke (§4.6) |
| F29 | Occurrence kimliği UTC instant | Düzeltildi | F42 ile birleşik: `occurrence_key` (lokal tarih+sıra) + nonexistent/ambiguous politikası; tzdata değişimi UPDATE olur (§4.1, §4.4) |
| F30 | Finalize tek txn — ders cüzdana rehin | Düzeltildi | F2 ile aynı kök neden; delivery/settle ayrımı + sabit idempotency key'li CAS retry (§2.1) |
| F31 | Faturalanan ≠ dozaj dakikası | Düzeltildi | `attended/counted/billed/payable` dörtlüsü + matris→dakika eşlemesi tek fonksiyonda; rollup counted'dan (§4.9, §6.2) |
| F32 | pending_backfill EXCLUDE dışı | Düzeltildi | `session_slot` pending_backfill'de sınıf slotunu rezerve tutar; fill geç-exclusion'a çarpamaz (§4.3) |
| F33 | Durum makinesi delikleri | Düzeltildi | geçiş whitelist tablosu+trigger; `in_progress→no_show_school`; no-show→canlı backfill; `pending_backfill→cancelled`; booking pause/cancel → toplu void (tanım genişletildi) (§4.2) |
| F34 | Availability DST kayması | Düzeltildi | materialization'da zorunlu re-check → uyumsuz occurrence `pending_backfill(availability_conflict)` doğar; DST revalidation job + assignment offset damgaları (§4.7) |
| F35 | Tatil/blackout modelsiz | Düzeltildi | `school_calendar_exception` (materialization atlar) + rollup `exempt_min` + `makeup_for_session_id` (§4.10, §6.2) |
| F36 | İki 'accepted' primary | Düzeltildi | partial unique `status IN ('accepted','active')` + CAS accept + kaybedene otomatik expired (§4.2) |
| F37 | Backfill tier-1 reset = okula zam | Düzeltildi | indirim birikimi `(school, pool)` düzeyine (`school_pool_volume`); pair tablosu analitik-only (§3.3) |
| F38 | failed→paid geç event çift ödeme | Düzeltildi | failed terminal (trigger reddeder); release yalnız aktif requery sonrası; batch-lock Σline≤paid son savunma (§2.6) |
| F39 | dosage/backfill/attendance FK ihlalleri | Düzeltildi | F20 kapsamında: dosage_plan'da genişletilmiş UNIQUE + booking 4-kolon bileşik FK (pool/class hizası dahil) (§4.4, §6.2) |
| F40 | İptal → geri alma UNIQUE bloğu | Düzeltildi | supersede zinciri seçildi (CAS-revert yerine yeni satır — soy izi ve para izi temiz kalır); canlı tekillik `WHERE superseded_by IS NULL` (§4.4) |
| F41 | Singleton hesap serileşmesi/deadlock | Düzeltildi | F15 ile birleşik: singleton'larda trigger UPDATE yok (rollup), kanonik sıra RPC'de (§2.2–2.3) |
| F42 | Tombstone UNIQUE çakışması | Düzeltildi | F29/F40 ile birleşik: occurrence_key + partial current-unique; regenerate kararı tombstone'dan değil açık supersede akışından (§4.4) |
| F43 | Status-predicate'li GiST EXCLUDE | Düzeltildi | `session_slot` ayrı tablo, predicate'siz EXCLUDE; status churn GiST'e dokunmaz, rebuild gerekmez (§4.3) |
| F44 | Denormalize school_id doğrulanmıyor | Düzeltildi | F20 kapsamında: `UNIQUE(id, school_id)` + tüm çocuklarda bileşik FK + CI linter (§4, §6) |
| F45 | Soft-delete × tam UNIQUE | Düzeltildi | class_group/teacher.email/payout_method tekillikleri partial'a çevrildi; "deleted_at'li tabloda tam UNIQUE yasak" §8.2'de kural + linter |
| F46 | Çok-para-birimine kapalı | Düzeltildi (kısmen) | entry `currency` + para-birimi-başına denge + fx_gain_loss + payout/invoice fx alanları eklendi; **USD-only şema kısıtı değil işlem kuralı** olarak korundu — Faz-1'de fiili non-USD akış açılmıyor, retrofit maliyeti sıfırlandı (§2, §7) |
| F47 | Org/parti katmanı yok | Düzeltildi | `organization` + `school.organization_id` + üyelik-temelli `app.school_ids` RLS; ledger owner_type'a 'organization' eklendi — Faz-3'te politika değişmez (§1.1, §1.3) |
| F48 | Öğrenci/roster yok | Düzeltildi | PII-hafif `student` + `student_identity` + `attendance_event.student_id` — Faz-2 efficacy verisi ilk günden birikir (§6.1) |
| F49 | Tarihî txn'e dengeli entry enjeksiyonu | Düzeltildi | seal trigger (`created_at = transaction_timestamp()`) + tek yazım RPC + gece txn↔entry zaman mutabakatı (§2.3) |
| F50 | Fiyat tabloları tarihçesiz/audit'siz | Düzeltildi | margin_schedule effective+EXCLUDE tarihçe; price_card mutation trigger (yalnız kart emekliliği); satır-audit trigger'ları; sayaçlar yalnız finalize path'inden (§3.1, §3.3, §8.1) |
| F51 | Finalize-sonrası mutasyon / yanlış eğitmene payout | Düzeltildi | session freeze trigger + CAS geçişler + payout_line'ın hem payout(id,teacher_id) hem session_economics(session_id,teacher_id) bileşik FK'leri (§4.4, §2.6) |
| F52 | Index eksikleri | Düzeltildi | önerilen tüm index'ler DDL'e işlendi + "index'siz FK" CI linter'ı (§8.4) |
| F53 | §8 immutability çelişkisi | Düzeltildi | F6 ile birleşik: dört-sınıf politika, sınıf-2 kolon-düzeyi (§8.2) |
| F54 | Partition/retention yok | Düzeltildi | ledger_entry + attendance_event baştan RANGE partitioned; webhook_event retention (payload trim, anahtar kalır) (§8.3) |
| F55 | invoice.number yarışı / gapless | Düzeltildi | `invoice_series` sayaç tablosu, numara issue anında aynı txn'de; draft numarasız → void gap'i yok; resmî TR numarası entegratörde (`e_invoice_ref`) (§7) |
| F56 | Süresiz booking'de fiyat donması | Düzeltildi | snapshot session-materialize anına indirildi; booking'te soy izi + `price_locked_until` (§3.2) |
| F57 | contract/esign FK'siz polimorfizm | Düzeltildi | F24 ile birleşik: gerçek FK'ler + `num_nonnulls=1` + `UNIQUE(id, school_id)` üzerinden dosage_plan sözleşme-okul hizası (§5, §6.2) |

**Reddedilen bulgu yoktur**; iki bulgu önerilen mekanizmadan farklı biçimde çözülmüştür (F27'de interval-UPDATE istisnası yerine event-per-row; F40'ta CAS-revert yerine supersede zinciri) ve bir bulgu kapsam kararıyla kısmen uygulanmıştır (F46: şema çok-para-birimine hazırlandı, USD-only Faz-1 işlem kuralı olarak korundu). Mükerrer bulgular (F30→F2, F39/F44→F20, F41→F15, F42→F29/F40, F53→F6, F57→F24) tek kök-neden düzeltmesinde birleştirilmiştir.