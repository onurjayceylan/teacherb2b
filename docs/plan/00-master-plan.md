# Scholege Lite — Master Plan

**Tek doküman özeti: ne yapıyoruz, nasıl yapıyoruz, sistem bizi nasıl otomatize ediyor, maliyetler nereye düşüyor, 1 kişi nasıl 10 kişilik operasyon yönetiyor.**
Detay dokümanlar: [01-mimari](01-mimari.md) · [02-veri-modeli](02-veri-modeli.md) · [03-mvp-kapsam](03-mvp-kapsam.md) · [04-acik-sorular](04-acik-sorular.md). Uygulama **ayrı, temiz bir repoda** yapılacak; bu paket oraya taşınır.

> **REVİZYON (2026-07-10):** İkinci bağımsız inceleme + kurucunun yeni iş girdileri (12'lik sınıflar, okul başına 200–3.000 öğrenci, eğitmen $14–18/45dk, zorunlu İK görüşmesi) işlendi — tam risk register: [06-inceleme-addendum](06-inceleme-addendum.md). En önemlisi: **safeguarding (G0) ve paranın ters yolu (chargeback/cleared-funds) kod yazılmadan kapatılacak gate'lerdir.**

---

## 1. NE YAPIYORUZ

Düşük-maliyet + AI-destekli eğitmen havuzlarını özel okullara **toptan** satan bir "tedarikçi + yazılım" platformu. Okul son kilometreyi (öğrenci ilişkisi, veliye satış, tahsilatını) kendi yönetir; biz **operatör değil, dispatch işletim sistemiyiz**. Cambly'nin B2C'de yaptığı sürtünmesizliği B2B'de yapıyoruz: okul takvimini girer, sistem eğitmeni bulur, dersi kurar, parayı döndürür — arada insan yok.

**Para nasıl kazanılıyor (marj yığını):**

| Katman | Rakam |
|---|---|
| Eğitmen maliyeti | $8–60/saat (pool'a göre) |
| Okula satış | $38–130/saat (flat, pazarlıksız, lokasyon-kör) |
| Okulun veliye satışı | öğrenci başı $150–250 (bizim işimiz değil — okulun kâr motivasyonu) |
| Scholege sınıf başı net katkı | **~$435/dönem**, son-kilometre operasyonu SIFIR |

**7 havuz:** International ESL · Native ESL · Student AP · Experienced AP · Top-20 Grad · **Admission Strategist (mıknatıs)** · **Passion Mentor (mıknatıs)**. Faz-1'de yalnız 2'si: **Native ESL speaking club (motor — fiyatları aşağıda)** + Admission Strategist (kapı açıcı, $130/saat).

> **Güncellenen iş gerçekleri (kurucu, 2026-07-10):** Speaking club formatı = **12 kişilik sınıflar, okul başına 200–3.000 öğrenci kaydı** (≈17–250 sınıf/okul — hacim eski varsayımın 3–50 katı). **Faz-1 motor pool'u: NATIVE ESL speaking club** — eğitmen maliyeti **$14–18/45dk**, okula satış **$40–60/45dk** (fiyat kartı, kurucu onaylı #12; mevcut el-satışı referansı ~$90/45dk):
>
> | Satış (45dk/sınıf) | Maliyet | Marj/ders | Marj % |
> |---|---|---|---|
> | $40 | $14–18 | $22–26 | %55–65 |
> | $60 | $14–18 | $42–46 | %70–77 |
> | $90 (mevcut fiili) | $14–18 | $72–76 | %80+ |
>
> 15 derslik dönem paketinde sınıf başı katkı ≈ **$330–690** (fiyata göre; $90'da $1.080+) — eski "$435" tahmini bandın içinde. Detay ve etkiler: [06 §A](06-inceleme-addendum.md).

**GTM:** Admissions ile "land" (hiçbir marketplace'te yok, okul bununla velilere kendini satar) → ESL ile "expand" (haftalık, tüm sınıflara, tekrarlayan gelir). Beachhead: MENA + TR + USA **özel/uluslararası** okullar; kamu district'i yok. Para birimi USD.

**İş modeli savunması (disintermediation):** sözleşme maddesiyle değil yapıyla — SuperClass video-lock (ders bizim platformda yaşar), okul↔eğitmen çiftinin ilk işleminde tam marj + hacimle azalan marj (okulun bypass motivasyonu erir), eğitmen iletişim bilgisi okula hiç görünmez.

---

## 2. NASIL YAPIYORUZ — faz planı ve yöntem

| Faz | Süre | İçerik | Kanıtlanacak şey |
|---|---|---|---|
| **1 — MVP** | 0–90 gün | 2 pool + dispatch v1 + SuperClass log + para döngüsü + self-serve onboarding → 3–5 okul pilotu | Okullar satışçısız prepaid öder; dosaj insan-broker'sız ≥%90 gerçekleşir; strategist kapı açar |
| **2 — Efficacy** | 3–6 ay | 3. taraf outcome/dosaj sinyali, kalan havuzlar, tr/ar içerik | Procurement kapı açıcı veri |
| **3 — Distribütör** | 6–12 ay | Bölge distribütörleri + self-serve tier canlı | Kanal satışı ölçekleniyor |
| **4 — Ölçek** | 12+ ay | Çok-coğrafya + B2C ikinci marka (aynı arz omurgası) | Aynı sistem, yeni yüzeyler |

**Yöntem ilkeleri:**
- **Buy, don't build:** para/dispatch/attendance çekirdeği bizim IP'miz, geri kalan her şey satın alınır (auth, KYC, e-imza, ödeme, payout, e-posta, çeviri, gözlem).
- **Önce gerçekle çarpış:** ilk GERÇEK ücretli ders 3–4. haftada (Wizard-of-Oz: dispatch kodu yokken manuel booking'le dispatch TEZİ test edilir), otomatik akış 7–8. haftada devralır.
- **En riskli varsayımlar sıfır-kodla test edilir:** landing page + Stripe Payment Link (okul kartla öder mi?), 20 okula soğuk strategist PDF'i (kapı açar mı?), 3 okulun gerçek takvimiyle spreadsheet simülasyonu (dosaj reçetesi yaşar mı?) — üçü de S1'e paralel, mühendislik beklemeden.
- **Kapasite dürüstlüğü:** plan 3 mühendis varsayar; S1 sonunda velocity kontrolü + önceden yazılı kes-listesi.
- 90 günün sprint-sprint dökümü: [03-mvp-kapsam §3](03-mvp-kapsam.md).

---

## 3. MİMARİ — nasıl inşa ediyoruz

**Karar (3 bağımsız öneri × 3 jüri lensi sonucu): Sertleştirilmiş Modüler Monolit.** Mikroservis yok, Kafka yok, Temporal yok, Redis yok — her biri gerekçeli reddedildi ([01-mimari §12](01-mimari.md)). Neden: 1–3 mühendis 90 günde bunu hem inşa hem İŞLETEBİLİR; para garantileri tek Postgres transaction sınırında akıl yürütülebilir kalır; gece 23:00'te patlayan şeyin nerede patladığı sorusunun cevabı hep aynı yerdedir.

### 3.1 Diller ve teknoloji yığını

| Katman | Seçim | Neden |
|---|---|---|
| **Dil** | **TypeScript** (her yerde: UI, API, worker, agent'lar) | Tek dil = tek zihinsel model, tek CI, ekip küçük |
| **İkincil dil** | **SQL / PL/pgSQL** (constraint, trigger, `post_ledger_txn()` gibi para fonksiyonları) | Para garantileri uygulama koduna değil DB'ye gömülür |
| Frontend + API | Next.js 15 (App Router) + tRPC + zod | Uçtan uca tip güvenliği; API hata zarfı derleyicide yakalanır |
| DB | **Postgres 16, tek instance** (PITR + failover gün-1) | Ledger, kuyruk, kilit, RLS, exclusion constraint — tek yerden |
| ORM/migration | Drizzle + düz SQL migration dosyaları | İnsan-review edilebilir; migration disiplini (§3.4) |
| Job/cron/kuyruk | **pg-boss** (Postgres içinde) | İkinci datastore yok; outbox + retry + cron tek yerde |
| Hosting | Render: 1 web + 1 worker (aynı Docker imajı, `MODE` env) + managed Postgres | Deploy basit; migration release-phase'de app'ten önce koşar |
| AI | Claude API (strict JSON tool-use) — tek `agent-runtime` modülünden | LLM önerir, deterministik kod karar verir |
| İç admin | Retool | Müşteri-yüzlü değil; mühendislik haftası çekirdeğe gider |
| Monorepo | pnpm workspace: `apps/platform` + `packages/{db, modules/*, shared}` | Modül sınırı = paket sınırı; ihlal CI'da build kırar (dependency-cruiser) |

**Satın alınanlar:** better-auth (Google/Microsoft OAuth) · Stripe Checkout/Connect Express/Invoicing/Radar · Wise (uluslararası payout) · Persona (KYC) + Checkr (yalnız US) · DocuSign (fallback: clickwrap) · LiveKit/Daily (video medya — koşullu, §3.3) · Resend (e-posta) · Sentry + Checkly + PostHog + Axiom (gözlem) · Crowdin + AI ön-çeviri (Faz-2 diller).

### 3.2 Bileşen diyagramı

```
                 ┌─────────────────────────────────┐
                 │ Checkly sentetik prob (10 dk'da) │── signup→topup→booking→join
                 └───────────────┬─────────────────┘
                                 ▼
┌───────────────┐  HTTPS  ┌────────────────────────────────────────────┐
│ Okul / Eğitmen │───────▶│ Web (Next.js): UI + tRPC + /join + webhooks │
└───────────────┘         │ better-auth · zod DTO maske · pino redact   │
        ▲                 └──────┬──────────────────────┬───────────────┘
        │ 302 (join loglanır)    │ RLS + scopedQuery    │ webhook ingest (imza doğrulamalı)
┌───────┴───────────┐   ┌────────▼──────────────────────▼───────────────┐
│ Video: SuperClass  │   │ Postgres 16 — TEK GERÇEK KAYNAĞI               │
│ (medya: kendi/     │   │ çift-kayıt ledger (append-only trigger, SUM=0) │
│  LiveKit — spike   │   │ cüzdan hold hesabı · CHECK(balance≥0)          │
│  kararı)           │   │ assignment EXCLUDE (çift-booking imkânsız)     │
└───────────────────┘   │ webhook_event UNIQUE · outbox · pg-boss · RLS  │
                         └────────┬──────────────────────────────────────┘
                                  ▼
                 ┌───────────────────────────────────────┐
                 │ Worker (aynı imaj): materializer ·      │
                 │ matcher · backfill SM · settle · payout │
                 │ 15dk payout mutabakatı · SAATLİK        │
                 │ invariant nöbetçisi → ihlalde KILL-SWITCH│
                 └──────┬──────────────────┬───────────────┘
                        ▼                  ▼
              ┌──────────────────┐ ┌──────────────────────┐
              │ Stripe · Wise     │ │ Retool (yalnız iç ops)│
              └──────────────────┘ └──────────────────────┘
```

### 3.3 Çekirdek mekanizmalar (her biri "sorunsuz süreç"in bir garantisi)

- **Para:** uygulama-içi çift-kayıt ledger; her para hareketi = tek Postgres transaction; append-only **fiziksel** (UPDATE/DELETE'i DB trigger'ı engeller — kod hatası bile tarihçeyi bozamaz); **hold modeli**: slot üretilirken ücret cüzdanda rezerve edilir → "ders verildi ama para yok" YAPISAL imkânsız; bakiye yetmezse dispatch o okul için durur, okul uyarılır.
- **İdempotensi:** webhook `(provider, event_id)` UNIQUE + işleme aynı transaction'da → çift teslim = no-op; payout iki-faz (`submitting` → provider'a deterministik idempotency-key → CAS ile `submitted`) + **15 dk'da bir otomatik mutabakat** → "API çağrısıyla DB yazımı arasında çökme" penceresi kapalı; `external_ref UNIQUE` DB'de.
- **Kill-switch:** saatlik invariant nöbetçisi (trial balance = 0, cache=türetilmiş bakiye, takılı payout yok, charge'sız tamamlanmış ders yok...) ihlal görürse `payments_frozen` bayrağını OTOMATİK basar — para akışı durur, hasar birikmez, açma yalnız insan + mutabakat sonrası.
- **Dispatch:** recurrence yapılandırılmış satır (RRULE string değil); occurrence kimliği duvar saati (DST/tz değişimi çift kayıt üretmez); çift-booking DB'de `EXCLUDE USING gist` ile imkânsız; backfill state machine'inin her geçişi CAS (`UPDATE ... WHERE status=beklenen`) — yarışlar kod review'a değil rowcount'a emanet.
- **Video:** ham provider linki kimseye verilmez — herkes `/join/{imzalı-token}` üzerinden girer, join olayı önce bize loglanır sonra 302; dosaj dakikası YALNIZ bizim `session_event` logumuzdan hesaplanır (heartbeat → yoksa eğitmen check-in/out, check-out yoksa settle edilmez). SuperClass mevcut ama API'si eksik (kurucu kararı) → S1'de 2 günlük spike medya katmanının güvenilirliğini ölçer; sağlamsa eksik API'ler SuperClass'a eklenir, değilse medya LiveKit/Daily'ye taşınır — her iki dalda ödeme zinciri aynı.
- **Multi-tenancy + güvenlik:** her tenant tablosunda `org_id` + Postgres RLS (ikinci hat) + tek `scopedQuery` kapısı (record ve liste endpoint'i AYNI scope'tan geçer — IDOR üç bağımsız katmanı aynı anda delmek zorunda) + CI'da otomatik cross-tenant testi (build kırar). Oturum: 10 dk JWT + 5 dk'da bir DB'den tazeleme, fail-closed — pasifleştirilen kullanıcı ≤5 dk'da düşer. PII: rol-bazlı zod DTO (okul eğitmenin maliyetini/iletişimini ASLA görmez; eğitmen öğrenciyi "Ad S." görür) + log-redaksiyon.
- **Migration disiplini:** expand → use → contract; kolon önce DB'de doğrulanır, ORM'e sonra girer; CI temiz DB'ye karşı app boot + her tabloda `SELECT * LIMIT 1` — "ORM olmayan kolonu çekiyor" sınıfı hata prod'a çıkamaz.
- **i18n:** Faz-1 İngilizce; yol haritası tr, ar, zh, ru, ja, ko... (kurucu kararı) → gün-1 disiplini: yalnız ICU mesajları (string birleştirme yasak), `Intl` API, RTL-safe logical CSS (ESLint zorlar), metin-gömülü görsel yasak. Retrofit maliyeti şimdiden öldürülür.

### 3.4 AI agent'ları — otomasyonun beyni, paranın dışında

**İlke: LLM önerir, deterministik kod karar verir; para yolunda LLM'in okuma erişimi bile yok.** Her agent yazımı normal domain servislerinden geçer (RBAC+RLS aynen) ve `agent_action` denetim tablosuna loglanır.

| Agent | Tip | Ne otomatize eder |
|---|---|---|
| onboarding-wizard | Hibrit | Okulun ihtiyaç metnini yorumlar → pool/paket/reçete ÖNERİR (satış danışmanı yerine); fiyat/validasyon deterministik |
| dispatch/backfill | **Tam deterministik** | Slot doldurma, düşen eğitmeni yedekleme — kısıt problemi, dil problemi değil; sıfır LLM |
| HR-onboarding | Hibrit | Evrak takibi + hatırlatma deterministik; LLM belge alan-çıkarımı + tutarsızlık bayrağı (düşük güven → insan kuyruğu, fail-closed) |
| session-logger | **Tam deterministik** | Attendance/dosaj yakalama = ödeme trigger'ı; LLM yalnız salt-okunur anomali özeti |
| billing/payout | **Tam deterministik** | Settle sweep, payout batch, fatura; LLM en fazla dunning e-posta metni taslaklar |

---

## 4. SİSTEM BİZİ NASIL OTOMATİZE EDİYOR — süreç süreç

Her sürecin "eski dünyada kim yapardı → sistemde ne oluyor → insana ne kalıyor" dökümü:

### 4.1 Okul kazanımı ve onboarding
- **Eski dünya:** satışçı + success manager: demo call'ları, teklif, sözleşme, kurulum — okul başına günler.
- **Sistemde:** okul landing'den kayıt olur (OAuth) → wizard ihtiyacını sorar, pool/paket önerir → dosaj reçetesini girer → Stripe kart ile cüzdan yükler; alternatif **EFT/havale + SWIFT** (kurucu kararı #11: yerel acquirer YOK; banka hesap bilgilerini kurucu admin panelindeki "banka hesapları" ekranından yönetir, okul referans-kodlu havale talimatı görür, `pending→settled` eşleştirme yarı-otomatik) → dispatch otomatik başlar. Funnel her adımıyla ölçülür (PostHog), sentetik prob akışı 10 dk'da bir prod'da test eder.
- **İnsana kalan:** pilot döneminde concierge call (okul tıklar, kurucu yönlendirir — her takılma ürün açığı olarak loglanır); ölçekte sıfır.

### 4.2 Eğitmen tedariki (HR — merkezi, görüşmeli)
- **Eski dünya:** İK: sözleşme mail trafiği, kimlik kontrolü, vergi formu kovalama, banka bilgisi toplama — eğitmen başına saatler, sürekli.
- **Sistemde:** üç aday kanalı — siteden self-serve kayıt, ilan başvuruları, **hrmasterz.com ATS'den aday import'u** (Faz-1 tek yönlü CSV/API; sözleşme/KYC/payout source-of-record Scholege Lite'ta kalır) → davet linki → profil → e-imza (non-circumvention dahil) → Persona KYC + ülke sabıka belgesi (G0, [06 T1-①](06-inceleme-addendum.md)) → **merkezi İK görüşmesi (insan — kurucu kararı: pool sınıflandırması, tecrübe, enerji ölçümü)** → W-8BEN/1099 → payout method. HR-agent görüşmenin ETRAFINI otomatize eder: randevulama, ön-eleme, skor-kartı taslağı, görüşme sonrası pool önerisi, eksik evrak kovalama. Mevcut eğitmenler toplu import — dispatch hemen, **payout evrak tamamlanana kadar bloklu** (hard gate).
- **İnsana kalan (bilinçli):** İK görüşmesi (eğitmen başına ~45–60 dk; 100 kişilik alım dalgası ≈ 2–3 hafta 1 FTE — dalga-bazlı) + havuz kürasyonu + exception kuyruğu (~1 saat/hafta).

### 4.3 Ders planlama ve dispatch
- **Eski dünya:** koordinatör: takvim eşleştirme, eğitmen arama-telefonu, iptal krizinde yeniden planlama — operatör modelinin en pahalı insanı.
- **Sistemde:** reçete → materializer 4 hafta ileriye slot üretir (hold'la birlikte) → matcher pool+availability+timezone'a göre atar → eğitmen in-app/e-postadan tek tıkla kabul eder, timeout'ta sıradakine CAS ile geçer → eğitmen düşerse backfill state machine reserve-pool'u sıralı dener; SLA dolarsa OTOMATİK: okula bildirim + hold iadesi + SLA kredisi. Tatil/sınav haftası: pause/skip-week primitifi. DST geçişinde availability otomatik yeniden doğrulanır.
- **İnsana kalan:** escalated-backfill kuyruğunu izlemek (para tarafı otomatik telafi edildiği için acil değil) + haftalık arz bakımı (availability tazeleme, ~2–3 saat/hafta — Faz-2'de otomatikleşir).

### 4.4 Ders anı ve yoklama
- **Eski dünya:** "ders yapıldı mı?" sorusu = telefon + Excel; faturalama tartışması.
- **Sistemde:** booking confirm anında meeting otomatik kurulur; herkes bizim tokenized linkten girer (join loglanır); dosaj dakikası heartbeat'ten; eğitmen isimli yoklamayı roster checklist'inden işaretler (öğrenci login'i yok); check-out yoksa ders SETTLE EDİLMEZ. Okulun 24 saatlik itiraz penceresi + kanıt = join-log.
- **İnsana kalan:** dispute kararı (pilotta kurucu, kanıta bakar, audit-loglu adjustment; hedef <%2 — Faz-2'de kural motoru) + SuperClass ders-anı teknik on-call (pilot gerçeği, bilinçli).

### 4.5 Para döngüsü (en kritik, en otomatik)
- **Eski dünya:** muhasebe: ders sayımı, eğitmen bordro hesabı, havale emirleri, fatura kesimi, mutabakat — hataya en açık, en pahalı süreç.
- **Sistemde:** ders settle olur olmaz TEK transaction: hold çözülür + okul cüzdanından düşülür + eğitmen alacağı doğar → iki haftada bir payout batch (Connect otomatik; Wise Faz-1'de sistem-üretimli CSV + insan gönderimi ~30 dk, Faz-2'de API) → aylık fatura ledger'dan Stripe Invoicing'e (tutar gerçeği hep ledger'da) → günlük iç/dış mutabakat + saatlik invariant + kill-switch. İptal/no-show matrisi (onaylı sayılarla) ledger'a gömülü — "geç iptalde kim ne öder" tartışması yok, kural işler.
- **İnsana kalan:** Wise CSV gönderimi (Faz-1 geçici) + kill-switch açma yetkisi (sadece ihlal sonrası mutabakatla).

### 4.6 İzleme ve "sorunsuz yönetim" garantisi
Dört savunma halkası, hepsi otomatik:
1. **Önleme (DB):** constraint'ler — negatif bakiye, çift booking, çift payout, tarihçe silme fiziksel olarak yazılamaz.
2. **Tespit (dakikalar):** saatlik invariant nöbetçisi, 15 dk payout mutabakatı, Checkly sentetik prob, Sentry (client crash'leri dahil — beyaz ekran yerine i18n-fallback'li hata UI).
3. **Otomatik tepki:** kill-switch (para durur, hasar birikmez), backfill SLA kredisi (tahsilat pazarlığı doğmaz), payout failure state machine (retry/manual-review).
4. **İnsan eskalasyonu:** Slack alarmı + Retool kuyrukları — insan yalnız istisnaya bakar, akışa değil.

---

## 5. COSTLAR DÜŞÜYOR MU? — Evet; iki eksende

### 5.1 Sabit altyapı/SaaS maliyeti (aylık, tahmini)

| Kalem | Pilot (3–5 okul) | ~50 okul |
|---|---|---|
| Render (web+worker+Postgres, PITR) | ~$100–150 | ~$400–800 |
| Sentry + Checkly + Axiom + PostHog | ~$50–120 | ~$300–500 |
| Resend (e-posta) | ~$20 | ~$100 |
| Retool (iç admin) | $0–50 | ~$100–200 |
| Claude API (agent'lar) | ~$50–200 | ~$500–1.000 |
| DocuSign | ~$40 (veya clickwrap $0) | ~$100 |
| **Toplam sabit** | **~$300–600/ay** | **~$1.500–2.700/ay** |

50 okul × ~5 sınıf × ~$435 katkı ≈ **~$100k+/ay brüt katkıda** sabit altyapı **<%3**. Altyapı maliyeti hacimle logaritmik, gelir lineer büyür.

### 5.2 Değişken maliyetler (marjın içinde, modellenmiş)

| Kalem | Maliyet | Gelire oranı |
|---|---|---|
| Stripe kart tahsilatı | %2,9 + 30¢ | ~%3 (wire'da ~$0) |
| Video (LiveKit dalı; sınıf tek ekrandan girerse 2 katılımcı, 12 öğrenci ayrı kameradan girerse ~$2,3/45dk-ders — **onaylı $40–60 fiyat kartında satışın ~%4–6'sı, yönetilebilir**; katılım modeli paket parametresi) | ~$0,5–2,3/ders | ~%1–6 |
| Payout (Connect: %0,25+$0,25+$2/ay·hesap; Wise: ~$1–5+FX) | eğitmen başına ~$3–8/ay | <%1 |
| KYC (Persona ~$2–5; Checkr yalnız US ~$30–80) | eğitmen başına TEK SEFERLİK | amorti |
| **Toplam değişken** | | **~%5–10** → yazılım-benzeri **%85+ brüt marj** (spread üzerinden) |

### 5.3 Asıl düşüş: insan-ops maliyeti (eski model vs bu sistem)

Eski full-service operatör modelinde sınıf başına planlama + tahsilat + koordinasyon + bordro insan-saatleri marjı yiyordu. Bu sistemde o kalemlerin tamamı koda gömüldü; **sınıf başına marjinal insan maliyeti ~sıfır**. Mühendislik tarafında da buy-not-build (auth, KYC, e-imza, payout UI, fatura PDF, medya katmanı satın alındı) ~aylarca mühendis-zamanını satın almaya çevirdi. Tek büyüyen insan kalemi: havuz kürasyonu — o da kalite kontrolü, ölçekle lineer değil.

---

## 6. 1 KİŞİ = 10 KİŞİ Mİ? — Evet; hesap şöyle

### 6.1 Geleneksel operatör modeli, ~30–50 okul ölçeğinde (kıyas tabanı)

| Rol | FTE |
|---|---|
| Planlama/dispatch koordinatörü (takvim, iptal krizi, eğitmen arama) | 2–3 |
| Eğitmen İK (evrak, sözleşme, onboarding) | 1–1,5 |
| Muhasebe/bordro/fatura/mutabakat | 1,5–2 |
| Müşteri başarı / destek | 2–3 |
| Satış operasyonu / onboarding | 1–2 |
| **Toplam** | **~8–11 FTE** |

### 6.2 Scholege Lite'ta aynı ölçekte insan işi

| İş | Kim | Süre |
|---|---|---|
| Exception kuyrukları (KYC red, dispute, escalated backfill) | ops | ~2–4 saat/hafta |
| Arz bakımı (availability tazeleme — Faz-2'de otomatikleşir) | ops | ~2–3 saat/hafta |
| Wise CSV + sonuç-dosyası mutabakatı (Faz-1 geçici) + wire onayı | ops | ~1–2 saat/hafta |
| Kill-switch/alarm nöbeti (normalde sıfır iş) | ops | on-call |
| **Sürekli taban** | **1 kişi** | **~6–10 saat/hafta** |
| İK görüşmeleri + kürasyon (kurucu kararı: zorunlu insan görüşmesi) | İK | **dalga-bazlı:** eğitmen başına ~1 saat; 100'lük alım ≈ 2–3 hafta 1 FTE |
| Okul-içi destek eskalasyonu | okul → ops | ilk hat OKUL admin'i (sözleşmeyle); Scholege'ye yalnız platform arızası gelir |

**Kaldıraç iddiasının dürüst hali (ikinci inceleme sonrası revize — [06 T2-④](06-inceleme-addendum.md)):** dispatch + para + fatura + evrak hattında kaldıraç ~8–11 FTE → **~0,3 FTE ve bu iddia sağlam** — çünkü insan işi ya **koda gömüldü** (dispatch, settle, payout, fatura), ya **vendor'a devredildi** (KYC, e-imza, payout UI, 1099), ya **istisna kuyruğuna indirgendi**, ya da **finansal otomatiğe bağlandı** (SLA ihlali = otomatik kredi). Ama iki kalem ölçekle insan istemeye devam eder ve sıfırlanmaz: **(1) İK-görüşmeli recruiting** — arz büyüme dalgalarında ayrı kapasite (yukarıdaki satır); **(2) destek** — öğrenci hacmiyle (okul başına 200–3.000) ölçeklenir, bu yüzden ilk-hat-okul kuralı sözleşmeye gömülür. Net: **"1 kişi 10 kişilik dispatch+para operasyonu yönetir" doğru; "1 kişi her şeyi yönetir" değil.** Dispute oranı (A10) ve arz churn'ü (A11) izlenen varsayımlardır — eşik aşılırsa kapasite planı devreye girer.

**Dürüst dipnotlar (gizli insan-ops envanteri, 9 kalem — [03 §6](03-mvp-kapsam.md)):** pilotta kurucu ayrıca satış/concierge yapar (bu satıştır, ops değil); strategist scoping'i insan işidir (o yüzden dosaj motoruna değil saat-bloğu modeliyle satılır); SuperClass ders-anı arızası pilotta kurucu telefonudur. Bunlar planda bütçeli — sürpriz değil.

---

## 7. RİSKLER — en kritik 3 varsayım ve testleri

1. **A1 — Okullar satışçısız kartla prepaid öder** (MENA/TR'de PO/havale kültürüne rağmen). Test: landing + Payment Link, 10 okul, 1 hafta, ~$0. Kırmızıysa: wire-first akış + minimum-topup revizyonu.
2. **A2 — Strategist soğuk kanalda kapı açar.** Test: 20 okula tek-sayfa PDF, dönüş ≥%20 mi. Kırmızıysa: land aracı değişir (ESL fiyatıyla mı girilir, referansla mı), sistem değişmez.
3. **A3 — Okullar sabit haftalık dosaj slotuna dönem boyu commit edebilir.** Test: 3 gerçek okul takvimiyle simülasyon + hafta 3–4 Wizard-of-Oz canlı dersler. Kırmızıysa: reçete esneklik primitifleri genişler (pause/skip zaten Faz-1'de).

Tam liste (A1–A9) + pilot go/no-go metrikleri: [03 §5, §7](03-mvp-kapsam.md).

---

## 8. KARAR GÜNLÜĞÜ + kalan girdiler

**Verilen kararlar (kurucu, 2026-07-09):** ① SuperClass var/API eksik → S1 spike medya kararını verir ② eski Scholege'den tamamen ayrı, tek seferlik import ③ US entity + kart default + wire fallback ④ isimli öğrenci roster'ı → çocuk-PII paketi gün-1 (DPA, saklama, "Ad S." maskeleme) ⑥ SLA/iptal matrisi sayılarıyla onaylı ⑧ vetting = Persona + Checkr US ⑨ Faz-1 İngilizce, geniş locale yol haritası ⑩ hibrit pilot.

**Bekleyen veri girdileri (kodu bloklamaz; ilgili sprint'ten önce):** eğitmen kayıt kaynağı + pool bazında sayılar + non-circumvention durumu (S2 öncesi) · import alan listesi (S2) · pilot okul listesi (S2–S3) · eğitmen ülke dağılımı (S5 öncesi) · fatura kesen tüzel kişilik + minimum top-up onayı (S1 Stripe kurulumu öncesi ideal).

## 9. YENİ REPO — başlarken

Uygulama ayrı, temiz bir repoda başlar (bu plan paketi oraya taşınır). İlk PR'ın içeriği S1 tanımıdır: pnpm monorepo iskeleti + CI kapıları **gün-1'den** (migration disiplini smoke'u, cross-tenant süiti, dependency-cruiser, pii-linter) + better-auth/tenancy/RLS + ledger çekirdeği + Stripe Checkout. Gün-1'de kod dışı iş: tüm vendor başvuruları (Stripe Connect, Wise, Persona, DocuSign) — onaylar haftalar sürer, mühendisliği beklemesinler.
