# Scholege Lite — NİHAİ Mimari: Sertleştirilmiş Modüler Monolit

**Statü: KARAR.** Jüri seçimi (monolit) + event-driven'dan para-zırhı graft'ları + buy-maximalist'ten ekip-zamanı satın alan çevresel graft'lar. Çekirdek (ledger, dispatch, session-log) monolitte ve tek Postgres transaction sınırında kalır; garantiler insan disiplinine değil DB mekanizmalarına yaslanır.

---

## 0. Mimari özet + bileşen diyagramı

Tek Docker imajı, iki proses modu (`MODE=web` / `MODE=worker`), tek Postgres 16; kuyruk/cron/ledger/kilit/outbox dahil her garantiyi Postgres'ten alan, modül sınırları paket sınırıyla çizilmiş TypeScript monoliti. Para yolunda: fiziksel append-only + hold modeli + CHECK>=0 + saatlik invariant nöbetçisi + otomatik kill-switch. Çevrede: satın alınmış determinizm (Stripe Express, Wise, LiveKit/Daily, Retool, Checkly, PostHog, Crowdin).

```
                    ┌────────────────────────────────┐
                    │ Checkly sentetik prob (10 dk)   │── signup→topup→booking→join
                    └───────────────┬────────────────┘
                                    ▼
┌───────────────┐  HTTPS  ┌──────────────────────────────────────────────────┐
│ Okul / Eğitmen │───────▶│ Render Web (MODE=web) — tek Docker imajı          │
│ tarayıcı       │        │ Next.js 15: UI + tRPC + /join/{token} + webhooks  │
└───────────────┘        │ better-auth(SSO) · zod DTO maske · pino redact     │
        ▲                 └────────┬──────────────────────────┬──────────────┘
        │ 302 redirect             │ withTenant (SET LOCAL)    │ webhook ingest
        │ (join log yazılır)       │ + RLS                     │ Stripe/Persona/
        │                          ▼                           │ DocuSign/Zoom/Graph
┌───────┴───────────┐   ┌─────────────────────────────────────▼──────────────┐
│ Video sağlayıcılar │   │ Postgres 16 (tek instance, session-mode bağlantı)   │
│ SuperClass         │   │ ledger_txn/leg (append-only TRİGGER, SUM=0)         │
│  └ LiveKit/Daily   │   │ school_wallet (CHECK balance>=0) · hold hesabı      │
│ Zoom · MS Graph    │   │ assignment (EXCLUDE gist) · session_event           │
│ Meet · Perculus    │   │ webhook_event UNIQUE · outbox · pg-boss · RLS       │
└───────────────────┘   └──────────┬─────────────────────────────────────────┘
                                    │ pg-boss jobs + outbox dispatch
                                    ▼
                  ┌──────────────────────────────────────────────┐
                  │ Render Worker (MODE=worker, aynı imaj)        │
                  │ materializer (DST revalidasyonlu) · matcher   │
                  │ backfill SM · settle (hold→charge) · payout   │
                  │ 15 dk payout mutabakatı · SAATLİK invariant    │
                  │   └─ ihlalde KILL-SWITCH: para akışı durur    │
                  └───────┬───────────────────────┬──────────────┘
                          ▼                       ▼
              ┌────────────────────────┐ ┌──────────────────────────┐
              │ Para vendorları         │ │ Retool (yalnız iç admin)  │
              │ Stripe Checkout/Connect │ │ havuz kürasyonu ·         │
              │ Express/Invoicing       │ │ escalated backfill ·      │
              │ Wise Platform (fallback)│ │ ledger adjustment         │
              └────────────────────────┘ └──────────────────────────┘
  Gözlem: Sentry (client+server+replay) · pino→Axiom/Betterstack · PostHog funnel
```

---

## 1. Stack

| Karar | Seçim |
|---|---|
| Dil | **TypeScript** her yerde — web/worker/agent tek dil, tek zihinsel model. |
| Framework | **Next.js 15 (App Router)** UI + API/webhook route'ları; **worker.ts** ayrı entrypoint, aynı imaj, aynı domain modülleri. |
| İç API | **tRPC** + **zod** her sınırda — hata zarfı ve tip güvenliği derleyici seviyesinde. |
| DB | **Postgres 16, tek instance** (Render managed), **session-mode bağlantı** — pgbouncer transaction-pooling YASAK (advisory lock, `SET LOCAL` RLS, pg-boss semantiği kırılır). PITR + otomatik failover gün-1'den açık. |
| ORM/Migration | **Drizzle ORM + drizzle-kit** — düz SQL migration dosyaları, insan-review edilebilir; şema-kod ayrımı §8'deki disiplini taşır. |
| Job/queue/cron/outbox | **pg-boss v10** aynı Postgres'te; Redis yok. pg-boss tabloları ayrı şemada (`queue.*`) — ileride kuyruğu ayırma dikişi baştan çizili. |
| Hosting | **Render**: 1 web + 1 worker (aynı imaj) + managed Postgres; migration release-phase'de app'ten önce koşar. |
| İç admin | **Retool** — havuz kürasyonu, escalated-backfill kuyruğu, ledger adjustment ekranları. Asla müşteri-yüzlü değil; monorepoda admin app'i YOK, mühendis-haftası dispatch/para yoluna gider. |
| Monorepo | pnpm workspace: `apps/platform` · `packages/db` · `packages/modules/{ledger,dispatch,video,hr,billing,agents}` · `packages/shared`. Modül sınırı = paket sınırı; eslint `no-restricted-imports` + CI'da **dependency-cruiser** grafı — sınır ihlali build kırar, konvansiyon değil mekanizma. |

---

## 2. Multi-tenancy

**Karar: shared-schema, satır-bazlı `org_id` + Postgres RLS ikinci savunma hattı.**

- Tenant-sahipli her tabloda `org_id uuid NOT NULL` + RLS policy `USING (org_id = current_setting('app.tenant_id')::uuid)`. Uygulama DB rolü `BYPASSRLS` değildir.
- Tüm tenant sorguları tek kapıdan: `withTenant(orgId, tx => ...)` — transaction başında `SET LOCAL app.tenant_id`. Ham `db` client'ı export edilmez; raw sorgu bile RLS'ten kaçamaz.
- **Tenant çözümleme yalnız oturum claim'inden** (`session.org_id`); URL/subdomain'den asla. Çok-org kullanıcı org-switcher ile geçer.
- **Teacher tabloları platform-scoped** (havuz tenant'lar-arası varlık); booking/session/wallet_ledger tenant-scoped, teacher'a FK. Okul eğitmenin yalnız maskelenmiş profilini görür (§7).
- CI **cross-tenant sızıntı testi**: iki tenant seed'lenir, A context'iyle B'nin her record endpoint'ine ID ile vurulur; 404 dışı cevap build'i kırar. Süit endpoint listesini tRPC router'dan otomatik üretir — kapsam insan disiplinine emanet değildir.

---

## 3. Para / Ledger

**Karar: uygulama-içi çift-kayıt ledger; tek Postgres transaction = tek para hareketi; append-only FİZİKSEL olarak zorlanır; harici ledger servisi yok.**

**Tablolar:** `ledger_account(kind: school_wallet | wallet_hold | teacher_payable | platform_revenue | stripe_clearing | wise_clearing | adjustment_reserve; balance_cents cache)` · `ledger_txn(idempotency_key UNIQUE NOT NULL, type, ref_type, ref_id)` · `ledger_leg(txn_id, account_id, amount_cents)` — txn başına `SUM=0` deferred constraint trigger'la zorunlu. Tutarlar integer cent USD; float yasak.

- **Append-only mekanizmayla [graft]:** `ledger_txn`, `ledger_leg`, `session_event` ve `webhook_event` tablolarında UPDATE/DELETE'i bloklayan DB trigger. Düzeltme = ters kayıt, istisnasız. Bu tablolarda destructive migration kategorik yasak (trigger zaten engeller).
- **Negatif bakiye çift savunma [graft]:** birinci hat hold modeli (aşağıda); ikinci hat `school_wallet` ve `wallet_hold` hesap satırlarında **`CHECK (balance_cents >= 0)`** — uygulama bug'ı negatif bakiyeyi fiziksel olarak yazamaz.
- **Bakiye:** `balance_cents` her txn'de aynı transaction içinde `SELECT ... FOR UPDATE` + güncelleme. Saatlik invariant job'ı bacaklardan yeniden türetir (§9).
- **Webhook idempotency:** `webhook_event(provider, event_id, UNIQUE(provider,event_id))`. Handler `INSERT ... ON CONFLICT DO NOTHING RETURNING id`; satır dönmezse 200 dön, çık. **Idempotency insert'i + event işleme + ledger yazımı AYNI transaction'da** — işleme yarıda kalırsa insert de geri alınır, retry güvenli; çift teslim yapısal no-op. Dual-write (insert et, sonra başka sisteme devret) bu mimaride var olamaz — devredilecek ikinci sistem yok.
- **Hold yaşam döngüsü (jürinin işaret ettiği boşluk kapatıldı):**
  1. **Aç:** materializer haftalık dosaj slotlarını üretirken slot başına `school_wallet → wallet_hold` (satış fiyatı kadar), key `hold:slot:{slot_id}`. Bakiye yetmezse slot `blocked_insufficient_funds` — dispatch o okul için durur + okula uyarı; "ders verildi ama para yok" yapısal imkânsız.
  2. **Settle'a çevir:** session attendance ile tamamlanınca TEK transaction'da: hold ters kaydı (`wallet_hold → school_wallet`) + gerçek charge (`school_wallet → platform_revenue` satış, `platform_revenue → teacher_payable` maliyet), key `charge:session:{session_id}` — bir session hayatta bir kez faturalanır.
  3. **Serbest bırak:** slot iptali (okul politikası içinde), backfill `escalated`/`unfilled`, veya session'sız slot son tarihi geçince günlük sweep — ters kayıt `wallet_hold → school_wallet`, key `hold_release:slot:{slot_id}:{reason}`. Başarılı backfill hold'a DOKUNMAZ: fiyat kartı pool-bazlı flat olduğundan eğitmen değişimi hold tutarını değiştirmez.
  4. **SLA kredisi:** escalated backfill'de hold release + `reason=sla_backfill_miss` credit txn otomatik — tahsilat/dunning insan-ops'u yapısal olarak silinir.
- **Payout (iki-faz + otomatik mutabakat):** dış API çağrısı DB transaction'ının içinde ASLA yapılmaz.
  1. Tx-1: `payout` satırı `status='submitting'`, deterministik key `payout:{teacher_id}:{period}` UNIQUE.
  2. Rail seçimi teacher.payout_method'dan: **Stripe Connect Express** (birincil) veya **Wise Platform API** (Connect'in kapsamadığı ülkeler — beachhead MENA+TR'de International ESL havuzunun önemli kısmı; gün-1 mimaride, Faz-2 değil) [graft]. Aynı key provider idempotency key'i olarak taşınır.
  3. Tx-2 (CAS): `UPDATE payout SET status='submitted', external_ref=$id WHERE id=$1 AND status='submitting'` — rowcount 0 = çift işleme, dur. **`external_ref UNIQUE`** DB'de.
  4. **15 dk mutabakat job'ı**: `submitting`'de takılanları provider'dan aynı key ile sorgular, durumu OTOMATİK düzeltir — "API çağrısı ile DB yazımı arasında çökme" penceresi kapalı.
- **Refund/adjustment:** yalnız `reverses_txn_id` + `reason_code`'lu ters kayıt, yalnız `platform_admin`; okul-görünür her adjustment fatura tarafında credit-note üretir.
- **Fatura:** tutar gerçeği LEDGER'dadır; **Stripe Invoicing yalnız belge (PDF) + dunning iletişim katmanı** [graft] — kendi PDF üreteci yazılmaz, fatura tutarı her ay ledger'dan Invoicing'e itilir ve mutabakat cron'u ikisini karşılaştırır.
- **Kill-switch [graft]:** `system_flag('payments_frozen')`. Saatlik invariant ihlalinde OTOMATİK set edilir; charge/payout/top-up-işleme job'ları transaction başında flag'i okur, frozen ise park eder (pg-boss retry ile bekler; webhook_event kayıtları alınmaya devam eder, işleme ertelenir). Açma yalnız `platform_admin`, mutabakat sonrası, Retool'dan. Slack alarmı insan uyanana kadar zarar biriktirir; kill-switch biriktirmez.
- **Ters-yol sertleştirmeleri (ikinci inceleme, 2026-07-10 — [06 T1-②](06-inceleme-addendum.md)):** (a) **cleared-funds kuralı** — top-up `pending` → clearing/dispute penceresi kapanana dek eğitmen payout'una kaynak olamaz; ledger'da "harcanabilir" ≠ "payout-edilebilir" bakiye ayrımı; (b) **rolling dispute reserve** — payout batch'i, dispute penceresi içindeki fon oranı kadar rezerv tutar; (c) **chargeback akışı** — ters kayıt + `receivable` bacağı + hesap askıya alma; (d) **Wise sonuç dosyası = mutabakat kaynağı** — satır-satır `external_ref` eşleşmesi + CAS ile `paid`; insanın beyanı hiçbir şeyi paid yapmaz; (e) FX: Wise lokal-para ödemelerinde kur farkı her payout'ta `fx_gain_loss` hesabına (02 F10/F46).

---

## 4. Dispatch / Booking motoru

- **Recurrence:** `booking_recurrence(class_group, pool, weekday, start_time_local, duration_min, school_tz /*IANA*/, dosage_hours_week)` — yapılandırılmış satır, raw RRULE string değil. Gece **materializer** 4 hafta ilerisi için somut `booking_slot` satırları üretir: okul-yerel saatte hesap (Luxon + IANA tz) → UTC `timestamptz`. Okulun duvar saati gerçektir: "Salı 15:00 Riyad" DST geçişinde 15:00 kalır.
- **DST revalidasyonu [graft]:** materializer, DST geçişini kesen haftalarda etkilenen eğitmenlerin availability'sini otomatik yeniden doğrular; uyumsuzlukta backfill tetikler + eğitmene proaktif "saatin kaydı" bildirimi gönderir.
- **Çakışma önleme — sert garanti DB'de:** `assignment` tablosunda `EXCLUDE USING gist (teacher_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN ('offered','confirmed'))` (btree_gist). Matcher eğitmen bazında `pg_advisory_xact_lock` alır — exclusion ihlali yerine sıralı bekleme; ihlal yine olursa "sıradaki adaya geç" sinyali.
- **Auto-book:** pg-boss job (`singletonKey='autobook'`, 10 dk); deterministik skor: pool eşleşmesi → availability → süreklilik (aynı sınıfa aynı eğitmen) → yük dengesi. Eğitmen confirm'i in-app; T-24h'e kadar confirm yoksa backfill'e düşer. MVP'de sıfır LLM.
- **Backfill state machine** (assignment satırında `status`, **her geçiş tek `UPDATE ... WHERE status=beklenen` CAS'i** — race'ler kod review'a değil rowcount'a emanet):
  `scheduled → confirmed → dropped → backfill_searching → backfill_offered → confirmed | escalated`.
  Reserve-pool'a sıralı teklif, her teklif pg-boss `sendAfter` TTL'li (20 dk); kabul = first-accept-wins CAS. SLA saati (ders başlangıcına 2 saat) dolarsa `escalated`: okula bildirim + hold release + otomatik SLA kredisi (§3) + Retool escalated kuyruğunda görünür.
- **Outbox fact'leri [graft]:** `booking.created`, `assignment.confirmed`, `assignment.dropped`, `session.settled`, `sla.breached`, `payout.submitted` — domain yazımıyla AYNI transaction'da `outbox_event(topic, payload, dispatched_at NULL)` insert; pg-boss dispatcher yayınlar. Bugün tüketici sadece bildirim (Resend e-posta + in-app); Faz-2'de utilization/efficacy projeksiyonları ve analitik, mimariyi bozmadan bu dikişe takılır. Bu, monolitin evrim zayıflığını kapatan kancadır.

---

## 5. Video provision soyutlaması

> **Karar güncellemesi (kurucu, 2026-07-09):** SuperClass MEVCUT ama provision/attendance API'si EKSİK. S1'deki 2 günlük API-gap spike'ı mevcut medya katmanının güvenilirliğini ölçer: sağlamsa aşağıdaki LiveKit/Daily satın alması İPTAL edilir ve eksik API'ler (programatik provision + attendance heartbeat/webhook) S4'te SuperClass'a eklenir; sağlam değilse medya katmanı LiveKit/Daily'ye taşınır ve SuperClass UI'ı üstüne oturur. Tokenized `/join`, first-party attendance-log ve "ödeme trigger'ı = bizim `session_event`" ilkesi her iki dalda aynen geçerlidir.

```ts
interface VideoProvider {
  createMeeting(s: Session): Promise<{providerRef, hostUrl, participantUrl}>
  fetchAttendance(providerRef): Promise<AttendanceEvent[]>   // pull fallback
  handleWebhook?(payload): AttendanceEvent[]                  // push primary
  attendanceCapability(): 'native' | 'webhook' | 'none'      // güven kademesi
}
```
Adapter'lar: `superclass` (default), `zoom`, `msgraph`, `meet`, `perculus`.

- **SuperClass'ın medya katmanı SATIN ALINIR [graft]:** WebRTC altyapısı **LiveKit Cloud (veya Daily)** — ~$0.004/katılımcı-dk. Heartbeat/presence SDK'dan hazır gelir; SuperClass = LiveKit üstünde bizim UI + first-party attendance/dosaj kaydı + kayıt işaretçisi. "Tek sprintte video ürünü" fantezisi ortadan kalkar; dosaj→ödeme zinciri Zoom webhook güvenilirliğine rehin düşmez.
- **Originate garantisi — tokenized join:** ham provider linki hiç kimseye verilmez; dağıtılan link her zaman `/join/{signed_session_token}`. Endpoint join olayını (kim, ne zaman, rol) `session_event`'e yazar, sonra provider'a 302 — harici provider'da, webhook hiç gelmese bile oturum sistemde originate edilir ve minimum attendance sinyali bizdedir.
- **Dosaj hesabı — sinyal önceliği:** (1) `native`: SuperClass/LiveKit 30 sn heartbeat → dakika hassasiyeti; (2) `webhook`: Zoom/Graph/Perculus join-leave event'leri `session_event`'e normalize; (3) `none` (Meet): join-log + **eğitmene zorunlu tek-tık check-in/check-out — check-out yoksa session SETTLE EDİLMEZ** [graft]; okulun 24 saatlik itiraz penceresi. `session.dosage_min` yalnız birleşik `session_event` logundan; **ödeme trigger'ı asla ham provider verisini okumaz.**
- Düşük-fidelity provider'daki sürtünme bilinçlidir: SuperClass'a iten ekonomik tasarımın (video-lock = disintermediation savunması) parçası.

---

## 6. Agent orkestrasyonu

**Karar: hepsi pg-boss üzerinde; durable workflow motoru (Temporal/Inngest) YOK.** Uzun akış deseni = "DB'de state machine satırı + CAS geçişler + idempotent pg-boss step job'ları" — Postgres zaten durable. LLM çağrıları tek `agent-runtime` modülünden (Claude API, strict JSON tool-use); **agent'ın her yazımı normal domain servislerinden geçer (RBAC + RLS aynen)** ve `agent_action(actor, input_hash, proposal, decision, ts)` denetim tablosuna loglanır. İlke: **LLM önerir, deterministik kod karar verir; para yolunda LLM'in okuma erişimi bile yok.**

| Agent | Karar | Mekanizma |
|---|---|---|
| onboarding-wizard | **Hibrit** | Deterministik form/checkout; LLM yalnız pool/paket ÖNERİR (ihtiyaç metnini yorumlar, atlanabilir adım), fiyat/validasyon deterministik. Request-içi. |
| dispatch/backfill | **Tam deterministik** | Para + SLA kritik; kısıt problemi, dil problemi değil. pg-boss cron + `sendAfter` TTL + CAS state machine. Sıfır LLM. |
| HR-onboarding | **Hibrit** | Persona/Checkr + DocuSign webhook'ları deterministik state machine'i sürer; LLM yalnız belge alan-çıkarımı + tutarsızlık bayrağı (W-8BEN ülke uyuşmazlığı), düşük güvende insan-review kuyruğuna (Retool) düşer — fail-closed. |
| session-logger | **Tam deterministik** | Ödeme trigger'ı. Webhook ingest + 15 dk mutabakat cron; sinyal birleşimi kural tabanlı. LLM'in tek yeri salt-okunur anomali özeti. |
| billing/payout | **Tam deterministik** | Gece cron: charge sweep, haftalık payout batch, aylık fatura. LLM en fazla dunning e-postası metni taslaklar. |

---

## 7. AuthN / AuthZ / Oturum

- **AuthN:** **better-auth** (organization plugin) — e-posta OTP + **Google/Microsoft SSO** (okullar Workspace/365 kullanır; self-serve onboarding'de parola sürtünmesi yok). Kendi auth'unu yazmak REDDEDİLDİ (§12).
- **Oturum (sert kısıta birebir):** 10 dk TTL JWT access cookie + Postgres `session` satırı; sliding refresh DB'deki session+user satırından yeniden hydrate. **Tazeleme kadansı 5 dakika [graft]** — pasifleştirilen kullanıcı ≤5 dk'da düşer. DB lookup hatasında **fail-closed** (401, eski token'a asla güvenme). Idle 24 saat / absolute 30 gün.
- **RBAC:** `platform_admin, school_admin, school_staff, teacher`; tek `authorize(actor, action, resource)` policy fonksiyonu (hand-rolled policy map; CASL gereksiz ağır).
- **IDOR savunması:** record-by-id ve list sorguları **aynı `scopedQuery(actor, resource)` builder'ından** — tekil endpoint için ayrı WHERE yazılamaz çünkü repository başka giriş sunmaz. Altında RLS ikinci hat: IDOR için iki bağımsız katmanın aynı anda delinmesi gerekir. CI cross-tenant testi (§2) üçüncü hat.
- **PII maskeleme (iki katman):** (1) ham ORM satırı asla client'a çıkmaz — rol-bazlı zod DTO serializer'ları: okul eğitmenin ad+profil+pool'unu görür, **maliyet rate'ini ve iletişim bilgisini ASLA** (disintermediation); eğitmen öğrenci listesinde yalnız "Ad S." görür. (2) **pino redact listesi [graft]** — e-posta, telefon, adres, tax-id, join-token alanları log hattında mekanik olarak bloklu; PII maskeleme sadece API serializer'da değil log yolunda da yaşar.

---

## 8. i18n/RTL + migration disiplini

- **i18n (kurucu kararıyla genişletildi, 2026-07-09):** `next-intl`, ICU; **Faz-1 içerik yalnız `en`**; yol haritası geniş: `tr`/`ar` Faz-2, `zh`/`ru`/`ja`/`ko` vb. talebe göre Faz-3+. **Eksik anahtar = İngilizce fallback + Sentry uyarısı, asla exception.** Çeviri operasyonu **Crowdin + AI ön-çeviri** [graft] — çok dilde elle JSON yönetimi reddedildi. Geniş yol haritasının gün-1 disiplin bedeli: string birleştirme yasak (yalnız ICU mesajları — CJK kelime sırası), tarih/sayı daima `Intl` API'sinden, metin-gömülü görsel yasak, font stratejisi locale-değişken (CJK subset yükleme).
- **RTL gün-1'den:** `dir` attribute + Tailwind logical properties (`ms-/me-/ps-/pe-`, `text-start`); **fiziksel `left/right` sınıfları ESLint kuralıyla YASAK [graft]** — RTL disiplini insan disiplininden çıkar. CI'da `ar` pseudo-locale snapshot — Arapça çeviri gecikse bile layout borcu birikmez. Para her locale'de USD; tarihler kullanıcı tz+locale.
- **Migration disiplini (sert kısıta birebir, expand-contract):**
  1. **Expand PR:** yalnız SQL migration (`ADD COLUMN` nullable/`DEFAULT`'lu; constraint `NOT VALID` → `VALIDATE`; index `CONCURRENTLY`). Render release-phase migration'ı app rollout'undan ÖNCE koşar → kolon prod DB'de doğrulanmış.
  2. **Use PR:** ancak şimdi Drizzle şemasına girer + kod kullanır. Sıra asla ters dönmez.
  3. **Contract PR:** eski kolon/kod bir tam release sonrası düşer.
  - **Mekanik zorlama:** CI, merged migration'ların uygulandığı temiz Postgres'e karşı app'i boot eder + Drizzle şemasındaki her tablo için `SELECT * LIMIT 1` smoke koşar → "ORM, DB'de olmayan kolonu SELECT ediyor" sınıfı hata build'de patlar, prod'a çıkamaz.
  - Ledger/outbox/session_event tablolarında destructive migration kategorik yasak (append-only trigger'lar zaten engeller).

---

## 9. Gözlemlenebilirlik + client-crash + para nöbeti

- **Sentry server + browser SDK:** release tag + source map upload deploy pipeline'ında zorunlu; route-level React error boundary → Sentry event + i18n-fallback'li hata UI (beyaz ekran yok); error'lu oturumlarda Session Replay (PII mask açık).
- **Yapısal client savunması:** tüm fetch'ler zod-parse'lı tek `apiClient`'tan; standart `{ok:false, error}` zarfı → array-state set eden her yer parse'dan geçer, `Array.isArray` guard'ı yapısal; `undefined.map()` sınıfı ölür.
- **Sentetik prob [graft]:** **Checkly** — signup→top-up→booking→join akışı prod'da 10 dk'da bir; "endpoint 200 dönüyor ama akış kırık" sınıfını yakalar; <15 dk self-serve kuzey yıldızının nöbetçisi. Yanında **PostHog funnel** [graft] — wizard'ın hangi adımda okul kaybettiği gün-1'den ölçülür.
- **Loglar:** pino JSON (redact'li, §7) → Axiom/Betterstack; `request_id` pg-boss job payload'ına taşınır — web isteği ↔ tetiklediği job uçtan uca izlenir.
- **Invariant nöbetçisi — SAATLİK [graft]:** (a) global trial balance = 0; (b) her `balance_cents` cache = bacaklardan türetilmiş bakiye; (c) `submitting`'de >1 saat payout yok; (d) `external_ref`'siz `submitted` payout yok; (e) attendance'lı ama charge'sız session yok; (f) süresi geçmiş serbest bırakılmamış hold yok; (g) **pg-boss dead-letter > 0** ve outbox lag > 60 sn alarmı [graft]; (h) **hold-aging [06 T3-⑥]:** her hold `session_end + 24s grace` içinde settle YA DA release olmuş olmalı — takılı hold trial-balance'ı bozmaz, bu yüzden ayrı invariant (ihlal = alarm + insan kuyruğu; otomatik para kararı yok); (i) **dış nakit mutabakatı [06 T1-②e]:** günlük Stripe/Wise/banka raporu ↔ clearing hesapları — phantom top-up iç tutarlılıkta görünmez, bu kontrol dışa bakar. İhlalde: Slack alarmı **+ `payments_frozen` kill-switch OTOMATİK** (§3) — alarmı gece kimse görmese de çift-hasar birikmez. **Nöbetçinin out-of-band kopyası Checkly'de koşar [06 T3-⑤]:** temel invariant'lar + "invariant job'ı son 2 saatte koştu mu" heartbeat'i — DB/worker degrade olduğunda kill-switch'in kendisi çalışamayabilir; dış göz bunun için. Fail-closed ilkesinin para tarafındaki karşılığı budur.

---

## 10. 90 gün — 2 haftalık dilimler

> **Not:** Yürütme planının bağlayıcı/güncel hali [03-mvp-kapsam.md](03-mvp-kapsam.md)'dedir (bağımsız eleştiri turu sonrası revize edildi — Zoom Faz-1'den kesildi, Wizard-of-Oz dispatch 3–4. haftaya alındı, vendor başvuruları 1. güne çekildi vb.). Aşağıdaki tablo mimari sentezin orijinal dilimlemesidir; çelişki halinde 03 geçerlidir.

Kural: para-kritik yol (S2, S4, S5) hiçbir dilimde sonraya itilemez; UI cilası itilebilir. Her dilim çalışan para veya çalışan dispatch teslim eder.

| Dilim | İş | Dilim sonu DEMO |
|---|---|---|
| **S1** (h1–2) | Monorepo + CI (migration disiplini + dependency-cruiser + cross-tenant süiti) + Render hattı; better-auth (SSO) + org/tenancy + RLS + RBAC; Sentry; Retool iskeleti | İki tenant'lı canlı ortamda SSO login/org-switch; cross-tenant testi CI'da yeşil; pasifleştirilen kullanıcı ≤5 dk'da düşüyor. |
| **S2** (h3–4) | Ledger + append-only trigger'lar + CHECK>=0 + hold modeli + kill-switch flag'i; Stripe Checkout top-up + webhook idempotency (tek-txn); pool/fiyat kartları; saatlik invariant cron; outbox tablosu | Okul $500 yükler; aynı webhook 5 kez replay → tek kayıt; elle bozulan trial balance'ta kill-switch para akışını durduruyor. |
| **S3** (h5–6) | Teacher + availability; recurrence + materializer (DST revalidasyonlu, hold-açan); auto-book matcher + exclusion constraint; okul takvim UI | "Haftada 4 saat ESL" → slotlar otomatik atanır, cüzdanda hold görünür; çakışan booking DB'den reddedilir; bakiyesiz okulda dispatch durur. |
| **S4** (h7–8) | VideoProvider arayüzü + attendanceCapability; **SuperClass = LiveKit Cloud üstünde** provision + tokenized `/join` + heartbeat; Zoom adapter; check-in/check-out fallback'i; session settle = hold→charge atomik | Canlı ders (LiveKit medyasıyla); dosaj dakikası loglanır; ders biter bitmez hold charge'a döner, eğitmen alacağı oluşur — sıfır insan. |
| **S5** (h9–10) | HR onboarding: DocuSign (sözleşme + W-8BEN) + Persona/Checkr; **Stripe Connect EXPRESS** (banka/KYC UI + 1099 + payout dashboard Stripe'ta) + **Wise fallback rail'i**; iki-faz payout + `external_ref UNIQUE` + 15 dk mutabakat | Eğitmen insan temassız onboard; MENA'daki test eğitmenine Wise ile payout çıkar; payout batch'i iki kez koşulunca 0 yeni transfer. |
| **S6** (h11–12) | Self-serve wizard (<15 dk, LLM pool önerisi); backfill SM + SLA + otomatik hold-release/credit; **Stripe Invoicing** ile aylık fatura + utilization dashboard; tr/ar + RTL; Checkly + PostHog canlı; pilot sertleştirme | Uçtan uca: yabancı biri kayıt açar → yükler → ders olur → eğitmen düşürülür → otomatik backfill → fatura kesilir. Checkly funnel'ı yeşil. 3–5 pilot okul açılışı. |

---

## 11. Bilinen borçlar ve çıkış kancaları (yönetilen risk kaydı)

Jürinin işaret ettiği zayıflıklar ya graft'la kapatıldı ya da adlandırılmış tetikleyicili borca çevrildi:

1. **Tek Postgres patlama yarıçapı — BİLİNÇLİ, TARİHLİ BORÇ.** OLTP + pg-boss + RLS + advisory lock aynı instance. Hafifletme bugünden: PITR + failover açık, pg-boss ayrı şemada, session-mode bağlantı bütçesi dokümante, outbox dikişi kurulu. **Tetikleyici:** ~50 okul VEYA bağlantı tavanı %70 doluluk → kuyruk ayrı Postgres/Redis'e taşınır (dikiş hazır olduğundan taşıma consumer-taraflıdır, çekirdek transaction sınırı değişmez).
2. **SuperClass artık iyimserlik değil — KAPATILDI.** Medya katmanı LiveKit/Daily'den satın alındı; S4 dilimi "video ürünü yaz"dan "SDK üstüne UI + first-party attendance yaz"a küçüldü. LiveKit gecikse bile plan Zoom-default'a düşer ve `webhook` kademesi + check-in/out fallback'i dosaj zincirini ayakta tutar.
3. **Backfill SLA'sı likiditeyle sınırlı — YAPISAL GERÇEK, FİNANSAL YAMA OTOMATİK.** Reserve-pool inceyken state machine SLA tutamaz; otomatik hold-release + credit zararı okula anında tazmin eder, escalated kuyruk Retool'da görünür. Gerçek çözüm arz operasyonudur (havuz kürasyonu — zaten insanın tek işi); mimari borcun değil iş borcunun kalemi.
4. **Modül disiplini insana emanetti — MEKANİZE EDİLDİ.** eslint `no-restricted-imports` + CI dependency-cruiser sınır ihlalinde build kırar; CAS-geçiş deseni state machine'lerde zorunlu şablon; cross-tenant süiti router'dan otomatik türetilir. Kalan insan-disiplini yüzeyi: S1'deki authz/tenancy tasarımının doğruluğu — bu yüzden S1 çıktısı üç savunma katmanının (scopedQuery, RLS, CI testi) üçünü birden içermeden dilim kapanmaz.

---

## 12. Reddedilen alternatifler ve neden

| Alternatif | Karar | Neden |
|---|---|---|
| **Event-driven iskelet** (Kafka/Redpanda, schema registry, CQRS read-store, event-sourced booking) | RED | Dakikada onlarca event için altyapı vergisi; kendi önerisinin itirafıyla "aspirational". Değerli parçaları (append-only trigger, CHECK>=0, kill-switch, saatlik nöbetçi, outbox, check-in/out) graft edildi — etiketi değil mekanizmaları aldık. |
| **Hand-rolled auth (~200 satır)** | RED | Güvenlik-kritik bileşeni el yapımı yapmak + SSO'suz kalmak (okullar Workspace/365 kullanır) = hız kazancı olmayan yerde risk. better-auth + SSO; 5 dk DB-tazeleme kadansı event-driven'dan alındı. |
| **Clerk (auth/org vendor'ı)** | RED | Authz gerçeği Clerk↔RLS arasında bölünür — drift tam IDOR doğum yeri; eğitmen MAU faturası ölçekte patlar; fail-closed vendor uptime'ına bağlanır. Tek-kaynaklı DB-native authz kazandı. |
| **Inngest (durable workflow vendor'ı)** | RED | webhook_event insert → Inngest devri klasik dual-write: devir düşerse event "görülmüş ama asla işlenmemiş" olur ve duplicate-koruması kaybı SESSİZLEŞTİRİR — önceki üründeki felaket sınıfının aynadaki hali. Atomiklik sınırı DB+vendor state'ine yayılınca exactly-once akıl yürütmesi imkânsız. Postgres + pg-boss + CAS aynı garantiyi tek transaction sınırında verir. |
| **Temporal (gün-1)** | RED (Faz-2/3 adayı) | Kalıcı worker filosu + öğrenme eğrisi = 90 gün vergisi. Outbox fact'leri + saf-TS state machine'ler geçiş kancasını ucuza kuruyor; tetikleyici: backfill sagası 3+ dallanma tipine çıkarsa. |
| **Modern Treasury / Formance (harici ledger)** | RED | Ledger çekirdek IP ve sert kısıtların yaşadığı yer; ~800 satır Postgres koduna $2k+/ay kira. |
| **Cal.com (booking çekirdeği)** | RED | Semantik uyuşmaz: "kişi randevu alır" ≠ "dosaj reçetesi slot üretir + SLA'lı backfill"; disintermediation savunması başkasının roadmap'ine bağlanamaz. |
| **Deel tam EOR** | RED (nokta çözüm olarak rezervde) | $49/contractor/ay yüzlerce eğitmende marjı yer; Stripe Express + Wise ikilisi kapsamı kapatıyor. |
| **Zapier/Make para yollarında** | RED | İdempotensi/atomiklik garantisi yok — sert kısıt ihlali. |
| **Şema-bazlı tenancy** | RED | Migration yükü N'e katlanır; satır-bazlı + RLS + CI testi üç katman veriyor. |
| **Redis + BullMQ** | RED (borç tetikleyicisine bağlı) | İkinci datastore = ikinci yedekleme + ikinci failure modu; pg-boss aynı işi tek Postgres'te yapar. ~50 okulda yeniden değerlendirilir (§11.1). |
| **On-demand queue (iş modeli)** | RED | Düşük utilization → iptal riski; scheduled guaranteed-dosage sözleşmeseldir, hold modeli de buna kilitlidir. |
| **Retool'u müşteri-yüzlü kullanmak** | RED | Koltuk fiyatı müşteri sayısıyla patlar, self-serve markası olmaz — Retool yalnız iç ops. |
| **Kendi fatura PDF üreteci / kendi WebRTC medya katmanı / kendi bildirim servisi** | RED | Stripe Invoicing (belge+dunning; tutar gerçeği ledger'da), LiveKit/Daily (medya; attendance first-party), Resend (e-posta) — üçü de 90 günü kısaltır ve para/veri döngüsünün kritik yolunda tekel kurmaz. |