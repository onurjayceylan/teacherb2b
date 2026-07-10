# Scholege Lite — Açık Sorular ve Karar Noktaları

**Statü: 10 sorunun 8'i KARARA BAĞLANDI (kurucu, 2026-07-09) ve dokümanlara işlendi.** Kalan: #5 ve #7 karar değil VERİ GİRDİSİ bekliyor (eğitmen kayıt kaynağı/sayıları, ülke dağılımı) + #10'un pilot okul listesi + #2 import alan listesi + #3 tüzel kişilik ve minimum top-up onayı. Bunlar kod yazmayı bloklamaz; S2 (HR/import) ve S5 (payout rail ağırlığı) başlamadan gelmiş olmalı.

**İkinci inceleme sonrası (2026-07-10) 3 yeni soru eklendi ve AYNI GÜN karara bağlandı (#11 rail kısmı, #12, #13 — aşağıda).** Bulguların tamamı: [06-inceleme-addendum](06-inceleme-addendum.md). **Kalan tüm bekleyenler artık yalnız VERİ GİRDİSİ:** eğitmen kayıt kaynağı + sayılar (#5), ülke dağılımı (#7), pilot okul listesi (#10/#11 anchor'ı fiilen bu belirler), import alan listesi (#2), tüzel kişilik + minimum top-up (#3), banka hesap bilgileri (kurucu admin panelinden girecek — #11).

---

## Bloklayanlar (S1–S2'yi etkiler)

### 1. SuperClass'ın bugünkü durumu ⛔ *(ödeme zincirinin kaynağı)*

**Soru:** SuperClass bugün production'da, API üzerinden "meeting oluştur + attendance/dosaj webhook'u ver" yeteneğine sahip mi? Booking anında otomatik provision, join/leave timestamp'i ve kayıt pointer'ı bugün programatik alınabiliyor mu?

**Neden önemli:** Attendance/dosaj logu ödeme trigger'ı olduğu için video katmanı aslında para katmanıdır. Cevaba göre MVP video mimarisi, session-logger tasarımı ve S4 takvimi kökten değişir.

| Seçenek | Tradeoff |
|---|---|
| **A. Hazır ve API'li → default provider bağla** | En hızlı + video-lock gün-1; ama "hazır" iddiası test edilmemişse para döngüsü kırılgan bağımlılık üstüne kurulur |
| B. Var ama API eksik → MVP'yi Zoom'la başlat | Risk düşer; ama video-lock gecikir + Zoom webhook güvenilirliği zaten şüpheli |
| C. Yok/erken → LiveKit/Daily üstüne minimal SuperClass inşa | Kontrol tam bizde; kapsam patlaması riski en yüksek görünen ama medya katmanı satın alındığı için gerçekte yönetilebilir seçenek |

**Ekip önerisi:** 1 hafta içinde **SuperClass API smoke testi** (programatik meeting + 2 client + attendance webhook). Geçerse A; geçmezse **C'nin satın-alınmış hali**: mimari zaten SuperClass'ı LiveKit/Daily medya katmanı üstünde "bizim UI + first-party attendance" olarak kurguladı (01-mimari §5) — "tek sprintte video ürünü" riski satın almayla küçültüldü. Ödeme trigger'ı hiçbir senaryoda provider verisine değil bizim `session_event` logumuza bağlanır.

**KARAR (kurucu, 2026-07-09): B — SuperClass VAR ama provision/attendance API'si EKSİK.** İşlenmesi: S1'de 2 günlük API-gap spike'ı SuperClass'ın mevcut medya katmanının güvenilirliğini ölçer — sağlamsa LiveKit/Daily satın alması iptal edilir ve eksik API'ler (programatik provision + attendance heartbeat/webhook) S4'te SuperClass'a eklenir; sağlam değilse medya katmanı LiveKit/Daily'ye taşınır, SuperClass UI'ı üstüne oturur. Tokenized `/join` + "ödeme trigger'ı = bizim `session_event`" ilkesi her iki dalda aynen geçerli. (01-mimari §5 ve 03 §1.4/S1/S4 güncellendi.)

### 2. Mevcut Scholege platformuyla ilişki ⛔ *(tenancy + auth mimarisini etkiler)*

**Soru:** Scholege Lite tamamen ayrı codebase + ayrı DB mi? Eski platformdan kullanıcı/eğitmen/okul verisi taşınacak mı; auth/domain/marka paylaşılacak mı?

**Neden önemli:** "Greenfield" deniyor ama eğitmen arzı "zaten var" — bu veri bir yerde duruyor. Runtime bağımlılık kabul edilirse eski sistemin her arızası ve teknik borcu (sert kısıtlardaki dersler) yeni ürüne taşınır.

| Seçenek | Tradeoff |
|---|---|
| **A. Tamamen ayrı: yeni DB + yeni auth; eğitmenler tek seferlik versiyonlu import** | En temiz; eğitmenler ikinci kez hesap açar |
| B. Ayrı ürün + paylaşılan auth/SSO | Eğitmen deneyimi pürüzsüz; eski auth yeni güvenlik yüzeyine girer |
| C. Aynı platformda yeni modül | Hız yanılsaması; tüm eski dersler miras kalır — brief'in ruhuna aykırı |

**Ekip önerisi:** **A.** Eski sistemden yalnız tek seferlik eğitmen import'u (ad, pool, rate, iletişim); runtime entegrasyon sıfır. Kurucudan istenen: import alan listesi + eski sistemin hangi tarihte source-of-truth olmaktan çıkacağı.

**KARAR (kurucu, 2026-07-09): A — tamamen ayrı (öneri kabul).** Hâlâ bekleyen girdi: import alan listesi + eski sistemin source-of-truth'tan çıkış tarihi.

### 3. Tahsilat railleri ve cüzdan politikası ⛔ *(ledger state machine'ini gün-1 etkiler)*

**Soru:** TR/MENA okullarından USD nasıl tahsil edilecek? Hangi tüzel kişilik, hangi railler (kart / wire / yerel acquirer), minimum yükleme tutarı ne?

**Neden önemli:** Wire kabul edilirse "sıfır insan" iddiasına mutabakat girer ve ledger'a `pending top-up` durumu gün-1'de eklenir. Minimum top-up, funnel'ın en sert sürtünme noktası.

| Seçenek | Tradeoff |
|---|---|
| A. Sadece kart (US Stripe entity, USD) | Tam otomasyon; TR/MENA'da kurumsal USD kart ödeyemeyen okul = dönüşüm kaybı |
| **B. Kart default + wire fallback (referans kodlu, yarı-otomatik mutabakat)** | Beachhead gerçeğine uyar; haftada birkaç dk insan mutabakatı (gizli-ops #1) |
| C. Yerel acquirer'lar (iyzico vb.) + FX | En iyi yerel UX; USD-native kısıtına FX karmaşası sokar — Faz-1 için ağır |

**Ekip önerisi:** **B** — US entity + Stripe kart default, wire fallback. Ledger gün-1'den pending/settled top-up ayrımıyla (veri modelinde hazır). Minimum yükleme: seçilen paketin ~4 haftalık dosaj bedeli (örn. $2.000–5.000) — ciddiyet filtresi + backfill taahhüdünün teminatı. Kurucudan net karar: fatura kesen tüzel kişilik(ler) + wire'a Faz-1'de izin.

**KARAR (kurucu, 2026-07-09): B — kart default + wire fallback (öneri kabul).** Wire mutabakatı gizli-ops #1 olarak bütçeli; ledger pending/settled ayrımı gün-1. Hâlâ bekleyen girdi: fatura kesen tüzel kişilik(ler) + minimum top-up tutarının onayı.

### 4. Okul tarafında login + öğrenci PII kapsamı ⛔ *(compliance yüzeyini belirler)*

**Soru:** Okul adına kim login olur — sadece admin mi, okulun öğretmenleri de mi? Öğrenciler derse nasıl katılır; öğrenci-düzeyi PII tutulacak mı?

**Neden önemli:** Bireysel öğrenci PII'si → COPPA/KVKK/PDPL/GDPR + okullarla DPA — küçük ekip için ciddi yük. "Okul son kilometreyi kendi yönetir" tezinin sınırı burada.

| Seçenek | Tradeoff |
|---|---|
| **A. Sadece SchoolAdmin (+koordinatör); öğrenciler sınıf-linkiyle anonim; attendance sınıf-düzeyi** | Compliance minimal, dosaj/ödeme için yeterli; öğrenci-bazlı devam raporu veremeyiz |
| B. İsimli roster (CSV/Clever), öğrenci-bazlı attendance | Güçlü raporlama + Faz-2 efficacy hazır; gün-1'de çocuk-PII yükü |
| C. Pseudonymous öğrenci ID (eşleştirme okulda) | PII bizde durmaz + rapor mümkün; okula ekstra operasyon |

**Ekip önerisi:** **A** (03-mvp-kapsam §4'teki çocuk-PII paketi buna göre yazıldı). Veri modeli öğrenci-bazlıya genişlemeye hazır (`student` pseudonym-hazır); ilk okul sözleşmesel talep ettiğinde C açılır. Kurucudan net karar: "öğrenci-bazlı devam raporu vermiyoruz" pozisyonu satışta kabul edilebilir mi?

**KARAR (kurucu, 2026-07-09): B — İSİMLİ ROSTER (öneri reddedildi; kurucu öğrenci-bazlı veri istiyor).** Sonuçları: çocuk-PII compliance paketi gün-1 ZORUNLU oldu — pilot sözleşmesine DPA eki, saklama/silme politikası, rol-bazlı maskeleme ("Ad S."), log-redaksiyonu. Öğrenci hesabı/login yine YOK: öğrenciler sınıf-linkiyle katılır, isimli yoklamayı eğitmen roster checklist'inden işaretler. Veri modeli zaten hazırdı (`student` + `attendance_event.student_id`, F48). Kazanç: Faz-2 efficacy sinyali ilk günden öğrenci-bazlı birikir. (03 §4 yeniden yazıldı.)

---

## Takvimi etkileyenler (S2–S5)

### 5. Eğitmen arzının sistemsel durumu

**Soru:** 7 havuzdaki eğitmenler bugün nerede kayıtlı (spreadsheet / eski Scholege DB / ajans listesi)? Kaçının imzalı sözleşmesi, KYC'si, vergi formu, payout yöntemi hazır? Kaçında non-circumvention maddesi var?

**Ekip önerisi:** Hibrit geçiş — **dispatch için import yeterli, ilk payout için evrak hard-gate** (earned-but-held durumu ledger'da var). HR-agent'ın ilk işi: eksik-evrak listesi + otomatik takip. Kurucudan istenen: pool bazında eğitmen sayısı + kayıt kaynağı + non-circumvention durumu.

**GİRDİ (kurucu, 2026-07-10): Eğitmen kaynağı İKİ kanal + mevcut HR sistemi.** (1) Siteden self-serve kayıt olan eğitmenler; (2) ilanlardan gelen başvurular; (3) mevcut ayrı HR sistemi **hrmasterz.com** — bağlanabilir. **İşlenmesi:** hrmasterz = ATS (ilan + aday havuzu) olarak kalır; **Scholege Lite = sözleşme/KYC/İK-görüşmesi/payout için source-of-record** (para ve compliance tek yerde). Entegrasyon Faz-1'de tek yönlü aday import'u (CSV/API: ad, iletişim, başvurulan pool, ilan kaynağı) → Scholege Lite davet linki üretir, pipeline buradan devam eder; derin senkron Faz-2. `teacher.source` alanı (site / ilan / hrmasterz) gün-1 şemada — kanal bazlı dönüşüm ve churn ölçümü için. Hâlâ bekleyen: pool bazında mevcut eğitmen SAYILARI + kaçında imzalı non-circumvention olduğu.

### 6. Backfill SLA süreleri + iptal/no-show sayıları

**Soru:** 03-mvp-kapsam §2'deki matrisin sayıları (24s eşiği, %50 geç-iptal kesintisi, 3-strike kuralı, 2s son-dakika eşiği) onaylı mı, yoksa kendi rakamların mı var?

**Ekip önerisi:** Katmanlı SLA: drop ≥24s → backfill garanti; <2s → best-effort, olmazsa otomatik SLA kredisi + öncelikli telafi slotu. Faz-1 sözleşmelerinde nakit ceza YOK, yalnız otomatik kredi. Mühendislik hangi sayı olursa aynı gün kodlar; **sayı olmadan S3 başlayamaz.**

**KARAR (kurucu, 2026-07-09): ONAYLANDI — 03 §2'deki matris aynen geçerli.** Okul iptali ≥24s ücretsiz / <24s %50; eğitmen no-show → okula %100 otomatik kredi + strike (3 strike = havuzdan çıkarma); son-dakika eşiği 2s; nakit ceza yok. Matris S3'te koda, pilot sözleşmesine madde olarak girer. S3 bloğu kalktı.

### 7. Payout rail önceliği (Wise vs Stripe Connect vs Deel)

**Soru:** Eğitmenlerin ülke dağılımı ne? (Bu tablo olmadan rail önceliği tahmin.)

**Ekip önerisi:** Rail-agnostik payout modülü gün-1 (veri modelinde hazır); **Stripe Connect Express** (US/kapsanan ülkeler, otomatik) + **Wise** (kalanlar; Faz-1'de ledger-otomatik/yürütme-manuel CSV, Faz-2'de API). Deel yalnız misclassification riski somutlaşırsa. Wise Platform başvurusu gün-1 (onay haftalar sürer).

**KARAR:** _bekliyor_

### 8. KYC provider + "vetted" iddiasının hukuki tanımı

**Soru:** Okula satılan "vetted eğitmen" tam olarak ne demek — kimlik doğrulama mı, adli sicil mi, referans mı? (Checkr fiilen US-merkezli; Mısır/Filipinler'de "background check" ne demek?)

**Ekip önerisi:** **Persona herkes için zorunlu KYC** (kimlik+belge+selfie); Checkr yalnız US-resident eğitmenlere (Faz-1'de gerekirse); uluslararası eğitmenlerden ülkesinin police-clearance belgesi Persona belge-yüklemesiyle toplanır. Okul-yüzlü vetting matrisi pool bazında şeffaf yayınlanır. Kurucudan net karar: sözleşmelerdeki resmi "vetted" tanımı — pazarlama değil hukuk metni.

**KARAR (kurucu, 2026-07-09): Persona + Checkr US (öneri kabul).** "Vetted" resmi tanımı: identity-verified (Persona KYC, herkes) + country clearance belgesi (uluslararası) + criminal check (yalnız US-resident, Checkr). Sözleşme metnine bu üçlü tanım girer; pool bazlı vetting matrisi okula şeffaf yayınlanır.

### 9. MENA i18n/RTL zamanlaması

**Soru:** Arapça UI + RTL Faz-1'de mi, pilotlar İngilizce mi başlıyor?

**Ekip önerisi:** i18n altyapısı + RTL-safe CSS (logical properties, ESLint zorlaması) **gün-1** — retrofit riskini ~sıfır maliyetle öldürür; içerik Faz-1'de İngilizce, Arapça ilk MENA pilotuyla. (01-mimari §8 buna göre.) Kurucudan net karar: ilk MENA pilotlarına "Arapça UI Faz-2" pozisyonu, satışta verilmiş bir sözle çelişiyor mu?

**KARAR (kurucu, 2026-07-09): Faz-1 İngilizce; sonrası GENİŞ locale yol haritası — Türkçe, Arapça, Çince, Rusça, Japonca, Korece vb.** İşlenmesi: öneriden daha geniş — altyapı gün-1'den yalnız RTL-safe değil **CJK-safe** de olmalı: tüm string'ler ICU/next-intl'de (string birleştirme yasak), tarih/sayı daima `Intl` üzerinden, metin-gömülü görsel yasak, font stratejisi locale-değişken, Crowdin + AI ön-çeviri hattı çok-dil için boru hattı olarak kurulur. Locale sırası pazar girişine göre: tr/ar Faz-2, zh/ru/ja/ko talebe göre Faz-3+. (01-mimari §8 güncellendi.)

### 10. Pilot okullar + self-serve'ün gerçek kapsamı

**Soru:** 3–5 pilot okul şimdiden belli mi (isim, ülke, pool ihtiyacı, başlangıç tarihi)? Concierge mi, tam self-serve mi?

**Ekip önerisi:** Hibrit, ölçülebilir kriterle: 2–3 committed design partner concierge + self-serve paralel; **Faz-1 çıkışı = en az 1 okul insan-temassız onboard** (03-mvp-kapsam'a işlendi). Kurucudan istenen: pilot listesi (ülke + pool + hedef hafta) — bu liste soru 3/8/9'un fiili tie-breaker'ı.

**KARAR (kurucu, 2026-07-09): Hibrit (öneri kabul).** Plan zaten bu varsayımla yazılmıştı; değişiklik yok.

**GİRDİ (kurucu, 2026-07-10): Pilot okullar belli — MEV Koleji, Era Koleji, Dream Big Language Schools.** Üçü de Türkiye → **anchor pazar fiilen TR (#11'in açık kalan kısmı kapandı).** Sonuçları: (1) TR e-fatura/tüzel kişilik konusu S1 gündemine kesinleşti (T1-②d gate'i); (2) EFT/havale bu pilotlarda muhtemel ana top-up yolu — admin "banka hesapları" ekranı + referans-kodlu eşleştirme S1-S2'de öne alınır; (3) A1b kart-auth probu TR kurumsal kartlarıyla koşulur; (4) RTL pilot için gereksiz (karar #9 doğrulandı; İngilizce admin UI pilotta teyit edilecek, tr locale talebi gelirse Faz-2'den öne çekilir); (5) Dream Big Language Schools (dil okulu, sıcak ilişki) Wizard-of-Oz okul #1 için doğal aday; MEV/Era kolejleri reşit-olmayan öğrenci içerir → **G0 safeguarding gate'i pilotun ilk gününden geçerli.** Bekleyen mikro-girdi: her okul için pool ihtiyacı + hedef başlangıç haftası.

---

## İkinci incelemeden gelen yeni sorular (2026-07-10)

### 11. Beachhead anchor: tek pazar seçimi ⛔ *(S1 öncesi — #3 kararını revize edebilir)*

**Soru:** MENA + TR + USA'yı aynı anda kovalamak (3 mühendis + sınırlı ops ile) odak riski. Tek anchor pazar hangisi olsun?

**Neden önemli:** Anchor seçimi tahsilat railini (#3), fatura/vergi işini (T1-②d), RTL zamanlamasını ve pilot listesini fiilen belirler. İncelemenin işaret ettiği gerilim: teknik varsayılanlar US'i imá ediyor (kart + Checkr + US entity) ama kurucunun sıcak ilişkileri ve mevcut Scholege tabanı TR'de.

| Seçenek | Tradeoff |
|---|---|
| **A. TR anchor + EFT/havale-first (İncelemenin ve ekibin önerisi)** | En hızlı GERÇEK okuma: sıcak okullar "benimser + öder mi"yi en hızlı yanıtlar, CAC düşük. EFT hem kart-auth hem Stripe-Connect-TR sorununu bypass eder (inbound para almak; outbound zaten Wise). Bedeli: #3 kararı revize olur (havale/EFT default + kart fallback), havale mutabakat otomasyonu öne çekilir, TR e-fatura konusu S1'e gelir. US/MENA'da yalnız sıfır-kod A1/A2/A3 testleri paralel koşar. |
| B. US anchor | Kart+Checkr+entity varsayılanları kutudan çıkar, ödeme sürtünmesi minimum; ama soğuk pazar — satış döngüsü uzun, CAC yüksek, founder-ilişki avantajı kullanılmaz. |
| C. MENA anchor | En yüksek bilet + admissions mıknatısı güçlü; ama tahsilat/VAT/RTL üçü birden gün-1 yüke biner. |

**Ekip önerisi:** **A.** De-risk edilecek 1 numaralı şey "okul benimser ve öder mi" — TR bunu en ucuza ve en hızlı ölçer; sistemin USD-defter yapısı değişmez (EFT TL girişi kurla USD'ye çevrilip cüzdana yazılır, kur farkı `fx_gain_loss`'a).

**KARAR (kurucu, 2026-07-10) — rail kısmı netleşti:** **Stripe kart (global) + EFT/havale + SWIFT; yerel kart acquirer'ı (iyzico vb.) YOK.** Banka hesap bilgilerini (TL EFT + USD SWIFT) kurucu **admin panelinden kendisi girer/yönetir** → sistem gereksinimi: admin'de "banka hesapları" ayar ekranı + okul top-up sayfasında referans-kodlu havale talimatı + `pending → settled` manuel/yarı-otomatik eşleştirme (gizli-ops #1, cleared-funds kuralı aynen). Anchor PAZAR seçimi açıkça yapılmadı — fiilen pilot okul listesi belirleyecek (bekleyen girdi); US/MENA sıfır-kod testleri her durumda paralel.

### 12. Speaking club fiyat kartı ⛔ *(marj tablosunun temeli — yeni maliyetle)*

**Soru:** Eğitmen maliyeti $14–18/45dk (kurucu, 2026-07-10) — eski $8/saat varsayımının 2+ katı. Okula satış fiyatı 45 dk ders başına ne olacak ve öğrenci katılım modeli ne (12 öğrenci ayrı kameradan mı — video maliyeti marjın %15–20'si — yoksa sınıftan tek ekran mı)?

**Neden önemli:** Fiyat kartı olmadan cüzdan/hold/settle rakamları, "sınıf başı $435 katkı" iddiası ve pilot paket fiyatlaması türetilemez. Veri modeli hazır (`price_card` + negatif-marj CHECK'i); yalnız sayı gerekli.

**Ekip önerisi:** $30–38/45dk bandı (≈%40–55 brüt marj) + katılım modeli okul tipine göre paket parametresi. Kurucudan istenen: 2 pool için satış $/45dk + dönem paketi tanımı (hafta sayısı × ders/hafta).

**KARAR (kurucu, 2026-07-10): Speaking club = NATIVE ESL eğitmen; okula sınıf başı $40–60/45dk satılabilir; mevcut fiili satış ~$90/45dk.** Marj: $40'ta $22–26/ders (%55–65), $60'ta $42–46 (%70–77), $90'da $72–76 (%80+). Fiyat kartı bandı $40–60 (platform self-serve fiyatı), $90 mevcut el-satışı referansı. Faz-1 motor pool'u "International ESL $8/saat" değil **Native ESL speaking club** olarak güncellendi (maliyet $14–18/45dk bununla tutarlı). Hâlâ bekleyen küçük girdi: dönem paketi tanımı (hafta × ders/hafta) + öğrenci katılım modeli (12 ayrı kamera vs sınıftan tek ekran — video maliyeti $40 fiyatta satışın ~%6'sı, yönetilebilir).

### 13. Safeguarding: US-dışı background vendor + politika (G0) ⛔ *(reşit-olmayan ilk seans öncesi)*

**Soru:** US-dışı eğitmenler (arzın çoğunluğu) için background check nasıl: uluslararası vendor (Sterling / GoodHire International / Certn vb.) mı, ülke sabıka belgesi (Persona belge-yükleme akışıyla) mi, ikisi birden mi? Safeguarding politikasını (davranış kuralları, kayıt, olay-müdahale) kim yazar/onaylar — hukukçu dahil mi?

**Neden önemli:** İncelemenin 1 numaralı bulgusu: tek istismar vakası şirketi bitirir; plan bu konuda sessizdi. G0 gate'i olarak işlendi (03 §0.5): reşit-olmayan içeren ilk seanstan önce vendor + yazılı politika + seans kaydı + olay-müdahale + tek-tık askıya alma hazır olmalı. "Vetted" tanımı (#8 kararı) buna göre genişler: KYC ✓ + background ✓ + safeguarding eğitimi ✓ rozetleri okul-yüzlü profilde.

**Ekip önerisi:** Uluslararası vendor (fiyat/kapsam karşılaştırması hafta-0 A0 kapsamında) + ülke belgesi ikisi birden (vendor kapsamadığı ülkede belge zorunlu); politika taslağını ekip yazar, eğitim hukuku deneyimli avukat onaylar; reşit-olmayan seans kaydı retention'ı 90 gün.

**KARAR (kurucu, 2026-07-10): ÜLKE BELGESİ YETERLİ** — uluslararası background vendor'ı Faz-1'de YOK. İşlenmesi: ülke sabıka/police-clearance belgesi zorunlu evrak setine girer (Persona belge-yükleme akışıyla toplanır; süresi/geçerliliği İK görüşmesinde teyit edilir); Checkr yalnız US-resident eğitmen olursa. G0 gate'inin diğer bileşenleri AYNEN geçerli (yazılı safeguarding politikası, reşit-olmayan seans kaydı, olay-müdahale, tek-tık askıya alma). Okul-yüzlü rozetler: KYC ✓ + ülke belgesi ✓ + safeguarding eğitimi ✓.
