# Scholege Lite — Faz-1 MVP Kapsamı v2 (0–90 gün)

**Statü: BAĞLAYICI YÜRÜTME PLANI.** v1 kapsam taslağı bağımsız bir eleştiri turundan geçirildi; 20 somut değişiklik bu dokümana işlendi. Çelişki halinde bu doküman [01-mimari.md](01-mimari.md) §10'daki orijinal dilimlemeyi geçersiz kılar. Eleştiri turunun tam metni: [05-kapsam-elestirisi.md](05-kapsam-elestirisi.md).

## 0. Kapasite dürüstlüğü (v2'de eklendi)

**Bu kapsam N=3 mühendis (+ AI agent'lar) varsayar.** N=1 ise bu plan 90 güne sığmaz; degrade kapsam şudur: yalnız ESL havuzu, Wizard-of-Oz dispatch kalıcı, payout tamamen manuel, hedef 1–2 okul, süre 120+ gün. Velocity kontrol noktası **S1 sonunda** (S3'te değil): S1 hedefleri tutmadıysa aşağıdaki kes-listesi derhal uygulanır.

**Kes-listesi (önem sırasıyla, önceden yazılı):**
1. ~~Zoom entegrasyonu~~ — **şimdiden, koşulsuz kesildi** (aşağıda §1.4)
2. T-24s-içi "agent dener" backfill kolu → yalnız alert + otomatik kredi iadesi
3. Auto-topup (low-balance uyarısı + kayıtlı kartla tek-tık yükleme kalır)
4. Onboarding-wizard agent → statik yönlendirmeli form
5. Utilization dashboard → düz sayfada 3 sayı (satın alınan / tüketilen / doluluk %)
6. Fatura otomasyonu → ledger ekstre ekranı + manuel fatura şablonu

**Genişletilmiş kes-listesi (ikinci inceleme T4-⑧ — kapasite daralırsa sırayla):** 7. self-serve wizard UI → Retool-destekli concierge form; 8. okul takvim UI → salt-okunur liste; 9. backfill otomasyonu → Wizard-of-Oz (manuel re-assign; ledger/SLA-kredisi otomatiği KALIR).

**Asla kesilmeyecekler:** ledger atomikliği/idempotency + ters-yol (cleared-funds, dispute reserve), prepaid cüzdan, hold modeli + hold-aging invariant'ı, accept/decline akışı, session-logger güvenilirliği, yapısal tenant scoping, webhook imza doğrulaması.

## 0.5 Gate'ler (v3 — ikinci inceleme sonrası; [06-inceleme-addendum](06-inceleme-addendum.md))

| Gate | Koşul | Zaman |
|---|---|---|
| **A0 — vendor gerçekliği** | Tüm vendor başvuruları gönderildi + rail-uygunluk matrisi (hangi ülkeye hangi rail fiilen çalışıyor) doğrulandı; Wise = tek payout rail ilanı | **Hafta 0** |
| **Entity/vergi** | Tüzel kişilik + 1099-NEC / TR e-fatura / MENA VAT pozisyonu muhasebeci-hukukçu görüşüyle yazılı | S1 sonu (Stripe hesabı entity ister) |
| **Para ters-yolu** | Cleared-funds + dispute reserve + chargeback akışı ledger tasarımının PARÇASI (retrofit yok) | S2 (ledger ile birlikte) |
| **G0 — safeguarding** | **Ülke sabıka/clearance belgesi (kurucu kararı #13 — uluslararası vendor yok; Persona belge-yükleme akışıyla)** + yazılı safeguarding politikası + reşit-olmayan seans kaydı (retention-politikalı) + olay-müdahale prosedürü + tek-tık eğitmen askıya alma | **Reşit-olmayan içeren İLK seanstan önce** |

---

## 1. Beş ürün gereksinimi: MVP'de NE VAR / NE YOK + kabul kriterleri

### 1.1 SELF-SERVE (okul onboarding)

| VAR | YOK (→Faz) |
|---|---|
| Okul kaydı: e-posta OTP + **Google/Microsoft OAuth** (better-auth — okullar Workspace/365 kullanır) → otomatik tenant + admin rolü | SAML/SCIM kurumsal SSO (→F2) |
| 2 pool fiyat kartı (kurucu onaylı #12): **Native ESL speaking club $40–60/45dk-sınıf** (maliyet $14–18; mevcut el-satışı ~$90) + Admission Strategist ($130/saat), flat, pazarlıksız | Diğer havuzlar (→F2); yerel kart acquirer'ı (iyzico vb.) — KALICI YOK (kurucu #11) |
| Paket = dosaj reçetesi (sınıf sayısı × saat/hafta × dönem) + **pause/skip-week primitifi** (v2: koşulsuz Faz-1 — MENA/TR takviminde ara tatil/sınav haftası kesin) | Özel paket/kupon/indirim motoru (→F2) |
| Stripe kart USD prepaid cüzdan + low-balance uyarısı + auto-topup; **EFT/havale + SWIFT top-up (kurucu #11): admin "banka hesapları" ayar ekranı (kurucu kendisi girer/yönetir) + okula referans-kodlu talimat + pending→settled yarı-otomatik eşleştirme** | Net-30 kredi, çoklu para birimi defteri (→F2, belki hiç) |
| **Kayıt fraud tabanı (v2):** Stripe Radar + rate-limit | Clever roster sync (→F2; CSV yeterli) |
| Onboarding-wizard: statik sihirbaz + LLM pool ÖNERİSİ (atlanabilir adım) | Arapça çeviri İÇERİĞİ (→F2; altyapı+RTL-safe CSS gün-1, bkz. 01-mimari §8) |
| Funnel timestamp'leri (kayıt→yükleme→ilk booking) + PostHog funnel | |

**Kabul kriteri (v2'de concierge gerçeğiyle uzlaştırıldı):** Pilot okullarda tüm tıklamalar OKUL tarafından yapılır, kurucu-dokunuşu ≤1 yönlendirme call'u; funnel her adımıyla enstrümante. **"İnsan-temassız medyan <15 dk" pilotun geçme şartı değil, Faz-1 çıkış kriteridir: en az 1 okul insan teması olmadan kayıt→yükleme→ilk ders akışını tamamlamış olmalı.**

### 1.2 DISPATCH OS

| VAR | YOK (→Faz) |
|---|---|
| Dosaj reçetesinden haftalık recurring booking (scheduled auto-book, materializer + hold) | On-demand/instant queue (KALICI OLARAK ASLA) |
| Eşleştirme: pool + availability + timezone + çakışma (DB exclusion) — kural tabanlı, sıfır LLM | ML/ranking eşleştirme, eğitmen tercih öğrenme (→F2+) |
| Eğitmen in-app accept/decline; timeout'ta sıradaki adaya CAS devri | Eğitmen-okul chat (KALICI OLARAK YOK — disintermediation) |
| **Transactional e-posta katmanı (v2): davet/accept-decline imzalı linkle E-POSTADAN da yapılır** — eğitmenler web app'te yaşamaz; accept-rate'in ön koşulu | WhatsApp kanalı (→F2) |
| Backfill: T-24s dışı reserve-pool'dan tam otomatik; T-24s içi **alert + otomatik hold-release + SLA kredisi** (agent-dener kolu kes-listesinde) | Standby eğitmen ücretlendirmesi (→F2) |
| **İptal/no-show politika matrisi ledger'a gömülü (v2 — aşağıda §2)** | Substitute rating, eğitmen performans skoru (→F2) |
| **Backfill eğitmenine ders bağlamı: booking'de seviye + not alanı (v2)** | |
| Okul sayfasında 3 sayı: satın alınan / tüketilen saat / doluluk % | "Dashboard" UI yatırımı (→F2) |

**Kabul kriteri:** Haftalık X saatlik reçete girildiğinde slotların ≥%95'i 60 sn içinde booked (yeterli arz varsa). Eğitmen iptali senaryosunda T-24s dışı vakalar insan müdahalesiz backfill edilir — pilotta **vaka sayısıyla raporlanır ("N vakanın N'i mekanizmayla çözüldü")**, yüzdeyle değil (v2: n küçük).

### 1.3 HR ONBOARDING (eğitmen)

| VAR | YOK (→Faz) |
|---|---|
| **Üç aday kanalı (kurucu girdisi):** siteden self-serve kayıt + ilan başvuruları + **hrmasterz.com ATS'den tek-yönlü aday import'u** (CSV/API; `teacher.source` alanı gün-1) → davet → profil → e-imza (non-circumvention dahil; **DocuSign gecikirse clickwrap fallback** v2) → Persona KYC + **ülke sabıka belgesi (G0, kurucu #13)** → **merkezi İK görüşmesi (v3 — kurucu kararı: insan; sınıflandırma/tecrübe/enerji; HR-agent randevu+ön-eleme+skor-kartıyla destekler)** → W-8BEN/1099 → payout method | hrmasterz derin senkron (→F2; Faz-1 yalnız import — sözleşme/KYC/payout source-of-record Scholege Lite) |
| kyc_status state machine + tek admin exceptions ekranı (Retool) | Eğitmen eğitim/sertifikasyon LMS'i (→F3) |
| Havuza kabul = insan kürasyonu (bilinçli tek insan-onay noktası) | Otomatik mülakat/örnek-ders skorlama (→F2) |
| Mevcut eğitmen import'u: **dispatch için import yeterli, payout için evrak hard-gate** (earned-but-held durumu) | Deel (→F2, yalnız misclassification riski somutlaşırsa) |
| HR-onboarding agent: eksik evrak takibi + otomatik hatırlatma | |

**Kabul kriteri:** Bir eğitmen davet linkinden payout-ready durumuna hiçbir insanla yazışmadan geçer; evrak-tamamlanma medyan <48 saat; tüm eğitmenlerin evrak durumu tek ekranda.

### 1.4 VIDEO

**v2 kararı: Zoom Faz-1'den koşulsuz kesildi.** Gerekçe: (a) webhook güvenilirliği zaten şüpheli (eski A6), (b) SuperClass-only pilot video-lock/disintermediation stratejisini GÜÇLENDİRİR, (c) pilot sözleşmesine "SuperClass-only" maddesi sıfır mühendislikle aynı sonucu verir. `VideoProvider` interface'i gün-1'den var (ucuz); harici adapter'lar (Zoom→Meet/Teams/Perculus) Faz-2'de talebe göre sıralanır.

| VAR | YOK (→Faz) |
|---|---|
| SuperClass mevcut ürün (**kurucu kararı: var ama API eksik**): eksik programatik provision + attendance API'leri S4'te eklenir; medya katmanı **S1 spike sonucuna göre** SuperClass'ta kalır veya LiveKit/Daily'ye alınır (01-mimari §5) — booking confirm anında otomatik provision | Zoom/Meet/Teams/Perculus adapter'ları (→F2) |
| Tokenized join: dağıtılan link daima `/join/{token}` → join olayı loglanır → 302 | Genel kayıt arşivi + AI ders özeti (→F2); **İSTİSNA (v3, G0):** reşit-olmayan seanslarında safeguarding kaydı Faz-1'de ZORUNLU (retention-politikalı, erişim-loglu) |
| session-logger: heartbeat → attendance + dosage_min; ödeme trigger'ı YALNIZ bizim session_event logumuz | Canlı ders kalite monitörü (→F2) |
| **Öğrenci katılımı (v3):** sınıf-linkiyle katılım (öğrenci hesabı/login yok); **isimli yoklama eğitmen roster checklist'inden** (bkz. §4 PII paketi) | Öğrenci hesabı/login (→F2+; yoklama roster üzerinden) |

**Kabul kriteri:** Booking confirm → join_url <10 sn. Ders bitiminden ≤5 dk sonra Session'da attendance + dosage_min oluşur ve settle tetiklenir.

### 1.5 MUHASEBE (para döngüsü)

| VAR | YOK (→Faz) |
|---|---|
| Hold → settle: session tamamlanınca TEK transaction'da hold release + okul debit + eğitmen accrual (idempotent, bkz. 02-veri-modeli) | Vergi HESAPLAMA otomasyonu (form toplanır sadece) |
| İki haftalık payout batch: **Stripe Connect Express otomatik; Wise "ledger-otomatik, yürütme-manuel"** (v2): sistem batch+CSV üretir, insan gönderir, external_ref geri işlenir (~30 dk / 2 hafta — gizli-ops #6) — Wise API otomasyonu Faz-2 | QuickBooks entegrasyonu (→F3) |
| **Payout failure state machine (v2):** failed / retry / manual-review — yanlış IBAN, reddedilen transfer, Connect hold | Multi-currency fatura, KDV/withholding motoru (→F2) |
| Aylık fatura: tutar gerçeği ledger'da, **Stripe Invoicing yalnız belge+iletişim katmanı**; **fatura uyum kararı (v2, kod değil):** pilotta ABD tüzel kişisinden USD fatura, yerel vergi uyumu (TR e-Arşiv, KSA/UAE VAT) okul tarafında — Faz-2'de yerel faturalama kararıyla ele alınır | Kredi/borç yönetimi, tahsilat aracı (prepaid gereksiz kılar) |
| **Sıfır-bakiye kuralı + runway göstergesi (v2):** runway < N gün → uyarı; bakiye slot hold'unu karşılamıyor → yeni slot `blocked_insufficient_funds`, dispatch o okul için durur | |
| Double-entry ledger + saatlik invariant nöbetçisi + kill-switch + günlük reconciliation | |
| **Webhook imza doğrulaması her provider'da (v2 — idempotency yetmez)** | |
| **Manuel ledger işlemleri (manual_topup, adjustment) append-only audit-log'lu: kim, ne zaman, hangi kanıtla (v2)** | |

**Kabul kriteri:** Tamamlanan ders için settle ≤1 dk; webhook kasıtlı tekrarında çift düşüm 0 (otomatik testte kanıtlı); payout batch iki kez koşunca çift ödeme 0; payout failure'larının %100'ü 72 saat içinde çözülür (v2: "geciken payout 0" yerine — ilk batch'te kırılacak bir metrikti).

---

## 2. İptal / no-show para politikası matrisi (v2'de eklendi — planın en büyük deliğiydi)

Her hücre ledger'da idempotent tek transaction tipi; aynı matris pilot sözleşmesine madde olarak girer. **Sayılar kurucu tarafından ONAYLANDI (2026-07-09, açık soru #6)** — matris aşağıdaki haliyle bağlayıcıdır ve S3'te koda girer:

| Olay | Cüzdan (okul) | Eğitmen earning | Dosaj sayımı |
|---|---|---|---|
| Okul iptali ≥24s | Hold release, ücret yok | Yok | Sayılmaz |
| Okul iptali <24s | %50 dosaj bedeli düşülür | Bloke saatin %50'si accrue | Sayılmaz (utilization'a "geç iptal" olarak işlenir) |
| Eğitmen iptali ≥24s | Hold korunur → otomatik backfill | Yok | Backfill'le devam |
| Eğitmen iptali <24s / no-show | Backfill olmazsa: hold release + %100 otomatik SLA kredisi | Yok + strike (3 strike = pool'dan çıkarma) | Sayılmaz; SLA ihlali dashboard'da |
| Sınıf/öğrenci no-show (eğitmen hazır) | Tam ücret düşülür | Tam accrue | Sayılır (`counted`, `attended=0` — bkz. 02-veri-modeli dakika dörtlüsü) |
| Teknik arıza (bizim taraf/SuperClass) | Hold release + ücret yok | Bloke saat %100 accrue (eğitmen suçsuz) | Sayılmaz; telafi slotu önerilir |

Dispute akışı: okul tarafında "itiraz" butonu → join-log kanıtı + 24 saatlik pencere → Faz-1'de kurucu kararı (adjustment, audit-loglu); Faz-2'de kural motoru (eğitmen ≥10 dk geç → oransal iade vb.).

---

## 3. 90 gün = 6 × 2 haftalık sprint (v2 — yeniden sıralandı)

**Gün-1 (sprint'ten önce, v2):** Stripe Connect platform incelemesi, Wise Platform API iş onayı, Persona ve DocuSign başvurularının HEPSİ 1. hafta ilk gün gönderilir — S2 mühendislikten değil bürokrasiden kaymasın. LiveKit/Daily hesabı da gün-1 açılır.

| Sprint | Hafta | Mühendislik çıktısı | Sprint sonu DEMO | Pilot ilişkisi |
|---|---|---|---|---|
| **S1 — İskelet + para tabanı + güvenlik tabanı** | 1–2 | Monorepo + CI (migration disiplini + dependency-cruiser + **cross-tenant süiti**); better-auth (OAuth) + org/tenancy + **RLS + scopedQuery YAPISAL** (v2: IDOR işi burada yaşar, S6 sadece doğrular); ledger çekirdeği + append-only trigger + CHECK≥0 + webhook imza doğrulama + idempotency test suite; Stripe Checkout top-up (+ **wire fallback için pending/settled top-up ayrımı** — kurucu kararı #3); Sentry; **2 günlük SuperClass API-gap spike'ı (A9): mevcut medya katmanının güvenilirlik testi + eksik provision/attendance API tasarımı → LiveKit'e geçilip geçilmeyeceği burada kararlaşır** | Okul kaydolur, $500 yükler; webhook 5× replay → tek kayıt; cross-tenant testi CI'da yeşil; pasifleştirilen kullanıcı ≤5 dk'da düşer; LiveKit spike raporu | 10–15 okulla discovery; founding-pilot LOI; **A1/A2 sıfır-kod deneyleri koşar**; velocity kontrol noktası → gerekirse kes-listesi |
| **S2 — HR hattı + Wizard-of-Oz dispatch başlar** | 3–4 | Eğitmen davet → e-imza (clickwrap fallback hazır) → Persona → W-8BEN → payout method; kyc state machine + exceptions ekranı; eğitmen import'u (payout hard-gate'li); **çocuk-PII paketi v3 (kurucu kararı #4 — isimli roster): CSV roster import + DPA eki + saklama politikası + "Ad S." maskeleme + log-redaksiyonu** | Gerçek eğitmen davetten payout-ready'ye insan-login'siz | **Wizard-of-Oz dispatch (v2): okul #1 ile GERÇEK ücretli dersler hafta 3–4'te başlar** — manuel booking (spreadsheet + SuperClass linki + admin'den manuel ledger girişi, audit-loglu). Dispatch kodu yokken dispatch tezi (A3/A4) canlı test edilir; 10–15 eğitmen availability'si dolar |
| **S3 — Dispatch v1 + politika matrisi** | 5–6 | Reçete → materializer (hold-açan, DST-revalidasyonlu) + **pause/skip-week**; matcher + exclusion constraint; accept/decline + timeout CAS devri; **transactional e-posta katmanı (imzalı linkli accept/decline)**; takvim UI; **iptal/no-show matrisi yazılır + sözleşmeye girer** | Reçete girilir → hafta 60 sn'de booked → eğitmen e-postadan kabul eder → cüzdanda hold görünür; çakışan booking DB'den reddedilir | Okul #1 Wizard-of-Oz'dan otomatik akışa göç etmeye başlar; A3 doğrulaması artık canlı veriyle |
| **S4 — Para döngüsü kapanır** | 7–8 | SuperClass'a eksik provision/attendance API'leri eklenir (S1 spike'ına göre medya SuperClass'ta veya LiveKit/Daily'de) + tokenized `/join` + heartbeat → session-logger + **eğitmen roster-checklist yoklaması (v3)** → **settle: hold→charge atomik**; iptal/no-show matrisi ledger'a gömülür; sıfır-bakiye kuralı + runway göstergesi; dispute butonu (audit-loglu adjustment); **eğitmen ekranı: haftalık program + earning bakiyesi + payout geçmişi (v2 — yoksa her eğitmen insana yazar)**; **DB yedekleme + restore TATBİKATI (v2: gerçek para akmadan önce)** | Canlı ders → ≤5 dk'da hold charge'a döner, eğitmen bakiyesi ekranında artar; geç iptal senaryosu matristen doğru işler | Okul #1 tamamen otomatik akışta; ilk gerçek otomatik para döngüsü |
| **S5 — Backfill + payout + fatura** | 9–10 | Backfill SM + SLA + otomatik hold-release/kredi; payout: Connect Express otomatik + Wise CSV manuel-yürütme + **failure state machine** + 15 dk mutabakat; Stripe Invoicing aylık belge; saatlik invariant + kill-switch canlı | Eğitmen iptali simüle → otomatik backfill; ilk gerçek payout batch (2× koşum = 0 yeni transfer); ilk fatura belgesi | Okul #2–3 canlıya (kurucu izler, dokunmaz); utilization 3-sayısı okullara açılır |
| **S6 — Self-serve + sertleştirme + ölçüm** | 11–12 | Self-serve wizard cilası (<15 dk hedefi); auto-topup; **IDOR/AuthZ DOĞRULAMA taraması (ilk uygulama değil — v2)**; PII maskeleme denetimi; client-side guard'lar (Array.isArray + i18n fallback); Checkly sentetik prob + PostHog funnel; pilot metrik raporu | Uçtan uca: yabancı biri kayıt → yükleme → ders → eğitmen düşer → otomatik backfill → fatura. Checkly yeşil | 3–5 okul aktif; **en az 1 okul tamamen self-serve onboard (Faz-1 çıkış kriteri)**; yapılandırılmış pilot görüşmeleri; Faz-2 go/no-go |

---

## 4. Çocuk-PII paketi (v3 — kurucu kararıyla güncellendi, 2026-07-09)

**Kurucu kararı (açık soru #4): öğrenci roster'ı İSİMLE tutulur, attendance öğrenci-bazlı.** Bu, compliance paketini gün-1 zorunlu kılar:

- **Roster:** CSV import — ad-soyad + sınıf; **doğum tarihi, iletişim, veli bilgisi TOPLANMAZ** (veri minimizasyonu isimle sınırlı). Clever Faz-2'de kalır.
- **Attendance iki katman:** (1) sınıf-düzeyi dosaj dakikası = ödeme trigger'ı (değişmedi, `session_event` logundan); (2) öğrenci-bazlı yoklama = eğitmen ders içinde roster checklist'inden işaretler. **Öğrenci hesabı/login YOK** — öğrenciler sınıf-linkiyle katılır; yoklama eğitmen işaretlemesinden gelir, join-log'dan değil.
- **Compliance (gün-1, S2'de teslim):** pilot sözleşmesine DPA eki (KVKK/PDPL/GDPR); saklama/silme politikası (dönem bitimi + 6 ay → anonimleştirme); rol-bazlı maskeleme — eğitmen öğrenciyi **"Ad S."** görür (02-veri-modeli §6.1 zaten böyle); öğrenci alanları pino log-redaksiyon listesinde.
- **Sızıntı yasakları:** öğrenci PII'si ledger/payout kayıtlarına, LLM çağrılarına ve harici sistemlere (Stripe, Persona, e-posta gövdesi) ASLA girmez — CI pii-linter kapsamında.
- **Kazanç:** Faz-2 efficacy sinyali (öğrenci-bazlı devam) ilk günden birikir — kurucunun tercih gerekçesi; veri modeli hazırdı (`student` + `attendance_event.student_id`).

---

## 5. En riskli varsayımlar (olasılık × etki; ★ = ilk 3)

| # | Varsayım | P(yanlış) | Etki | En ucuz doğrulama deneyi |
|---|---|---|---|---|
| **A1a ★** | Okul PREPAID'e COMMIT eder (davranış — PO/pazarlık kültürüne rağmen ön ödeme kabul edilir) | Yüksek | Kritik (nakit çekirdeği) | Kod yazmadan: landing page + ödeme linki ile 10 okula "founding pilot — $500 iade edilebilir depozito". Ölçüm: kaç okul ödedi vs "PO gerekir" dedi. 1 hafta, ~$0. **v2 notu: pilotlar founder-touched — bu deney pilottan değerli, mutlaka koşulur.** |
| **A1b ★ (v3)** | Teknik tahsilat çalışır: TR/Körfez kurumsal kartı US Stripe'ta USD auth olur (Connect TR'de yok; auth-rate riski gerçek) | Orta-yüksek | Kritik | Gerçek kart auth-rate probu: pilot okulların kendi kartlarıyla $1 test çekimi. Kırmızıysa: EFT/havale-first akış (soru #11 zaten bunu öneriyor). Hafta 0–1. |
| **A2 ★** | Admission strategist soğuk kanalda kapı açar (land tezi) | Orta-yüksek | Kritik (GTM tezi) | 20 okula strategist tek-sayfa PDF ile soğuk e-posta/LinkedIn. Ölçüm: toplantı dönüşü ≥%20 mi; kaçı ESL'i de sordu (expand ön-sinyali). 2 hafta, sıfır kod. |
| **A3 ★** | Okullar sabit haftalık dosaj slotlarına dönem boyu commit edebilir | Orta-yüksek | Yüksek (dispatch OS'in temel soyutlaması) | 3 okulun GERÇEK dönem takvimiyle (tatil+sınav) reçeteyi spreadsheet'te simüle et (sıfır kod) + **v2: Wizard-of-Oz gerçek dersler hafta 3–4'te canlı doğrular. pause/skip-week sonuç beklemeden Faz-1'de.** |
| A4 | Eğitmen availability'si okul saatleriyle örtüşür, accept-rate yüksek ("arz hazır") | Orta | Yüksek | 20 eğitmene form: availability grid + "bu saat-ücrete haftalık taahhüt verir misin?" → timezone×okul-saati doluluk matrisi. 3 gün, sıfır kod. + Wizard-of-Oz canlı doğrular. |
| A5 | Wise/Connect hedef eğitmen ülkelerine (Mısır, Filipinler, TR) sürtünmesiz payout yapar | Orta | Yüksek | 2–3 gerçek eğitmene $10 test payout'u manuel gönder; KYC sürtünmesi, kesinti, süre notlanır. 1 hafta, sıfır kod. |
| **A9 (v2; v3'te netleşti)** | SuperClass'ın MEVCUT medya katmanı ödeme-trigger'ı güvenilirliğinde VE eksik provision/attendance API'leri S4'e sığacak boyutta (kurucu: "var ama API eksik") | Orta | Yüksek (ödeme zincirinin kaynağı) | S1'de 2 günlük API-gap spike'ı: programatik meeting + 2 client + heartbeat/webhook yakalama; kaçırma >%5 veya API eklenemez boyutta ise medya LiveKit/Daily'ye taşınır; check-in/out fallback'i her durumda kalır. |
| A7 | 3 mühendis + agent'lar bu kapsamı 90 günde çıkarır | Orta | Yüksek | S1-sonu velocity kontrolü + yazılı kes-listesi (§0). |
| A8 | Non-circumvention + video-lock + azalan marj disintermediation'ı caydırır | Orta | Orta (6+ ayda görünür) | Pilot sözleşme maddesi; platform-dışı iletişim girişimleri loglanır; churn görüşmesinde doğrudan sorulur. |
| **A10 (v3)** | Dispute/itiraz oranı <%2 kalır (eğitimde iyimser olabilir — inceleme T2-④) | Orta | Orta-yüksek (insan-ops yükü) | Pilot boyunca ölçülür; >%2 ise kural motoru (geç kalma→oransal iade vb.) Faz-1 sonuna çekilir. |
| **A11 (v3)** | Eğitmen arz churn'ü yönetilebilir (<%15/ay) — "arz hazır" statik değil, recruiting funnel'dır | Orta | Yüksek (İK görüşme kapasitesi) | Aylık churn + accept-rate izlenir; eşik aşılırsa İK kapasite planı (alım dalgası başına ~1 FTE-hafta/25 eğitmen) devreye girer. |

*(v1'deki A6 "Zoom webhook güvenilirliği" Zoom'un kesilmesiyle düştü; yerini A9 aldı. A1, v3'te A1a/A1b'ye bölündü.)*

---

## 6. Gizli insan-ops envanteri (v2: 5 → 9 satır)

*(Havuz kürasyonu bilinçli insan-noktası olduğundan listede değil.)*

| # | Nokta | MVP geçici workaround | Faz-2 otomasyon yolu |
|---|---|---|---|
| 1 | Havale/wire top-up mutabakatı | Okul dekont yükler → admin tek tık `manual_topup` (audit-loglu); ~10 dk/gün | Stripe bank-transfer/virtual IBAN referans-kodlu otomatik eşleşme |
| 2 | T-24s içi backfill başarısızlığı | Otomatik: bildirim + SLA kredisi + 3 alternatif slot önerisi; on-call kurucu yalnız alert alır | Reserve-pool derinlik hedefi (slot başına ≥2) + standby ücret modeli |
| 3 | KYC/evrak exception'ları (%10–20 oran beklenir) | Exceptions ekranı + 48s iç SLA; ~1 saat/hafta | Agent belge ön-doğrulama + otomatik "şunu düzelt" akışları |
| 4 | Attendance/dosage dispute'ları | Dispute butonu → kurucu join-log kanıtıyla karar → audit-loglu adjustment; hedef <%2 | Kural motoru (geç kalma → oransal iade; no-show matrisi otomatik) |
| 5 | Onboarding-wizard aslında danışmanlık | Concierge: kurucu call yapar AMA her adımı okul tıklar; takılan adım = ürün açığı loglanır | Takvim/CSV → otomatik reçete önerisi + okul-tipi preset'leri |
| 6 (v2) | Wise payout yürütmesi manuel | Sistem batch+CSV üretir, insan gönderir, external_ref geri işlenir; ~30 dk/2 hafta | Wise Platform API otomasyonu |
| 7 (v2) | Strategist scoping'i %100 insan | Strategist DOSAJ MOTORUNA SOKULMAZ (ürün-model uyumsuz): "aylık saat-bloğu + takvimden randevu" hafif modeliyle satılır; kurucu scope'lar | Engagement şablonları + intake formu otomasyonu |
| 8 (v2) | Arz bakımı (en büyüğü) | Availability 2 haftada bayatlar: kurucu haftalık dürtme + reserve-pool derinlik takibi; ~2–3 saat/hafta | Availability-staleness otomasyonu + taahhüt teşviki |
| 9 (v2) | SuperClass ders-anı on-call | Video bizim ürünümüz = her teknik arıza bizim on-call'umuz; pilotta kurucu telefonu | Self-healing + status page + LiveKit destek eskalasyonu |

---

## 7. Pilot başarı metrikleri (90. gün — v2'de düzeltildi)

**Pilot okullar (kurucu, 2026-07-10): MEV Koleji, Era Koleji, Dream Big Language Schools — üçü TR (anchor=TR kesinleşti).** Dream Big (dil okulu, sıcak ilişki) = Wizard-of-Oz okul #1 doğal adayı; MEV/Era kolejleri reşit-olmayan öğrenci içerdiğinden **G0 safeguarding gate'i bu pilotlarda ilk günden geçerli**. Bekleyen mikro-girdi: okul başına pool ihtiyacı + hedef başlangıç haftası.

**Aktivasyon (self-serve tezi):**
- Pilotların ≥%60'ı ilk cüzdan yüklemesini kendi tıklamalarıyla tamamlar (concierge call'da bile)
- Kayıt → ilk booking medyan <7 gün; kurucu-dokunuş okul başına <1 saat ve düşen trend
- **En az 1 okul tamamen insan-temassız onboard (Faz-1 çıkış kriteri)**
- **A1 landing-page kart-ödeme deneyi koşuldu ve sonucu raporlandı (v2 şartı)**

**Dosaj gerçekleşme (dispatch tezi):**
- Sözleşmesel dosaj saatlerinin ≥%90'ı attendance-loglu gerçekleşir; unfilled <%5
- Backfill: **vaka-sayısı raporu** — "N geç-iptal vakasının N'i insan müdahalesiz çözüldü" (v2: yüzde yerine; n küçük)
- Utilization ≥%80 — düşük utilization = iptal-riski erken alarmı, okul bazında izlenir

**Para döngüsü (sıfır-insan-para tezi):**
- Gerçekleşen derslerin %100'ü otomatik settle; manuel adjustment <%2
- Çift ödeme 0; payout failure'larının %100'ü 72 saat içinde çözüldü; payout başına insan dokunuşu 0 (Wise CSV yürütmesi hariç — bilinçli, gizli-ops #6)
- **Repeat top-up ≥%60** — prepaid modelde gerçek "tahsilat" ve niyet sinyali budur

**Land→expand sinyali:**
- 90. günde pilotların ≥%80'i yenileme niyeti (imzalı ≥%60)
- Strategist ile giren okulların ESL saati ekleme oranı — **go/no-go kapısı değil SİNYAL (v2); 90 gün ≥%50 için kısa**
- ~~NPS~~ (v2: n=3–5'te anlamsız) → yapılandırılmış çıkış görüşmesi protokolü
- Disintermediation: tespit edilen bypass girişimi 0–1 vaka, her vaka loglu

**Faz-2 go/no-go üç ana hipotez:** (1) Para: repeat-topup ≥%60 VE landing-page deneyi kartla-ödeme isteğini gösterdi. (2) Operasyon: dosaj ≥%90 insan-broker'sız gerçekleşti. (3) GTM: strategist toplantı dönüşü ≥%20 ve expand sinyali pozitif. Üçü yeşil → Faz-2 (efficacy + kalan havuzlar + Arapça içerik) fonlanır; biri kırmızı → ilgili hipotezin pivotu önceliklenir.
