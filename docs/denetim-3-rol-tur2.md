# Üç-Rol Denetim Raporu — Tur 2 Sentezi (2026-07-11)

**Bağlam:** İlk üç-rol denetiminin (bkz. `docs/denetim-3-rol.md`) P0–P2 bulguları üç turda kapatılmış (Tur A `e681456`, Tur B `77cd51c`, Tur C `2f70436`), G0 kapısı 0015 ile koda taşınmış ve arayüz "liquid glass" tasarımına geçirilmişti. Bu ikinci turda üç YENİ bağımsız denetçi (platform sahibi, okul zümre başkanı, ESL eğitmeni) aynı rol yolculuklarını canlı sistemde, gerçek kayıtlarla, uçtan uca yeniden yaşadı. Amaç: kapanışların canlıda doğrulanması + kalan/yeni risklerin pilot öncesi tespiti. Kod değiştirilmedi, commit yok, `payments_frozen=f` korundu; test verileri `denetim2-`/`Denetim2` önekli.

---

## HÜKÜM

Para/dispatch çekirdeği üç denetçinin ortak kanaatiyle pilotu taşıyacak sağlamlıkta: ledger denetim boyunca sıfır ihlal verdi, hold/settle/iade/itiraz/payout zinciri ve G0 kapısı (negatif+pozitif testlerle) canlıda kusursuz işledi; ilk denetimin 23 kapanış kaleminden 18'i canlıda DOĞRULANDI. Ancak pilot **bugün açılamaz**: iki kalem fiilen yeniden açıldı — üç çekirdek eğitmen e-posta şablonu hâlâ Türkçe (üstelik ücret ve teklif süresi yazmıyor) ve bakiye yüklenince bloke slotu açan kod yolu HİÇ yok ("otomatik denenir" vaadi karşılıksız). Üçüncü bloker iletişim görünürlüğü: e-posta teslim hattı fiilen kapalıyken tüm sağlık göstergeleri yeşil. Bu üç P0 küçük yamalarla kapanır; kapandığı gün — ve RESEND anahtarı ancak e-posta şablonları düzeltildikten SONRA takılmak şartıyla — pilot açılabilir. İlk pilot haftasına da eğitmen clawback şeffaflığı ve reject-sonrası para çözümü (P1) alınmalı.

---

## KAPANIŞ DOĞRULAMA TABLOSU

İlk denetimin ✅ işaretli her kalemi için üç denetçinin canlı bulgusu. **Özet: 18 DOĞRULANDI · 5 KISMEN · 0 tam kalem HÂLÂ SORUNLU — ancak iki kalemin birer bileşeni (P0#2 içindeki bloke-slot, P0#5 içindeki e-postalar) fiilen hâlâ sorunlu olup aşağıda YENİ P0 olarak yeniden açıldı.**

| # | İlk denetim kalemi | Hüküm | Denetçi(ler) | Kanıt (tek cümle) |
|---|---|---|---|---|
| P0.1 | dispatch_ready bug'ı (davetli eğitmen teklif alamıyor) | **DOĞRULANDI** | Sahip + Okul + Eğitmen (3/3) | Görüşme-accept anında `dispatch_ready=t` oldu ve reçete kesilince teklifler eğitmene düştü (eğitmen: 5/5 slot); panodaki toggle round-trip de çalıştı. |
| P0.2 | Worker görünmezliği (healthz, heartbeat, kill-switch alarmı) | **KISMEN — ÇELİŞKİLİ** | Sahip: DOĞRULANDI · Okul: KISMEN | 9 heartbeat canlı, healthz bayat sentinel'de `ok:false` / tazede `ok:true`, probe bayatta exit 1, cron'lar (backfill/offer-timeout) kendiliğinden döndü — AMA dispatcher yeşilken `sent:0/skipped:69` ("e-posta çıkmıyor" hiçbir göstergede yok), bayat sentinel için proaktif alarm yok; kill-switch outbox alarmı yalnız kod+test (canlı tetiklenmedi — kanıt zayıf), MANUEL toggle ise hiç iz bırakmıyor; ayrıca kalemin dayandığı okul-B1 bileşeni (bloke slot açma) hâlâ sorunlu → yeni P0-B. |
| P0.3 | Ders zaman-penceresi (erken start / kısa ders) | **DOĞRULANDI** | Sahip + Okul + Eğitmen (3/3) | Erken start reddedildi ("8662 dk" / "23 dk" mesajları), 2 dk'lık dersler para İŞLEMEDEN review kuyruğuna düştü, Onayla→para işledi / Reddet→para dokunulmadı (audit `money_untouched:true`). |
| P0.4 | Teklif/link iletim boşluğu (admin UI) | **DOĞRULANDI** | Sahip + Okul | "Bekleyen teklifler" kartı + `reissueOffer` tam URL + son geçerlilik canlı; okul denetçisi bu linkle teklif kabul etti. |
| P0.5 | Eğitmen yüzü İngilizce | **KISMEN — ÇELİŞKİLİ** | Sahip: KISMEN · Okul: DOĞRULANDI · Eğitmen: KISMEN | Davet/teklif/panel/ders SAYFALARI + sözleşme + hatalar tamamen İngilizce ve eğitmen diliminde (3 denetçi doğruladı; okul yalnız sayfaları test ettiği için DOĞRULANDI dedi) — ama `teacher_invite`/`teacher_offer`/`teacher_portal` E-POSTALARI Türkçe + tr-TR tarihli, error/404 boundary'leri de yalnız Türkçe (sahip + eğitmen bağımsız, kod kanıtlı) → yeni P0-A. |
| P1.1 | Sözleşme yenilendi (5 madde) | **DOĞRULANDI** | Sahip + Eğitmen | Ücret-her-teklifte, 2-hafta Wise, <24s %50, 3-strike, pilot hükmü — eğitmen ekran görüntüsüyle okudu; "pilot placeholder" başlığı bilinçli duruyor. |
| P1.2 | payout_details (Wise/IBAN tutuluyor + maskeli) | **DOĞRULANDI** | Sahip + Eğitmen | Onboarding'de Wise girildi → panelde maskeli, panelden IBAN'a güncellendi (`••••6819` + hesap sahibi), CSV'de 3 kolon + eksik-detay uyarı listesi canlı. |
| P1.3 | Dış mutabakat + chargeback ingest | **KISMEN** | Sahip | Manuel Wise snapshot + fark uyarısı (UI'da kırmızı UYUŞMAZLIK) ve reconciler heartbeat canlı; chargeback ingest yalnız kod+test (Stripe anahtarı yok — kanıt zayıf); kart-clearing penceresi bilinçli Faz-2 borcu; AYRICA beklenen-Wise-bakiyesi fonlama modellenmediği için anlamsız (−32 USD) → yeni P1-D. |
| P1.4 | Outbox kancaları (4 şablon) | **DOĞRULANDI (üretim) — teslim ayrı bulgu** | Sahip: DOĞRULANDI · Okul: KISMEN | Dört şablon da (`school_topup_settled`, `teacher_interview_scheduled`, `teacher_slot_cancelled`, `school_dispute_resolved`) canlı üretilip outbox'a düştü; okulun KISMEN itirazı üretime değil TESLİME (RESEND anahtarı yok, her şey sonsuza dek `pending`) → yeni P0-C. |
| P1.5 | Skip-week slot iptali | **DOĞRULANDI** | Sahip + Okul | >24s dal otomatik ücretsiz iptal + tam iade + eğitmen bildirimi; ≤24s dal iptal etmeyip %50 uyarısıyla bilinçli iptale yönlendirdi — ikisi de canlı, ekstreyle birebir. |
| P1.6 | Yoklama okula görünür | **DOĞRULANDI** | Sahip + Okul | Slot detayında tam adlı katıldı/gelmedi listesi + sınıf devam raporu (oran + işaretsiz ders sayacı); eğitmen tarafı maskeli kalmaya devam ediyor. |
| P1.7 | timezoneSchema doğrulaması | **DOĞRULANDI** | Sahip + Okul + Eğitmen (3/3) | "Manila" ve "NotAZone" tüm girişlerde "invalid IANA timezone" ile reddedildi; tüm saatler doğru dilimde. |
| P1.8 | Test verisi hijyeni (docs/deploy.md §4) | **KISMEN — ÇELİŞKİLİ** | Sahip: DOĞRULANDI · Okul: HÂLÂ SORUNLU | Vaat edilen kapanış (dokümante prod-taze-DB kuralı) mevcut ve sahip yeterli saydı; ama okul denetçisi canlı ekranda iki "Smoke USD" banka hesabını ve Smoke eğitmenleri YİNE gördü, `platform_admin` tablosunda 16 test kaydı duruyor — kural kâğıtta, ortam kirli. |
| P1.9 | hr ham 500'ler | **DOĞRULANDI** | Sahip + Okul | docs_pending→interview→active zinciri otomatik (evrak-önce yolunda 500 yok); mükerrer davet dostane mesajla dönüyor. |
| P2.1 | Eğitmen self-servisi (müsaitlik, drop, strike, kayıp link) | **DOĞRULANDI** | Sahip + Okul + Eğitmen (3/3) | Müsaitlik CRUD canlı, "Drop this lesson" yalnız kendi dersinde (yabancı slot reddi canlı test edildi; drop→reoffer, strike 0 kaldı), "Strikes 0/3" panelde, /egitmen/link varlık sızdırmıyor + 15 dk rate-limit tuttu. |
| P2.2 | Reçete iptal + çoğaltma | **DOĞRULANDI** | Sahip + Okul | cancelPlan sayımları ekstreyle tutarlı; "Başka sınıflara uygula" 7B'ye 4/4 slot açıp sınıf başına sonuç gösterdi; yerinde saat düzenleme bilinçli Faz-2 borcu. |
| P2.3 | 250-sınıf ölçeği | **KISMEN (bilinçli borç)** | Sahip | Çoğaltma + plan-başına hata izolasyonu canlı; CSV toplu reçete bilinçli yok (çoğaltma pilotu karşılıyor). |
| P2.4 | Havale görünürlüğü | **DOĞRULANDI** | Sahip + Okul | /okul'da TN-referanslı bekleyen havale kartı + "dekonta TN- kodunu yazın / TL'de banka kuru" notu canlı; (küçük eksik: IBAN sonradan ekranda yok — P2 listesinde). |
| P2.5 | healthStrip | **DOĞRULANDI** | Sahip + Okul | Bugünkü/canlı ders, en eski bekleyen havale yaşı, failed payout, bekleyen bildirim, 9 worker heartbeat rozeti — hepsi dolu. |
| P2.6 | Metrik boşlukları | **DOĞRULANDI** | Sahip + Okul | Funnel geçiş süre medyanları + repeatTopupRate (oran) + dakika-bazlı gerçekleşme (%1.3 dürüstçe kırmızı) canlı; not: funnel yalnız funnel-loglu okulları saydığı için pano tutarsız görünebiliyor (yeni P2). |
| P2.7 | Ekstre CSV + dostane satırlar + /sinif-dersi school_tz | **DOĞRULANDI** | Sahip + Okul | BOM'lu ';' ayraçlı CSV gerçekten indirildi; satırlar "Ders rezervi — 7A, 17 Tem 2026" formatında, itiraz satırları etiketli; projeksiyon sayfası okul saatinde ve iki dilli. |
| P2.8 | Yoklama işaretsiz başlar | **DOĞRULANDI** | Sahip + Okul | `present:null` başlangıç + "Mark all present" + bitirirken "3 students unmarked" onayı ve absent yazımı canlı. |
| G0 | 0015 — minors × safeguarding kapısı | **DOĞRULANDI** | Sahip (+ Okul dolaylı) | Üç yönlü canlı test: minors=true + evrak yalnız submitted → "uygun aday yok"; minors=false → AYNI slotta teklif anında çıktı; evraklar verified → trigger `safeguarding_ready=t` yaptı ve teklif düştü; okul tarafında teklif alan üç eğitmenin üçü de safeguarding_ready=t. |

**Çelişki özeti:** (1) P0.2'de sahip görünürlük katmanını DOĞRULANDI sayarken okul "gösterge yeşil ama e-posta çıkmıyor / bloke slot açılmıyor" diye KISMEN dedi — ikisi de doğru: görünürlük araçları çalışıyor, kapsam boşlukları yeni bulgulara taşındı. (2) P0.5'te okul DOĞRULANDI dedi ama yalnız web sayfalarını test etmişti; sahip ve eğitmen e-posta şablonlarını kodda bağımsız okuyup Türkçe buldu — e-posta katmanı hâlâ sorunlu. (3) P1.8'de sahip dokümante kuralı yeterli saydı, okul canlı ekrandaki Smoke kalıntılarını yeniden raporladı.

---

## YENİ BULGULAR

Aynı bulguyu birden fazla denetçi bağımsız gördüyse **[2×]/[3×]** ile işaretli (güven yüksek).

### P0 — Pilot blokerleri

| # | Bulgu | Kaynak + kanıt | Önerilen fix |
|---|---|---|---|
| **P0-A** | **Üç çekirdek eğitmen e-postası hâlâ Türkçe + teklif e-postasında ücret ve TTL yok. [2× — sahip B1 + eğitmen B1/B3, bağımsız kod kanıtı]** `notification-dispatcher.ts`'te `teacher_invite` ("Merhaba, Teachernow eğitmen kadrosuna davetlisiniz"), `teacher_offer`, `teacher_portal` Türkçe ve tr-TR tarihli; yalnız bu turda eklenen iki şablon (slot_cancelled, interview_scheduled) İngilizce — koddaki "eğitmen-yüzlü şablonlar İNGİLİZCE" yorumu yanlış. Teklif e-postası payload'ında rate yok, "Teklifler süreli" diyor ama 20 dk'yı yazmıyor. Manila'daki eğitmenin İLK teması davet e-postası; RESEND açıldığı an bu şablonlar aynen akar. | Üç şablonu İngilizceye çevir + en-US/eğitmen-dilimi tarih + teklif e-postasına ücret ve kalan süre (isteğe: Accept/Decline derin linkleri). **RESEND anahtarı bu kapanmadan TAKILMAMALI.** |
| **P0-B** | **Bloke slot bakiye yüklenince ASLA otomatik açılmıyor — ilk denetim okul-B1'in yeniden açılması. [okul B1 — canlı + kod kanıtı]** Sihirbaz "bakiye yüklenince otomatik denenir" vaat ediyor; oysa `blocked_insufficient_funds`→`scheduled` geçişi yapan HİÇBİR kod yolu yok: materializer mevcut occurrence'ı `ON CONFLICT (plan_id, occurrence_key) DO NOTHING` ile atlıyor (`packages/modules/dispatch/src/materializer.ts:154-172`), settle'da tetik yok, sweeper'larda yok. Canlı: 800 USD settle + materializer elle koşuldu → `{"created":0,"blocked":0,"skipped":20}`, 4 slot bloke KALDI; tek çıkış planı iptal edip yeniden açmak. İlk turda kapanış worker'a bağlanmıştı; kök neden retry kod yolunun yokluğu. | Settle anında blocked-slot retry (materializer'da blocked'lar için ayrı UPDATE yolu) + programda "şimdi tekrar dene" düğmesi. |
| **P0-C** | **E-posta teslim hattı fiilen kapalı ve HİÇBİR gösterge bunu söylemiyor. [2× — okul B2 + sahip C1]** Dispatcher 2 dk'da bir koşup `{"sent":0,"skipped":69}` dönüyor (RESEND_API_KEY yok — bilinçli bekleme), tüm okul/eğitmen bildirimleri sonsuza dek `pending` (outbox bu turda 22→95); healthStrip/healthz dispatcher'ı YEŞİL gösteriyor. Sentinel de ~6 saat bayat kaldı ve bunu kimseye proaktif bildiren yok (alarm kanalı yine outbox). Anahtar takılana kadar her teklif/davet/panel linki elle taşınıyor (sahip bu turda ~12 kez taşıdı). | healthStrip'e "e-posta teslimi kapalı / son 24s sent=0" göstergesi; P0-A kapanınca RESEND anahtarını tek sayfalık go-live ön kontrol listesiyle (şablon dili + test gönderimi) tak. |

### P1 — Güven / para riskleri

| # | Bulgu | Kaynak + kanıt | Önerilen fix |
|---|---|---|---|
| P1-A | **Dispute clawback eğitmene görünmez.** İtiraz iadesinde eğitmenin 16 USD'si bakiyeden sessizce düşülüyor; panelde ders hâlâ "16.00 USD earned", hiçbir satır "dispute adjustment −16" demiyor, eğitmene e-posta kancası da yok (`school_dispute_resolved` yalnız okula). Eğitmen 32 bekler, 16 alır → arz tarafında "param eksik" destek/churn. | Sahip B2 — canlı yaşandı | Panel + ekstre için ortak "para ayarlaması (adjustment)" satır tipi (clawback/SLA iadesi/geç-iptal etiketli) + eğitmene bildirim kancası. |
| P1-B | **rejectSettle sonrası paranın çözüm yolu yok.** Ret sonrası slot `scheduled`+hold'lu kalıyor; UI "hold-aging kuyruğunda karar verilecek" diyor ama öyle bir kuyruk yok — hold_aging yalnız 24 saat sonra audit_log'a düşen, hiçbir ekranda görünmeyen bir WARNING. Reddedilen ders başına ~40 USD tanımsız süre kilitli; tek resmi çıkış geçmiş-tarihli slotu iptal etmek (matrisi belirsiz) ya da psql. | Sahip B3 — canlı yaşandı | Reject anında üç seçenek: "okula iade et (slotu kapat)" / "düzeltilmiş dosajla yeniden settle" / "beklet" — hold-aging'i görünür kuyruk yap. |
| P1-C | **Manuel kill-switch iz bırakmıyor.** `admin.setPaymentsFrozen` canlı denendi: çalışıyor ama audit_log kaydı SIFIR, outbox alarmı SIFIR (system_flag'te trigger yok; alarm yalnız sentinel-engage yolunda). Bir admin oturumu parayı sessizce dondurup açabilir. | Sahip B4 — canlı yaşandı | system_flag'e audit trigger + zorunlu sebep alanı + platform_alert; ~yarım günlük iş. |
| P1-D | ✅ **[Tur F — çift-kayıt]** Wise mutabakatı yapısal olarak hep alarm veriyordu (fonlama modellenmemişti → −SUM(wise_clearing) anlamsız). Kurucu kararıyla (B) **tam çift-kayıt**: yeni `platform_capital` hesabı + `wise_funding_event`; `recordWiseFunding` [wise_clearing −X, platform_capital +X] yazar → −SUM(wise_clearing) = fonlama − ödenen = **gerçek Wise bakiyesi**. Reconciler değişmeden anlamlı; canlı doğrulandı (−48 → +452 = 500−48). /admin/odemeler'de fonlama kartı + tarihçe. Kalan: kart-clearing penceresi bilinçli Faz-2. |
| P1-E | **Mükerrer öğrenci importu sessiz kopya üretiyor ve geri alınamıyor.** Aynı satırlar ikinci kez yapıştırılınca sınıf 14→16; "Elif Aydın" yoklamada ve devam raporunda İKİ satır; roster'da öğrenci silme/düzeltme ucu YOK — kopyalar kalıcı, devam istatistiği kirleniyor. Dönem başında liste tazeleyen her okul düşer. | Okul B3 — canlı yaşandı | Import'ta isim+sınıf çakışma uyarısı ("2 kayıt zaten var — yine de ekle?") + öğrenci arşivleme. |
| P1-F | **İtiraz süreci okul UI'ında görünmez.** "İtirazınız alındı"dan sonra slotta hiçbir durum izi yok, "İtiraz et" düğmesi duruyor (aynı derse ikinci itiraz açılabildi — çifte iade idempotency ile yapısal engelli, para riski yok), sonuç yalnız ekstre satırından anlaşılıyor; e-posta da gitmediğinden (P0-C) süreç kara kutu. | Okul B4 — canlı yaşandı | Slot detayına itiraz durumu rozeti (açık/incelemede/sonuçlandı + sonuç) ; açık itirazda düğmeyi kilitle. |
| P1-G | **Review'daki ders eğitmen panelinde İZ BIRAKMIYOR ve aynı ders "Upcoming"de duruyor.** `getPanel` yalnız settled dersleri gösteriyor: 2 dk'lık ders verildi, "Under review" dendi, ama panelde ne "incelemede 1 ders / X USD beklemede" satırı var ne kazanç izi; üstelik ders slot bitene kadar "Upcoming lessons"da "Join lesson / Drop this lesson" ile listeleniyor — verilmiş dersi "bırakmak" mümkün görünüyor. "Param nerede" sorusu arz tarafında cevapsız. | Eğitmen C1-C2 + D1 — canlı yaşandı | Panele "İncelemedeki dersler" bölümü (tutar + sebep + tahmini karar süresi); review'a düşen dersi Upcoming'den çıkar. |
| P1-H | **Dersin YERİ hâlâ tanımsız + destek kanalı sıfır. [2× — okul B5 + eğitmen D5; ilk turdan beri açık]** Ders odası, projeksiyon, program — hiçbirinde video/konum bilgisi yok; tüm üründe `mailto`/destek araması 0 sonuç. 12 çocuk ve Manila'daki eğitmen nerede buluşacak, sorun anında kime yazılacak? (Şiddet çelişkisi: okul bloker sayıyor, sahip iyileştirme — ilk canlı derste operasyonel gerçek olacağı için P1'e alındı.) | Okul B5 + Eğitmen D5 — canlı tarandı | Reçeteye "ders bağlantısı" alanı (okul Zoom/Meet linki girer; ders odası + projeksiyon gösterir) + tek satırlık destek e-postası tüm yüzeylere. |

### P2 — Self-servis / ölçek

- **Payout stuck-submitted görünürlüğü yok** [sahip]: sabahki batch'in 2 payout'u 8+ saattir "submitted"; healthStrip yalnız failed sayıyor, sentinel_warning ancak psql ile görülüyor (/admin'de audit görüntüleyici yok). → healthStrip'e stuck-submitted rozeti.
- **Boş batch guard'ı yok + batch yaşam döngüsü yarım** [sahip]: ödenecek kimse yokken `createBatch` 0-payout'luk draft üretiyor; tamamen ödenen batch "exported"da kalıyor, "closed" hiç kullanılmıyor.
- **Sihirbaz funnel metriği tutarsız sayım** [sahip]: yalnız funnel-loglu okulları sayıyor (2-3 okul vs schoolCount 12) — go/no-go okurken yanıltır.
- **Worker restart'ı sonrası healthz 1 saate kadar yalancı kırmızı** [sahip]: heartbeat yalnız koşum SONUNDA damgalanıyor. → koşum başında da damga ya da restart-aware eşik.
- **İlk panel linki admin'e bağımlı** [eğitmen]: /egitmen/link yalnız kayıtlı e-postaya yeni link yolluyor; onboarding sonunda "panelinize girin" köprüsü yok — e-posta kapalıyken ilk link eğitmene hiç ulaşmaz.
- **Devam raporunda tarih aralığı yok** [okul]: bugün tüm veri bu ay olduğu için soru cevaplanıyor; dönem ilerleyince "bu ay kaç derse katıldı" yine cevapsız kalacak. → ay filtresi + CSV/PDF.
- **Katılım linki dağıtımı elle + kopyala düğmesi yok** [okul; ilk turdan beri]: uzun URL elle seçiliyor; sınıfın nasıl gireceği anlatılmıyor.
- **Teklif TTL'i sabit 20 dk, müsaitliğe duyarsız** [eğitmen]: gece 03:00'te (Manila) gelen teklif uykuda kaçar, ders sıradaki eğitmene gider. → TTL'i eğitmenin yerel saatine/müsaitliğine göre ayarla.
- **Havale IBAN'ı yalnız kod alma ânında görünüyor + Smoke test hesapları gerçek hesabın yanında listede** [okul]: "hangi hesaba gönderecektik?" sonradan cevapsız.
- **/admin/egitmenler LIMIT'siz ve taşıyor** [sahip]: 1280px'te işlem kolonu kesiliyor, 11 eğitmen = 5.400px sayfa, eksik-evrak kuyruğu ham 36 satır (UI bölümüyle kesişir).

### P3 — Fikirler (bloke etmez)

- **Ortak "para ayarlaması" satır tipi** (eğitmen paneli + okul ekstresi; clawback/SLA/geç-iptal etiketli) — P1-A ve ekstre okunabilirliğini tek hamlede çözer [sahip].
- **Okul içi bildirim merkezi**: outbox'taki school_* kayıtlarını panelde zil/liste olarak göster — e-posta anahtarı gelene kadar teslim sorununu köprüler [okul].
- **RESEND go-live ön kontrol runbook'u + outbox "test gönderimi" düğmesi** — P0-A'nın tekrarını yapısal engeller [sahip].
- **"Sonraki ödeme: 24 Tem, tahmini 32.00 USD" kutusu** panelin başına + payout satırına ders-bazlı kırılım (`payout_line` verisi mevcut, panele bağlı değil) [eğitmen].
- **Seri teklif** ("bu sınıfın 12 Cuma dersini üstlen") — okul 12 haftalık reçete kesiyor, eğitmene 20'şer dakikalık tekil teklifler gidiyor; tek kabulle iki tarafa istikrar [eğitmen; ilk turda da önerilmişti].
- Küçük pürüzler (her iki turda da not edildi): "+2h/+4h" hafta kısaltması → "hf"; Wise e-posta maskesi `••••.com` anlamsız → `d***@test.com`; "Earned this period 0.00"un payout sonrası "hiç kazanmadım" gibi okunması; escalated plana eskalasyon sinyali; landing'deki "Admin" nav'ı; iptal planda kalıcı "4 bloke" rozeti ve bitmiş derste "İptal" düğmesi gibi zombi etiketler; `resolveDispute`'un yanlış inputta Zod iç şemasını sızdırması.

---

## UI/UX DEĞERLENDİRMESİ ("liquid glass")

**Ortalama puan: 6,8/10** (sahip 7 · okul 6,5 · eğitmen 7). Üç denetçi de yeni tasarımı önceki tura göre belirgin sıçrama sayıyor.

**Ortak övgüler:** Cam kartlar/pastel zemin/hap düğmeler tüm yüzeylerde tutarlı; kart hiyerarşisi güçlü (okul paneli bakiye→runway→rezerv→aksiyon dizilimi örnek gösterildi); sihirbaz adım göstergesi net; eğitmen teklif/panel/ders odası sade ve tek işe odaklı; /sinif-dersi projeksiyondan okunacak kadar büyük ve iki dilli; TR (okul) / EN (eğitmen) dil ayrımı ~%95 tutarlı; landing artık satış yapıyor.

**Ortak şikayetler (birden fazla denetçi):**
1. **Ekstre çift-bacak sunumu + ters renk semantiği** [sahip + okul]: aynı saniyede −40 yeşil "Ders/Kesinti" ile +40 kırmızı "Rezerv"; iade 3 satır; para çıkışının yeşil görünmesi sezgiye ters — en kritik para ekranı en zor okunan ekran.
2. **Durum/rozet tutarsızlıkları** [okul + eğitmen]: kısa derste yeşil "Completed" + mavi "Under review" birlikte; escalated satırda "eğitmen aranıyor"+"oda açıldı"; iptal planda kalıcı "4 bloke"; review'daki ders "Upcoming"de.
3. **"+2h/+4h" hafta kısaltması** [sahip + okul; ikinci turdur]: saat gibi okunuyor.
4. **"Admin" nav'ı herkese görünür** [sahip + okul; ikinci turdur].
5. **Tek tema — dark yok** [okul + eğitmen]: özellikle Manila'da gece dersine giren eğitmen için hissedilir.

**Tekil ama ağır:** /admin/egitmenler pipeline'ı 1280px'te kesiliyor ve /admin 6.700px tek scroll — kurucunun en sık kullandığı ekranlar en özensizi [sahip]; eğitmen panelinde 390px'te yatay taşma — stat karoları, "Remove" düğmesi ve payout satırı kesiliyor [eğitmen, ekran kanıtlı]. (Not: sahip okul yüzünde 390px'i sorunsuz buldu — çelişki değil, farklı yüzeyler; taşma eğitmen paneline özgü.)

---

## OPERASYON YÜKÜ — "1 kişi 10 kişilik operasyon" hükmü

Bu turda insan gerektiren adımlar (sahip muhasebesi + okul/eğitmen gözlemleri):

| İnsan adımı | Bilinçli mi? |
|---|---|
| Havale eşleştirme/settle (1 tık) | ✔ Bilinçli yarı-otomatik |
| İK görüşmesi planla + karar | ✔ Bilinçli — tek zorunlu insan kapısı |
| Evrak doğrulama (5 tık/eğitmen) | ✔ Bilinçli Faz-1 (Persona vaadi hâlâ kodda yok) |
| Settle-review kararı (Onayla/Reddet) | ✔ Bilinçli ve doğru |
| İtiraz kararı | ✔ Bilinçli (pilotta kurucu) |
| Payout döngüsü (5 adım, 2 haftada bir) | ✔ Bilinçli yarı-otomatik |
| minors bayrağı yönetimi | ✔ Bilinçli politika |
| Manuel Wise bakiye beyanı | ✔ Bilinçli — ama P1-D yüzünden bugün değersiz |
| **Teklif/davet/panel linki taşıma (~12 kez/denetim)** | ✖ AÇIK — e-posta anahtarı yok + şablon dili hazır değil (P0-A/C) |
| **Bloke slot açma** | ✖ AÇIK — fiilen HİÇ KİMSE yapamıyor; tek yol plan iptal+yeniden (P0-B) |
| **Reject-sonrası para çözümü** | ✖ AÇIK — araç yok, psql (P1-B) |
| **Katılım linki dağıtımı** | ✖ AÇIK — okul elle taşıyor, kopyala düğmesi bile yok |
| **İlk panel linki üretimi** | ✖ AÇIK — admin'e bağımlı (P2) |

Bunların dışındaki HER ŞEY — slot+hold+teklif üretimi, TTL süpürme, SLA eskalasyonu+iade+bildirim (sweeper canlıda kendiliğinden escalate etti), zaman penceresi/dosaj/settle, iade matrisleri, drop-reoffer, payout hard-gate, invariant bekçisi — bu turda insansız döndü; `ledger_invariant_violations()` denetim başında, ortasında ve sonunda boş.

**Hüküm:** Vaat, para/dispatch çekirdeğinde artık ayakta (sahip). Ancak iletişim katmanı kapalıyken kurucu fiilen link kuryesi ("full otomatize" iddiası okul gözünde yarım — okul); P0-A/B/C + P1-B kapanmadan vaat uçtan uca doğru sayılamaz, kapandığında sayılır.

---

# EK 1 — PLATFORM SAHİBİ RAPORU (tam metin)

Denetim tamamlandı. Tüm kanıtlar toplandı; final rapor aşağıda.

---

# TEACHERNOW 2. TUR KURUCU DENETİM RAPORU — 11.07.2026 (17:06–18:55 UTC)

**Yöntem:** `denetim2-kurucu@test.com` hesabı açıldı, psql ile platform_admin yapıldı (deploy.md §1.4 yolu). Tüm yolculuk CANLI sistemde gerçek kayıtlarla yaşandı: okul (Denetim2-Kurucu Koleji) + eğitmen (denetim2-kurucu-egitmen@test.com, Asia/Manila) + $1.000 havale + 7 reçete + 3 gerçek ders (biri 9 dk otomatik settle, ikisi 2 dk review) + 2 itiraz + 1 payout batch. Ekran kanıtları scratchpad'de `ui-01..ui-22-*.png`. Not: aynı anda 2 paralel denetçi oturumu daha koşuyordu (Denetim2-MEV, Denetim2-ESL); verilerine dokunulmadı — tek istenmeyen iz: müsaitlik çakışması yüzünden E-planı teklifleri DENETIM-ESL Öğretmen'e gitti, kabul edilen 3 slot >24s ücretsiz iptalle geri alındı (3 outbox bildirimi kaldı, e-posta gitmiyor).

## A. ÇALIŞAN VE YETERLİ (kanıtlı)

1. **G0 kapısı UÇTAN UCA SAĞLAM (bu turun ana sorusu).** Canlı deney, üç yönlü: (a) minors=true (varsayılan — DB'de doğrulandı) + evraklar yalnız `submitted` → aktif+dispatch_ready+müsait eğitmenime `reissueOffer` → **"uygun aday bulunamadı"**; (b) `setSchoolMinors(false)` → AYNI slotta teklif ANINDA safeguarding'siz eğitmene çıktı; (c) minors=true'ya dönüş → teklif geri çekildi, aday yok. 5 evrak `verified` → DB trigger'ı `safeguarding_ready=t` + `payout_ready=t` yaptı → teklif eğitmenime düştü. /admin/egitmenler rozeti "evrak ✗"→"onaylı ✓" döndü (ui-03/ui-05), okul bayrağı kartı /admin'de çalışıyor (ui-01).
2. **dispatch_ready otomasyonu:** `completeInterview(accept)` → `status=active` + `dispatch_ready=t` tek adımda (DB kanıtı). Evraklar görüşmeden ÖNCE beyanlıyken 500 yok — docs_pending→interview→active zinciri otomatik. Panoda geri alınabilir toggle da çalışıyor (API round-trip).
3. **Ders zaman-penceresi + settle-review çekirdeği:** Erken start engellendi ("starts in 23 minutes — you can start at most 15 minutes early"); pencere içi 9 dk/15 dk ders OTOMATİK settle (teacher_payable 0→1600, hold tüketildi); 2 dk'lık iki ders `reviewRequired:true` ile kuyruğa düştü ve **para İŞLEMEDİ**; Onayla → para işledi (bakiye 1600→3200); Reddet → para işlemedi, slot `scheduled`+hold intakt, audit `settle_rejected {money_untouched:true}`.
4. **Para çekirdeği yine kusursuz:** topup settle → bakiye; slot başına hold; SLA eskalasyonunda tam iade; itiraz iadesi ters-kayıtla (reason_code=dispute) + eğitmen clawback; payout yalnız sonuç-CSV'sinde işledi; mükerrer sonuç importu "payout submitted değil" uyarısıyla düştü (çift ödeme yapısal imkânsız — canlı denendi); benim yanlışlıkla ikinci kez koşturduğum batch bile 0 payout üretti (bakiye 0 → yapısal koruma). **`ledger_invariant_violations()` denetim başında, ortasında ve sonunda BOŞ.**
5. **Worker artık görünür ve dürüst:** healthz denetim başında `ok:false` dedi (worker 17:02 restart'ı sonrası sentinel bayattı), 18:00 sentinel koşumundan sonra `ok:true`; probe bayat worker'da `exit 1` verdi (canlı). Cron'lar gerçekten döndü: backfill-sweeper 17:30'da eğitmensiz B slotunu **kendiliğinden escalate etti** (tam iade + audit `sla_escalated` + `school_sla_escalated` outbox); offer-timeout-sweeper 18:30:13'te iki 7B teklifini expire etti (DB kanıtı).
6. **Bildirim kancaları dört şablonda canlı üretiliyor:** `school_topup_settled` (settle anında, referans kodlu payload), `teacher_interview_scheduled`, `teacher_slot_cancelled` (lateCancel bilgili), `school_dispute_resolved` (outcome=refunded/released, refundedCents=4000) — hepsi outbox'ta doğrulandı.
7. **"Bekleyen teklifler" kartı + reissueOffer:** kart slot/okul/eğitmen/son-geçerlilik gösteriyor; "Linki üret/yenile" tam URL + expiry döndürüyor. Teklif sayfası (ui-04) eğitmen dilinde/diliminde, ücretli, süreli.
8. **Okul self-servisi olgun:** sihirbaz (bakiye+atla), bekleyen havaleler TN-referans + kur notu, reçete önizleme, skip-week artık slotu OTOMATİK ücretsiz iptal ediyor, >24s iptal tam iade, cancelPlan, "Başka sınıflara uygula" (sınıf başına sonuç raporu), yoklama tam adla + devam raporu (oran + işaretsiz ders sayacı), BOM'lu CSV ekstre, ders-bazlı açıklamalı satırlar, İTİRAZ satırları etiketli ("İtiraz iadesi/düzeltmesi").
9. **Eğitmen self-servisi çalışıyor:** portal linki üzerinden müsaitlik CRUD (canlı eklendi; geçersiz "Manila" tz'si reddedildi), "Drop this lesson" yalnız KENDİ dersinde (yabancı slot: "This lesson is not assigned to you" — canlı negatif test), strikes 0/3 rozeti, maskeli payout detayı + güncelleme formu, /egitmen/link self-yenileme (var olmayan e-postada da `ok:true` — varlık sızdırmıyor).
10. **Payout hattı:** eksik-detay uyarı listesi (8 eğitmen), hard-gate held listesi (payout_ready=f bakiyeliler batch dışı), CSV'de `payout_method,payout_value,account_holder` kolonları, markSubmitted→paid importu→panelde "paid + WISE-DENETIM2-001". Yetki sınırları: okul kullanıcısı admin/payout uçlarından "platform yöneticisi yetkisi gerekli" ile dönüyor; yabancı slot "bulunamadı".

## B. KRİTİK EKSİK (pilot bloker / para-güven riski)

1. **Eğitmen E-POSTALARI hâlâ Türkçe — İngilizceleştirme yarım kalmış.** `notification-dispatcher.ts`: `teacher_offer` ("Merhaba, Size yeni bir ders teklifi var… Teklifi görüntüle ve yanıtla"), `teacher_invite`, `teacher_portal` şablonları Türkçe VE `tr-TR` tarih formatlı; yalnız YENİ eklenen iki şablon (slot_cancelled, interview_scheduled) İngilizce (satır 167'deki yorum "eğitmen-yüzlü şablonlar İNGİLİZCE" diyor ama üç çekirdek şablon çevrilmemiş). Manila'daki eğitmenin İLK teması davet e-postası — Türkçe gelirse web sayfalarının İngilizce olması işe yaramaz. Ayrıca teklif e-postasında ÜCRET ve TTL süresi (20 dk) hâlâ yazmıyor ("Teklifler süreli" — kaç dakika?). RESEND açıldığı anda bu şablonlar aynen akmaya başlayacak → **anahtar takılmadan ÖNCE düzeltilmeli.**
2. **Dispute clawback eğitmene GÖRÜNMEZ.** Canlı: A dersinin 16 USD'si panelde "Recent lessons: 9 min — 16.00 USD earned" olarak duruyor; itiraz iadesiyle bakiyeden sessizce düşüldü, payout 16 USD çıktı. Eğitmen 2 ders × 16 = 32 bekler, 16 alır — hiçbir satır "dispute adjustment −16" demiyor, e-posta da yok (school_dispute_resolved yalnız OKULA gidiyor). Bu, arz tarafında "param eksik yattı" destek/`churn` üretir.
3. **rejectSettle sonrası paranın çözüm yolu YOK.** Ret sonrası slot `scheduled`+hold'lu kalıyor; UI "hold-aging kuyruğunda karar verilecek" diyor ama öyle bir kuyruk YOK — hold_aging yalnız sentinel'in 24 saat SONRA audit_log'a yazdığı, hiçbir ekranda görünmeyen bir WARNING. Okulun parası tanımsız süre hold'da; tek resmi çıkış okulun geçmiş-tarihli slotu "iptal" etmesi (matrisi belirsiz) ya da psql. Reddedilen ders başına ~40 USD kilitleniyor.
4. **Manuel kill-switch toggle'ı iz bırakmıyor.** `admin.setPaymentsFrozen` canlı denendi: çalışıyor ama audit_log kaydı SIFIR, outbox alarmı SIFIR (system_flag'te trigger yok; alarm yalnız sentinel-engage yolunda). Bir admin oturumu parayı sessizce dondurup açabilir — tek kişilik operasyonda bile "ne zaman, kim, neden" forensiği şart.
5. **Wise mutabakatı yapısal olarak hep alarm verecek.** Ledger "beklenen Wise bakiyesi"ni −SUM(wise_clearing) diye türetiyor = **−32.00 USD** (canlı). Wise hesabını dışarıdan fonlamak ledger'da modellenmediği için gerçek bakiye (ör. 1.250) girildiğinde fark daima devasa ("UYUŞMAZLIK: 132.00 USD" — ui-16). Günlük reconciler bunu her gün alarmlar → alarm yorgunluğu, gerçek sızıntı görünmez olur.

## C. OTOMASYON / SELF-SERVİS BOŞLUKLARI

- **E-posta anahtarı yok → teklif/davet/panel linki taşıma %100 insan işi.** Bu turda 10+ teklif linkini elle taşıdım; outbox 22→95 pending'e çıktı. Bilinçli bekleme, ama B1'deki şablon dili nedeniyle anahtar takmak bugün güvenli değil.
- **Evrak doğrulama** eğitmen başına 5 tık (bilinçli Faz-1; Persona vaadi hâlâ kodda yok).
- **Payout stuck-submitted alarmı yalnız worker console + audit'te.** Sabahki batch'in 2 payout'u 8+ saattir "submitted"; healthStrip yalnız failed sayıyor, stuck-submitted için rozet yok (sentinel_warning satırını ancak psql ile gördüm — /admin'de audit görüntüleyici yok).
- **Boş batch guard'ı yok:** ödenecek kimse yokken `createBatch` 0-payout'luk draft üretiyor (kanıt: bc3e957a); batch yaşam döngüsü de tamamen ödendiğinde "exported"da kalıyor — "closed" durumu hiç kullanılmıyor gibi.
- **Sihirbaz funnel metriği yalnız funnel-log'lu okulları sayıyor** (2-3 okul vs schoolCount 12) — pano "1. adım 2 okul, 2. adım 3 okul" gibi tutarsız görünüyor; go/no-go okurken yanıltır.
- **Worker restart'ı sonrası healthz 1 saate kadar yalancı kırmızı** (heartbeat yalnız koşum SONUNDA damgalanıyor; işe başlarken de damga at ya da eşikleri restart-aware yap).

## D. İYİLEŞTİRMELER (bloke etmez)

1. "2026-07-17 **+2h**" hafta kısaltması hâlâ saat gibi okunuyor (önceki turda da yazıldı) — "hf" ya da "3 hafta" yazın.
2. Wise e-postası maskesi anlamsız: `••••.com` (son 4 karakter = TLD). E-posta için `d***@test.com` maskesi kullanılmalı.
3. Eğitmen paneli "Earned this period: 0.00" — payout sonrası sıfırlanınca "hiç kazanmadım" gibi okunuyor; "paid out" satırıyla bağlanmalı.
4. Ekstrede her hold 2 satır (Ders/Kesinti + Rezerv) — 1 günde 40 satır; SLA/iptal iadeleri "Rezerv iadesi" olarak etiketsiz (SLA mı, iptal mi belli değil).
5. /admin/egitmenler `Eksik evrak kuyruğu` ham 36 satır; pipeline'da eğitmen başına satır yüksekliği ekranı 5.400px yapıyor.
6. Escalated slotlu plan "aktif 0/1" görünüyor — plan satırında eskalasyon sinyali yok.
7. Landing'de "Admin" nav'ı herkese görünür (önceki tur bulgusu, duruyor).
8. Bekleyen havale kartında Sihirbaz Koleji 02:11'den beri (0.7 gün) duruyor — yaş şeritte var (iyi) ama satırda SLA renklendirmesi yok.
9. Ders odasında hâlâ video/yönerge yok ("dersi nerede işleyeceğim?" — önceki tur eğitmen bulgusu, kapsam dışı bırakılmış).
10. `smoke` banka hesapları ve 9-12 test okulu dev ortamını kirletmeye devam ediyor (prod'da taze DB kuralı yazılı — yeterli, ama metrikleri okurken gözü yoruyor).

## E. YENİ FİKİRLER (max 5)

1. **"Para ayarlamaları" satır tipi:** teacher panel + ekstre için ortak "adjustment" görünümü (dispute clawback, SLA iadesi, geç-iptal yarım ücreti etiketli) — B2'yi ve okul/eğitmen simetrisini tek hamlede çözer.
2. **Reject-çözüm sihirbazı:** settle-reddi anında üç düğme — "okula iade et (slotu kapat)" / "yeniden settle (düzeltilmiş dosajla)" / "beklet" — hold-aging'i görünür kuyruk yapar (B3).
3. **Wise fonlama kaydı:** `recordExternalBalance` yanına "Wise'a transfer ettim" girişi (platform_cash→wise_clearing) — mutabakat farkı gerçek anomaliyi ölçer (B5).
4. **system_flag audit trigger'ı + zorunlu sebep alanı:** manuel freeze/unfreeze audit + platform_alert üretsin (B4) — yarım günlük iş.
5. **RESEND go-live ön kontrol listesi:** anahtar takılmadan önce şablon dili/testi zorunlu kılan tek sayfalık runbook + outbox "test gönderimi" düğmesi (B1'in tekrarını yapısal engeller).

## F. ÖNCEKİ TUR KAPANIŞLARININ DOĞRULAMASI (docs/denetim-3-rol.md ✅ kalemleri)

**P0:**
1. dispatch_ready bug'ı → **DOĞRULANDI**: interview-accept canlıda `dispatch_ready=t` yaptı; panoda toggle round-trip çalıştı.
2. Worker görünmezliği → **DOĞRULANDI**: 9 heartbeat canlı; healthz bayatta `ok:false`/tazede `ok:true`; probe bayatta exit 1 (canlı koştu); sentinel kill-switch alarmı kod+testte (canlı tetiklenmedi — CRITICAL üretmek riskliydi). Ek not: MANUEL toggle alarmsız/audit'siz (B4).
3. Ders zaman-penceresi → **DOĞRULANDI**: erken start reddi + kısa ders → review (para yok) + Onayla/Reddet ikisi de canlı.
4. Teklif/link iletim boşluğu → **DOĞRULANDI**: "Bekleyen teklifler" kartı + reissueOffer tam URL + expiry canlı.
5. Eğitmen yüzü İngilizce → **KISMEN**: davet/teklif/panel/ders SAYFALARI tamamen EN + en-US/eğitmen-dilimi tarih (ekran kanıtlı), sözleşme 5 maddeli (rate-her-teklifte, 2-hafta Wise, <24s %50, 3-strike, pilot hükmü — kodda okundu); AMA teacher_offer/invite/portal E-POSTALARI Türkçe + tr-TR (B1) → "davet, teklif, e-postalar tamamen İngilizce" iddiası e-posta katmanında HÂLÂ SORUNLU.

**P1:**
- Sözleşme yenilendi → **DOĞRULANDI** (5 madde; "pilot placeholder" başlığı bilinçli duruyor).
- payout_details → **DOĞRULANDI**: onboarding formu + panel maskeli görünüm + CSV 3 kolonu + eksik-detay listesi canlı.
- Dış mutabakat + chargeback ingest → **KISMEN**: manuel Wise snapshot + fark uyarısı (UI'da kırmızı UYUŞMAZLIK) canlı; external-reconciler heartbeat canlı; chargeback listesi/ingest yalnız kod+test (Stripe anahtarı yok — canlı üretilemez). Kart-clearing penceresi borcu bilinçli duruyor. Ek bulgu: beklenen-bakiye işareti fonlama modellenmediği için anlamsız (B5).
- Outbox kancaları (4 şablon) → **DOĞRULANDI** (dördü de canlı üretildi).
- Skip-week → **DOĞRULANDI**: >24s slot otomatik ücretsiz iptal + tam iade + eğitmen bildirimi canlı.
- Yoklama okula → **DOĞRULANDI**: slot yoklaması tam adlı + devam raporu canlı.
- timezoneSchema → **DOĞRULANDI**: "Manila" reddedildi ("invalid IANA timezone").
- Veri hijyeni docs → **DOĞRULANDI** (deploy.md §4 mevcut).
- hr ham 500'ler → **DOĞRULANDI**: docs_pending→active zinciri otomatik; mükerrer davet dostane mesaj ("bu e-posta ile kayıtlı eğitmen zaten var").

**P2:**
- Eğitmen self-servisi → **DOĞRULANDI**: müsaitlik CRUD, dropLesson (yalnız kendi dersi — yabancı slot reddi canlı), strikes N/3, /egitmen/link (varlık sızdırmaz) hepsi canlı.
- Reçete iptal + çoğaltma → **DOĞRULANDI**: cancelPlan + applyPlanToClasses (sınıf başına sonuç) canlı; yerinde saat düzenleme borcu bilinçli duruyor.
- 250-sınıf ölçeği → **KISMEN**: çoğaltma + plan-başına izolasyon (skipped sayaçları) canlı; CSV toplu reçete bilinçli yok.
- Havale görünürlüğü → **DOĞRULANDI** (TN-referans + kur notu ekranı).
- healthStrip → **DOĞRULANDI** (bugünkü ders 12/canlı 0/havale yaşı/failed payout/bekleyen bildirim/9 worker rozeti).
- Metrik boşlukları → **DOĞRULANDI**: funnel geçiş medyanları + repeatTopupRate + dakika-bazlı gerçekleşme (%1.3 dürüstçe kırmızı) canlı.
- Ekstre CSV + dostane satırlar + /sinif-dersi school_tz → **DOĞRULANDI** (BOM kodda; satırlar "Ders rezervi — 7A, 17 Tem 2026"; sınıf sayfası 22:05 Europe/Istanbul etiketli).
- Yoklama işaretsiz başlar → **DOĞRULANDI** (`present:null` + "Mark all present" + finish'te absent yazımı).

**G0 (0015)** → **DOĞRULANDI** (bkz. A.1 — negatif test + bayrak round-trip + rozet + pozitif kontrol; matcher'daki `(NOT s.minors OR t.safeguarding_ready)` satırı canlıda birebir işledi).

**Operasyon yükü muhasebesi (bu turda insan gereken adımlar):** platform_admin SQL (bilinçli, kurulum) · havale settle 1 tık (bilinçli) · görüşme planla+karar (bilinçli — tek zorunlu insan kapısı) · 5 evrak doğrulama (bilinçli, Faz-1) · **teklif/davet/panel linki taşıma ~12 kez (AÇIK — e-posta anahtarı yok + şablon dili hazır değil)** · settle-review 2 karar (bilinçli) · itiraz 2 karar (bilinçli) · payout 5 adım (bilinçli yarı-otomatik) · manuel Wise beyanı (bilinçli ama B5 yüzünden değersiz) · minors bayrağı (bilinçli politika) · **reject-sonrası para çözümü (AÇIK — araç yok)**. Bunun dışındaki HER ŞEY (slot+hold+teklif üretimi, TTL süpürme, SLA eskalasyon+iade+bildirim, pencere/dosaj/settle, iade matrisleri, drop-reoffer, invariant bekçisi) insansız döndü. **"1 kişiyle 10 kişilik operasyon" vaadi para/dispatch çekirdeğinde artık ayakta; kalan insan işi ya bilinçli tasarım ya da B1-B5'teki 5 tamir.**

## G. UI/UX DEĞERLENDİRMESİ (liquid glass — ekran kanıtlı)

**Puan: 7/10.** Yeni tasarım dili (buzlu cam kartlar, pastel gradyan zemin, hap düğmeler) TÜM yüzeylerde tutarlı ve önceki tura göre büyük sıçrama. Okul paneli hiyerarşisi örnek nitelikte (bakiye → runway → rezerv → aksiyonlar; ui-07); eğitmen paneli/teklif/ders odası sade, tek işe odaklı ve tamamen İngilizce (ui-04/06/09/19); landing artık gerçekten satış yapıyor (ui-12); 390px mobilde kartlar düzgün istifleniyor, yatay taşma yok (ui-15); sihirbaz adım göstergesi ve `Denetim2` bakiye bağlamı net (ui-17).

**En kötü 3 nokta:**
1. **/admin/egitmenler pipeline tablosu (ui-03/05):** 1280px'te sağdaki işlem kolonu KESİLİYOR (yatay scroll konteyneri yok), satır yükseklikleri savruk (11 eğitmen = 5.400px sayfa), "Eksik evrak kuyruğu" 36 ham satır — kurucunun en sık kullanacağı ekranın en özensizi.
2. **/admin ana sayfası tek dev scroll (6.700px, ui-22):** kritik karar kartları (Settle onayı, İtirazlar) bildirim/banka gürültüsünün arasında kayboluyor; durum rozetleri Türkçe arayüzde İngilizce ("pending", "paid"); 95 satırlık ham bildirim tablosu panoda işgal alanı.
3. **Para satırlarının okunabilirliği:** ekstrede hold başına çift satır + kırmızı/yeşil "Rezerv" rozetinin işaret yönüyle çelişmesi (−40 kırmızı Rezerv vs +40 kırmızı Rezerv); "+2h" hafta kısaltması; eğitmen panelinde clawback'in hiç görünmemesi (B2 ile kesişen güven sorunu).

**Özet hüküm:** İlk denetimin "üç yerde duvara çarparsın" tablosu kapanmış — G0, zaman penceresi, teklif linki, worker görünürlüğü ve self-servis katmanı canlıda çalışıyor; ledger yine sıfır ihlalle çıktı. Bugün pilotu durduracak tek şey para değil İLETİŞİM: e-posta anahtarını takmadan önce üç Türkçe eğitmen şablonu (B1) düzeltilmeli, eğitmen clawback şeffaflığı (B2) ve reject-sonrası para çözümü (B3) ilk haftaya alınmalı. B1-B3 kapanmadan RESEND anahtarı TAKILMAMALI; kapandığı gün pilot açılabilir.

---

# EK 2 — OKUL ZÜMRE BAŞKANI RAPORU (tam metin)

Denetim tamamlandı. Tüm yolculuk canlı sistemde kendi tıklamalarımla yaşandı; kod değiştirilmedi, commit yok, `payments_frozen=f`, diğer okulların verilerine dokunulmadı. Test verisi `denetim2-` önekli; 35 ekran görüntüsü scratchpad'de (`01-landing.png … 35-program-sla.png`). İşte rapor:

---

# TEACHERNOW 2. TUR DENETİM RAPORU — MEV Koleji İngilizce Zümre Başkanı (11.07.2026)

**Yaşanan yolculuk:** Ana sayfadan kayıt (denetim2-zumre@mev.test) → 5 adımlı sihirbaz → havale talimatı (TN-CCB216AB, 800 USD) → settle (denetim2-admin@test.com'u psql ile platform_admin yaparak — İNSAN ADIMI simülasyonu) → 16 öğrenci + bozuk satırlar → 5 reçete (bloke, bugün, 4-hafta, Pazar, 7B çoğaltma) → kendi eğitmenimi HR akışından uçtan uca kurup (davet→evrak→görüşme-kabul→self-servis müsaitlik) teklif-kabul → gerçek ders (başlat/yoklama/bitir, UI tıklamalarıyla) → kısa-ders review → itiraz → eğitmen drop → SLA escalation → ekstre + CSV + devam raporu + veli sorusu.

**Süre ölçümü:** Kayıt 17:08:22 → okul kuruldu 17:11 → **ilk reçete 17:14:52 = 6,5 dakika** (script hızında; acele etmeyen zümre başkanı için 10–12 dk). "15 dakika" vaadi tutuyor — ama ilk reçetem yine "0 ders planlandı — 4 ders bloke" ile bitti (bkz. B1).

## A. ÇALIŞAN VE YETERLİ (kanıtlı)

1. **Sihirbaz yönlendiriyor.** 5 adım, adım göstergesi, hedef cümlesi, maliyet önizlemesi ("1 ders × 4 hafta ≈ 160.00 USD"), havuz listesinde fiyat etiketi + "Seçin…" zorunlu seçim (önceki yanlış-havuz kazasının önü kesilmiş). Bitiş ekranı bloke sayısını dürüstçe söylüyor. (02–08.png)
2. **Havale görünürlüğü çözülmüş.** /okul'da "Bekleyen havaleleriniz": TN-CCB216AB, 800.00 USD, talep tarihi, "onay bekliyor" rozeti + "dekonta TN- kodunu mutlaka yazın; TL gönderirseniz banka kuru geçerli, tutar farklı olabilir" notu. (09.png)
3. **Reçete → slot+hold+teklif ANINDA.** createPlan sonrası aynı saniyede 4/4 slot, bakiye 800→600 (hold), teklif atandı; DB'de doğruladım. "Başka sınıflara uygula" 7B'ye 4/4 slotu tek tıkla açtı, sınıf başına sonuç gösterdi. (13, 21–22.png)
4. **Skip-week iki dal da sözünde.** 25 Tem (>24sa): "O haftanın dersi de iptal edildi (ücretsiz)" — hold ekstrede iade. 12 Tem (<24sa): iptal ETMEDİ, "%50 keser; takvimden bilerek iptal edin" yönlendirdi; bilerek iptal ettim, +20 iade ekstrede birebir.
5. **Ders zaman penceresi ve kısa-ders koruması gerçek.** 60 dk erken start: "The lesson cannot be started yet — it starts in 60 minutes (you can start at most 15 minutes early)." 2 dakikalık ders: eğitmene "Under review — payment is pending", **para İŞLEMEDİ** (bakiye/hold değişmedi), admin kuyruğunda "kısa ders: 2 dk (planlanan 45 dk)" göründü, Onayla sonrası okulda "tamamlandı (ödendi) · 2 dk".
6. **Yoklama okul yüzünde TAM İSİMLE.** Slot detayında "Elif Aydın katıldı / Su Naz Er gelmedi" listesi; eğitmen tarafı maskeli ("Elif A."). Yoklama işaretsiz başlıyor, "Mark all present" var, bitirirken "3 students unmarked — they will be recorded as absent" onayı çıktı ve absent yazıldı. (27, 31.png)
7. **Veli sorusu 2 dakikanın çok altında.** /okul → Sınıflar → "Devam raporu": öğrenci başına Katıldı / İşaretli ders / Devam % tablosu; "Elif Aydın 1/1 %100" cevabı ~30 saniyede. (33.png)
8. **Ekstre artık rapor verilebilir.** Satırlar "Ders rezervi — Denetim2 7A, 11 Tem 2026", "Geç iptal (%50 iade) — …", "İtiraz iadesi — …" formatında; dönem toplamları + rezerv tanımı; **CSV indir gerçek dosya indirdi**: BOM (EF BB BF) + ';' ayraç — Türkçe Excel'de düzgün açılır. Dönem sonu bakiye (500.00) canlı bakiyeyle birebir. (18, 34.png, ekstre.csv)
9. **İtiraz para akışı doğru.** İtiraz (prompt) → admin iade kararı → +40 bakiyeye, ekstrede sınıf+tarihli satır, outbox'a `school_dispute_resolved` düştü. Aynı derse ikinci itiraz açılabilse de **çifte iade yapısal engelli** (idempotency anahtarı session-bazlı — kod: `dispute_refund:session:<id>`).
10. **SLA/backfill vaadi CANLI doğrulandı.** Eğitmen 21:30 dersini panelden "Drop this lesson" ile bıraktı → hold ANINDA tam iade → 10 dk'lık sweeper derse <2sa kala slotu escalate etti → okul ekranında **"SLA — ücret iade edildi"** rozeti + `school_sla_escalated` outbox kaydı. Landing'deki SLA kartıyla tutarlı.
11. **Saat dilimleri doğru.** Tüm okul ekranları Europe/Istanbul; /sinif-dersi projeksiyon sayfası iki dilli, büyük puntolu, okul saatli ("11 Tem 2026 21:30 — Planlanan başlangıç (Europe/Istanbul saati)"). (16.png)
12. **Kiracı izolasyonu.** Çereze başka okulun UUID'sini yazdım → sunucu üyeliği yeniden doğrulayıp KENDİ okuluma düşürdü; aktif-okul API'si "bu okulun üyesi değilsiniz" (403).
13. **Eğitmen yüzü tamamen İngilizce ve self-servisli** (teklif, panel, ders odası, hatalar; müsaitlik CRUD, strike 0/3, maskeli payout, "payouts every 2 weeks via Wise"). (23, 25.png)

## B. KRİTİK EKSİK (pilot bloker / para-güven riski)

1. **BLOKE DERS ASLA OTOMATİK AÇILMIYOR — vaad kodda karşılıksız.** Sihirbaz ve bitiş ekranı "bakiye yüklenince otomatik denenir" diyor; oysa `blocked_insufficient_funds` slotu `scheduled`'a çeviren HİÇBİR kod yolu yok: materializer mevcut occurrence'ı `ON CONFLICT (plan_id, occurrence_key) DO NOTHING` ile atlıyor (`packages/modules/dispatch/src/materializer.ts:154-172` → "skipped"), settle'da tetik yok, sweeper'larda yok. **Canlı kanıt:** 800 USD settle edildi, admin'den materializer elle koşuldu → `{"created":0,"blocked":0,"skipped":20}`, 4 slot bloke KALDI. Tek çıkış planı iptal edip yeniden açmak — bunu okulun keşfetmesi bekleniyor ("şimdi dene" düğmesi yok). Önceki turun okul-B1 şikâyeti işaretlendiği gibi kapanmamış: sorun worker değil, worker çalışırken de açılmıyor.
2. **E-posta hattı fiilen ölü — bildirim kapanışları kâğıt üstünde.** Dispatcher 2 dk'da bir koşuyor ama `{"sent":0,"skipped":69}` (RESEND_API_KEY yok). Bana ait 3 bildirim (havale onayı, itiraz sonucu, SLA) outbox'ta sonsuza dek "pending". Kancalar ve şablonlar güzel; TESLİM yok. Üstelik healthStrip/healthz dispatcher'ı "yeşil" gösteriyor — hiçbir gösterge "e-posta çıkmıyor" demiyor. Sentinel bugün ~6 saat bayat kaldı (healthz `ok:false` dedi — iyi), ama bunu da kimseye BİLDİREN yok; alarm kanalı da yine outbox.
3. **Mükerrer öğrenci importu sessiz kopya üretiyor ve geri alınamıyor.** Aynı iki satırı ikinci kez yapıştırdım → sınıf 14→16; "Elif Aydın" eğitmen yoklamasında da devam raporunda da İKİ satır. Roster router'da öğrenci silme/düzeltme ucu YOK — kopyalar kalıcı, tüm devam istatistiği kirleniyor. Dönem başında listeyi tazeleyen her okul bu tuzağa düşer.
4. **İtiraz süreci okul UI'ında görünmez.** "İtirazınız alındı" dedikten sonra slotta hiçbir durum izi yok; "İtiraz et" düğmesi aynen duruyor (aynı derse ikinci itiraz açabildim); sonuç yalnız ekstre satırından anlaşılıyor — e-posta da gitmediği için (B2) süreç yine kara kutu.
5. **Dersin YERİ hâlâ tanımsız + destek kanalı sıfır.** Ders odası, projeksiyon sayfası, program — hiçbirinde video/konum bilgisi yok; tüm uygulamada `mailto`/destek araması 0 sonuç. 21:07'de 12 çocuk ve Manila'daki eğitmen NEREDE buluşacak? Önceki turda da yazılmıştı, hâlâ açık.

## C. OTOMASYON / SELF-SERVİS BOŞLUKLARI

1. **Bloke slot açma → fiilen HİÇ KİMSE** (B1): ne otomatik, ne okulda düğme; admin'in bile tek aracı plan iptal + yeniden.
2. **Havale settle → insan** (bilinçli): Ben admin şapkasıyla 4 dakikada settle ettim; canlıda Sihirbaz Koleji'nin 500 USD'si 16 saattir "pending" duruyordu — healthStrip'teki "en eski bekleyen havale" göstergesi en azından bunu artık gösteriyor.
3. **Settle-review onayı → insan** (bilinçli ve doğru), ama OKUL review'da olduğunu görmüyor: slot "ders bitti · 2 dk" — param çekilecek mi çekilmeyecek mi belli değil; onaydan sonra sessizce "ödendi"ye dönüyor.
4. **Teklif/panel linki iletimi → hâlâ insan:** admin "Bekleyen teklifler" kartı + kopyalanabilir URL var (kullandım, çalışıyor) ama e-posta çıkmadığından her teklif linkini birinin elle iletmesi gerekiyor.
5. **Katılım linklerini sınıfa/eğitmene dağıtan → BEN:** "kopyalayıp iletin" — kopyala düğmesi bile yok, uzun URL elle seçiliyor.
6. **Devam raporunda tarih aralığı yok:** "bu ay kaç derse katıldı" bugün cevaplanıyor çünkü tüm veri bu ay; aralıkta rapor tüm-zamanlar toplamı — dönem ilerledikçe soru tekrar cevapsız kalacak.

## D. İYİLEŞTİRMELER (bloke etmez)

1. Ekstrede her rezerv çift satır (−40 "Ders/Kesinti" yeşil + +40 "Rezerv" kırmızı, bakiye kolonunda aynı değer) — muhasebeci olmayan için kafa karıştırıcı; rozet renkleri sezgiye ters (para çıkışı yeşil). İtiraz iadesi 3 satır. Havale satırında TN-referansı yok.
2. "2026-07-18 **+4h**" hâlâ saat gibi okunuyor (önceki D4 aynen duruyor); "Slot 0/4" başlığı açıklamasız; tamamlanan dersli plan "0/1" gösteriyor (ilerleme mi, eksik mi?).
3. /okul'da ham "STRIPE_SECRET_KEY tanımlı değil" metni duruyor (sihirbazda temizlenmiş, panelde unutulmuş).
4. Bekleyen havalenin IBAN'ı yalnız kod alma ânında ekranda; sonradan "hangi hesaba gönderecektik?" cevapsız. İki adet "Smoke USD" test hesabı gerçek Ziraat hesabının yanında hâlâ listeleniyor (kapanış yalnız deploy dokümanına yazılmış).
5. Kalıntı/zombi etiketler: escalated satırda "eğitmen aranıyor" + "oda açıldı"; iptal edilmiş planda kalıcı "4 bloke" rozeti; bitmiş derste "İptal" düğmesi.
6. Plan iptali onayı hesaplanmış özet değil genel cümle; sonuç mesajı "0 ders ücretsiz, 0 ders %50" derken 4 bloke slotu hiç anmıyor ("bir şey mi ters gitti?" hissi).
7. Bozuk satır uyarısı satır numarası veriyor ama içeriği göstermiyor; üçüncü alan (yanlışlıkla yapıştırılan veli telefonu!) sessizce atılıyor — atıldığına dair uyarı da yok.
8. Bitiş ekranı 0 ders planlanmışken "Eğitmen araması başladı" diyor.
9. "Admin" nav linki okul kullanıcısına görünür; mobilde menü iki satıra kırılıyor; koyu tema yok (tek tema — bilinçliyse sorun değil).
10. `platform_admin` tablosunda 16 kayıt (test kalabalığı temizlenmemiş); `resolveDispute` yanlış inputta Zod iç şemasını sızdırıyor.

## E. YENİ FİKİRLER (max 5)

1. **Settle anında bloke-slot retry + programda "şimdi dene" düğmesi** — B1'i kapatan en küçük yama; materializer'da blocked slotlar için ayrı UPDATE yolu.
2. **Okul içi bildirim merkezi:** outbox'taki school_* kayıtlarını panelde zil/liste olarak göster — e-posta anahtarı gelene kadar teslim problemi biter, geldiğinde de arşiv olur.
3. **Roster hijyeni:** import'ta isim+sınıf çakışma uyarısı ("2 kayıt zaten var — yine de ekle?") + öğrenci arşivleme (nakil/ayrılan).
4. **Devam raporuna ay filtresi + CSV/PDF** — müdüriyet ve veli yazışması tek tıkla.
5. **Reçeteye "ders bağlantısı" alanı:** okul Zoom/Meet linkini girsin; ders odası + projeksiyon sayfası göstersin — "ders nerede" sorusu yapısal çözülür.

## F. ÖNCEKİ TUR KAPANIŞLARININ DOĞRULAMASI (rolümü ilgilendiren ✅ kalemler)

- **P0#1 dispatch_ready (görüşme-kabul):** DOĞRULANDI — kendi eğitmenim davet→evrak(önce)→görüşme-accept yolundan ham 500 görmeden `active + dispatch_ready=t` oldu ve teklif aldı.
- **P0#2 worker görünürlüğü:** KISMEN — healthz `workers/workersOk` canlı (sentinel bayatken `ok:false` gördüm), admin şeridinde renkli heartbeat'ler; AMA dispatcher yeşilken `sent:0/skipped:69` — "e-posta çıkmıyor" hiçbir yerde görünmüyor; bayat sentinel için de proaktif alarm yok.
- **P0#3 ders zaman penceresi:** DOĞRULANDI — erken start reddi + kısa ders para işlemeden review kuyruğu + admin Onayla (canlı yaşandı).
- **P0#4 teklif linki UI'ı:** DOĞRULANDI — "Bekleyen teklifler" kartı + reissueOffer tam URL + son geçerlilik; linkle teklif kabul ettim.
- **P0#5 eğitmen yüzü İngilizce:** DOĞRULANDI — davet/teklif/panel/ders odası/hatalar İngilizce; /sinif-dersi iki dilli.
- **P1 sözleşme/Wise payout tebliği:** DOĞRULANDI (eğitmen paneli: "every 2 weeks via Wise", maskeli payout details + güncelleme formu, strike 0/3).
- **P1 okul iptali/itiraz sonucu bildirimleri:** KISMEN — kancalar çalışıyor (`school_dispute_resolved`, `school_sla_escalated`, `school_topup_settled` outbox'a düştü) ama hiçbiri TESLİM edilmiyor (B2).
- **P1 skip-week slot iptali:** DOĞRULANDI — iki dal da canlıda sözleşilen davranışta.
- **P1 yoklama okula görünür:** DOĞRULANDI — tam adlı yoklama + sınıf devam raporu.
- **P1 timezone doğrulama:** DOĞRULANDI (dolaylı) — tüm girişlerde timezoneSchema; saatler tutarlı.
- **P1 test verisi hijyeni:** HÂLÂ SORUNLU — çözüm yalnız docs/deploy.md'ye yazılmış; canlı ekranda iki "Smoke USD" hesabı ve Smoke eğitmenler duruyor; ben yine gördüm.
- **P2 eğitmen self-servisi:** DOĞRULANDI — müsaitlik CRUD (portal token'la ekledim), "Drop this lesson" (canlı kullandım, para anında iade), strike göstergesi, kayıp-link self-yenileme sayfası.
- **P2 plan iptali + çoğaltma:** DOĞRULANDI — iptal sayımları ekstreyle tutarlı; çoğaltma 7B'ye 4/4. Kalan borç aynen (yerinde saat düzenleme yok — iptal+yeniden).
- **P2 havale görünürlüğü:** DOĞRULANDI — TN-ref + kur notu /okul'da. (Eksikleri D4'te.)
- **P2 healthStrip:** DOĞRULANDI — bugünkü/canlı ders, en eski havale yaşı, başarısız payout, 9 heartbeat, bekleyen bildirim sayısı.
- **P2 metrikler:** DOĞRULANDI — funnel geçiş süre medyanları, repeatTopupRate (oran), minuteRealizationRate API'de dolu.
- **P2 ekstre CSV + dostane satırlar + /sinif-dersi school_tz:** DOĞRULANDI (BOM'lu ';' CSV indirdim; satırlar sınıf+tarihli; projeksiyon okul saatinde).
- **P2 yoklama işaretsiz başlar:** DOĞRULANDI — "3 students unmarked" onayı + absent yazımı canlı.
- **G0/0015:** DOĞRULANDI — okulum minors=t; teklif alan üç eğitmenin üçü de safeguarding_ready=t; admin'de okul başına "evet — G0 devrede" kartı.
- **Okul B1 (bloke ders bakiye sonrası açılmıyor):** HÂLÂ SORUNLU — bkz. B1; kapanış worker'a bağlanmıştı, gerçek kök neden (retry kod yolu yokluğu) duruyor.

## G. UI/UX DEĞERLENDİRMESİ (yeni "liquid glass" tasarım) — **6,5/10**

Genel: temiz, ferah, kart hiyerarşisi ve rozet dili tutarlı; sihirbaz ve eğitmen paneli gerçekten iyi; /sinif-dersi projeksiyondan okunacak kadar büyük ve iki dilli; mobilde /okul düzgün akıyor (24.png). Dil %95 tutarlı Türkçe (okul yüzü) / İngilizce (eğitmen yüzü).

En kötü 3 nokta (ekran kanıtlı):
1. **Ekstre çift-bacak sunumu ve ters renk semantiği** (18/34.png): aynı saniyede −40 yeşil "Ders/Kesinti" + +40 kırmızı "Rezerv", bakiye kolonu ikisinde de aynı; iade üç satır. Muhasebeci olmayan okuyucu için en kritik ekran en zor ekran.
2. **Program tablosunda buton/rozet enflasyonu ve kalıntı durumlar** (15/22/35.png): satır başına 4 buton (ikisi kırmızı "danger"), "+4h", "0/1", iptal planda kalıcı "4 bloke", escalated satırda "eğitmen aranıyor"+"oda açıldı" — güven veren ekran değil, ayıklanmalı.
3. **Kabuk pürüzleri:** okul kullanıcısına görünen "Admin" nav'ı, mobilde iki satıra kırılan menü, /okul'daki STRIPE_SECRET_KEY ham metni, tek tema (dark isteği yok sayılıyor), link kopyalama affordance'ının hiç olmaması.

**Özet hüküm:** Para çekirdeği, zaman penceresi korumaları, SLA otomasyonu ve yoklama/devam hattı bu turda canlıda hakkıyla çalıştı — geçen tura göre ciddi sıçrama. Ama pilotu bugün açsam ilk hafta iki yerde duvara çarparım: **para yatırıp dersi hiç başlamayan okul** (B1 — vaat edilen otomatik yeniden deneme kodda yok) ve **hiçbir bildirimin kimseye ulaşmaması** (B2). İkisi de küçük yamalarla kapanır; kapanmadan "full otomatize" iddiası okul gözünde yine yarım.

---

# EK 3 — ESL EĞİTMENİ RAPORU (tam metin)

I have completed the full teacher journey with evidence at every step. Compiling the final audit report.

Kanıtları topladım, yolculuğu uçtan uca yaşadım. İşte denetim raporum.

---

# TEACHERNOW EĞİTMEN DENETİM RAPORU — 2. TUR (2026-07-11)
**Persona:** Denetim2 Maria Santos — Manila'da yaşayan native ESL eğitmeni (Asia/Manila, +63, Türkçe bilmiyor)
**Yaşanan akış:** davet linki → onboarding (profil/sözleşme/evrak/Wise) → panel (müsaitlik + IBAN) → 5 teklif (4 kabul, 1 red) → ders (erken-start reddi, yoklama, settle) → kısa ders (review) → ders bırakma → kayıp link. Tümü canlı, gerçek kayıtlarla. Tek elle-DB müdahalem: denetim admin'ime `platform_admin` grant'i (görev gereği). `payments_frozen` dokunulmadı, kod/commit yok.

---

## A. ÇALIŞAN VE YETERLİ (kanıtlı)

1. **P0'ın en kritiği kapanmış: davetli eğitmen artık derse çıkıyor.** Görüşme "accept" edildiği an `dispatch_ready` otomatik `true` oldu (pipeline satırı: `"dispatchReady":true, "payoutReady":true, "safeguardingReady":true`); okul reçete kesince 5 slotun 5'i de bana teklif olarak düştü. Geçen turun "organik arz ölü doğuyor" bulgusu canlıda çözülmüş.
2. **Saat dilimi matematiği kusursuz, hep Manila.** DB'de slot `2026-07-11 18:45 UTC` → teklif/ders/panel hepsi "Sunday, July 12, 2026 at 2:45 AM — Asia/Manila time" (18:45+8=02:45 ✓, en-US). Teklif son geçerliliği de "Expires Jul 12, 2026, 2:40 AM (Asia/Manila time)" — geçen turdaki "tr-TR tarayıcı diliminde basılıyor" bulgusu düzelmiş.
3. **Ücretim her yerde net ve tek yönlü gizli.** Teklif kartı "Your rate for this lesson 16.00 USD"; ders odası "Your rate 16.00 USD"; panel "Earned this period". Okulun ödediği 40 USD API'den hiç sızmıyor (offer/session uçları `price_cents` döndürmüyor).
4. **Sözleşme artık beni koruyacak 5 maddeyi yazıyor** (screenshot'la okudum): Pay = "per lesson, rate shown on every offer and in your panel before you accept"; Payouts = "every 2 weeks via Wise, after documents verified"; Cancellations = "<24h school cancel → 50%"; No-shows = "3 strikes → suspension". Geçen turun "ücret/döngü/strike hiç yazmıyor" bulgusu kapanmış.
5. **Wise/IBAN sistemde tutuluyor ve maskeli.** Onboarding'de Wise e-postası girdim → panelde `Wise e-mail ••••test`; panelden IBAN'a güncelledim → `IBAN ••••6819 — account holder Maria Santos`. Ham değer hiç dönmüyor.
6. **Müsaitlik self-servisi çalışıyor.** Panelden Cuma + Pazar Manila pencereleri ekledim, birini sildim; "Times are in your time zone (Asia/Manila)". Geçen turun "müsaitliğimi ben giremiyorum" bulgusu kapanmış.
7. **Strike sayacım görünür:** başlıkta "Strikes 0/3" + Earnings'te "No-show strikes 0/3". Geçen tur "strike_count hiç SELECT edilmiyor" idi.
8. **Ders zaman-penceresi gerçek.** 8 gün sonraki dersi başlatmayı denedim → "The lesson cannot be started yet — it starts in 8662 minutes (you can start at most 15 minutes early)". Penceresine 21 dk kala tekrar denedim → yine reddedildi; pencere açılınca başladı. Geçen turun "günler önce başlatıp 2 dk'da tam ücret" bulgusu kapanmış.
9. **Ders bırakma bende, cezasız.** Panelden confirmed July 25 dersimi bıraktım; onay diyaloğu dürüst ("The lesson will be re-offered... Dropping lessons frequently may reduce your future offers"); sonuç `reoffered:true`, strike **0'da kaldı** (drop ≠ strike). Başkasının dersini bırakmayı denedim — sistem doğru şekilde engelledi (kod: `teacherDropByTeacher` `WHERE teacher_id` sahiplik şartı; UI "This lesson is not assigned to you").
10. **Kayıp link self-servisi güvenli.** `/egitmen/link` İngilizce; gerçek + var olmayan e-posta ikisi de `{ok:true}` (varlık sızıntısı yok); DB'de gerçek e-postaya `teacher_portal` satırı düştü, sahte e-postaya **0 satır**; 15 dk içinde ikinci istek hiçbir şey yazmadı (rate-limit tuttu).
11. **Kısa ders otomatik ödenmedi.** 2 dk'da bitirdim → `reviewRequired:true, settled:false`; ledger'da `teacher_payable` **1600'de kaldı** (para hareket etmedi), `review_reason = "kısa ders: 2 dk (planlanan 15 dk)"`. Ders odası "Under review — payment is pending a quick review by our team" dedi. Adil ve anlaşılır.

---

## B. KRİTİK EKSİK (pilot bloker / para-güven riski)

1. **Bana ulaşan e-postaların ÜÇ tanesi HÂLÂ TÜRKÇE — üstelik hayat damarı olanlar.** `notification-dispatcher.ts` şablonlarını okudum: `teacher_invite` ("Merhaba, Teachernow eğitmen kadrosuna davetlisiniz"), `teacher_offer` ("Yeni ders teklifi — ... Teklifleri süreli") ve `teacher_portal` ("Teachernow eğitmen paneliniz") **Türkçe**. Kod bu turda `teacher_interview_scheduled` ve `teacher_slot_cancelled`'ı İngilizceye çevirmiş ve satır 194'te "Eğitmen-yüzlü şablonlar İNGİLİZCE" diye iddia ediyor — ama davet/teklif/panel e-postaları çevrilmemiş. **Manila'daki eğitmen daveti, HER teklifi ve panel linkini Türkçe alır.** E-posta bu ortamda outbox'ta `pending` beklediği için canlı gelmedi, ama açıldığı an geçen turun "tek kelime anlamam, kaybedersiniz" churn riski geri gelir. Sayfalar temiz (lang-scope=en), e-postalar değil.
2. **Ödünç aldığım hata/404 sayfaları da Türkçe.** JS chunk taramasında yakaladım, koddan doğruladım: `error.tsx` "Bir şeyler ters gitti", `global-error.tsx` "Uygulama hatası", `not-found.tsx` "Sayfa bulunamadı" — hepsi yalnız Türkçe, lang-scope dışında. Panelim çökerse ya da linki yanlış yazarsam Türkçe hata görürüm. (Not: mutlu-yol eğitmen sayfaları — davet/teklif/panel/ders — tamamen İngilizce; top-nav bu rotalarda gizli. Sızıntı yalnız e-postalar + boundary/404'te.)
3. **Teklif e-postasında ÜCRET YOK ve süre BELİRSİZ.** `teacher_offer` payload'ı okul/sınıf/süre/dilim taşıyor ama **rate yok**; metin "Teklifler süreli" diyor ama **kaç dakika yazmıyor**. Teklif 20 dk sonra ölüyor (DB: created→expires tam 19.99 dk) — Manila'da gece 03:00'te uyurken kaçırırım. E-postaya bakan eğitmen ne kazanacağını ve ne kadar zamanı olduğunu göremeden karar veremez. (Teklif SAYFASI net; sorun e-postada.)

---

## C. OTOMASYON / SELF-SERVİS BOŞLUKLARI

1. **Kısa/review dersinin akıbetini panelimden göremiyorum.** 2 dk'lık dersi bitirdim, "Under review" dedi — ama panel `getPanel` çıktısında bu ders HİÇBİR YERDE yok: "Recent lessons" yalnız settled gösteriyor, kazanç 16.00'da, "1 ders incelemede / X USD beklemede" diye tek satır yok. Verdiğim emek panelimde iz bırakmıyor; sonucu ancak o /ders linkini tekrar açarsam görebilirim.
2. **Aynı ders hem "işlendi" hem "Upcoming" görünüyor.** Review'a düşen July 12 03:05 dersim, slot `ends_at` geçene kadar panelde hâlâ "Upcoming lessons" listesinde "Join lesson →" + "Drop this lesson" ile duruyor — oysa dersi verdim, incelemede. Zaten verdiğim dersi "bırak" diyebilirim; kafa karıştırıcı ve tutarsız.
3. **Panel linkimi hâlâ kendim üretemiyorum (ilk kez).** `/egitmen/link` yalnız KAYITLI e-postaya yeni link yolluyor — iyi; ama ilk panel linkini admin `createLink` ile açmak zorunda. E-posta kapalıysa (bu ortamda `pending`) ilk linkim bana hiç ulaşmaz. Onboarding'in sonunda "panelinize buradan girin" diye bir köprü yok.

---

## D. İYİLEŞTİRMELER (bloke etmez)

1. **Ders odası rozeti yanıltıcı.** Kısa ders bitince başlıkta yeşil "Completed" rozeti + altta mavi "Under review" birlikte duruyor — ödeme beklemedeyken "Completed" demek çelişki. Rozet "Under review" ise başlık da nötr olmalı.
2. **Ödemenin NE ZAMAN geleceğinin tarihi yok.** Panel "payouts run every 2 weeks" diyor ama "sonraki ödeme tarihi Z" kutusu yok; "Earned this period 16.00 USD" var ama dönemin ne zaman kapanacağı belirsiz. (Geçen turun E5 fikri kısmen karşılanmış.)
3. **Payout satırı ders bazında değil.** "My payouts" tutar/durum/Wise-ref gösteriyor (iyi) ama hangi dersleri kapsadığını göstermiyor (`payout_line` verisi var, panele bağlı değil). Bu turda batch koşmadım — diğer test eğitmenlerinin (S5 Egitmen Iki, hazır bakiye) durumunu bozmamak için; kod + panel metni + geçen tur "paid" kanıtı yeterli.
4. **Teklif e-postasındaki 20 dk sabit TTL müsaitlik saatine göre ayarlanmıyor** (DB doğruladı: 19.99 dk). Gece uykuda kaçan teklif sıradaki eğitmene gidiyor.
5. **Ders odasında video/destek yönergesi yok** (geçen tur B4/B5) — dersi nerede işleyeceğim (Zoom/Meet?) ve sorun anında kime ulaşacağım tek cümleyle bile yazmıyor. Bu turda da eğitmen sayfalarında `mailto`/destek kanalı bulamadım.

---

## E. YENİ FİKİRLER (max 5)

1. **Panele "Incelemedeki dersler" bölümü** — review_required dersleri tutar + sebep + tahmini karar süresiyle göster; "verdim ama görünmüyor" endişesini bitirir.
2. **Teklif e-postasına ücret + kalan dakika + "Accept/Decline" derin linkleri** — sayfaya gitmeden bilgi ve tek tık.
3. **Onboarding review adımına "Panelinize gidin →" kalıcı köprüsü** (aynı davet token'ından türetilmiş) — ilk panel linki için admin'e/e-postaya bağımlılığı kırar.
4. **"Sonraki ödeme: 24 Tem, tahmini 32.00 USD" özet kutusu** panelin başına.
5. **Seri teklif ("bu sınıfın 12 Cuma dersini üstlen")** — okul 12 haftalık reçete kesiyor, bana 20'şer dakikalık tekil teklifler geliyor; tek kabulle istikrar.

---

## F. ÖNCEKİ TUR KAPANIŞLARININ DOĞRULANMASI (rolümü ilgilendiren ✅ kalemler)

- **P0.1 dispatch_ready (davetli eğitmen teklif alıyor):** DOĞRULANDI — accept sonrası `dispatchReady:true`, 5 teklif düştü.
- **P0.3 ders zaman-penceresi:** DOĞRULANDI — erken start reddedildi (8662/21 dk mesajları), kısa ders review'a düştü, para işlemedi.
- **P0.5 eğitmen yüzü İngilizce:** KISMEN — sayfalar/sözleşme/ders odası tamamen İngilizce DOĞRULANDI; ama `teacher_invite`/`teacher_offer`/`teacher_portal` E-POSTALARI + error/404 boundary'leri HÂLÂ TÜRKÇE (B1, B2).
- **P1 sözleşmeye 5 madde (ücret/2hafta Wise/<24s %50/3-strike):** DOĞRULANDI — screenshot'ta dördü de mevcut ve okunur.
- **P1 Wise hesap bilgisi tutuluyor + maskeli:** DOĞRULANDI — `••••test` → `••••6819`, method rozeti + account holder.
- **P1 teacher_slot_cancelled şablonu (EN, lateCancel bilgili):** DOĞRULANDI (kod) — İngilizce şablon mevcut; bu tur canlı iptal tetiklemedim ama metin İngilizce.
- **P1 timezone doğrulaması:** DOĞRULANDI — "Manila" ve "NotAZone" reddedildi ("invalid IANA timezone" — İngilizce).
- **P2 müsaitlik self-servis CRUD (IANA doğrulamalı):** DOĞRULANDI — ekle/sil çalıştı, Manila.
- **P2 "Drop this lesson" (yalnız kendi dersi, atomik):** DOĞRULANDI — bıraktım, reoffered, strike 0; başkasının dersi engellendi.
- **P2 strike "N/3" panelde:** DOĞRULANDI — "Strikes 0/3".
- **P2 /egitmen/link kayıp-link (varlık sızdırmaz, 15dk rate-limit):** DOĞRULANDI — sahte e-posta 0 satır, rate-limit tuttu.
- **P3 kazanç özeti / payout line item (fikir):** KISMEN — "Earned this period" var, sonraki-ödeme-tarihi ve ders-bazlı payout satırı yok.

---

## G. UI/UX DEĞERLENDİRMESİ (yeni "liquid glass" tasarım) — **7/10**

Yeni açık-tema cam tasarım masaüstünde temiz, ferah ve hiyerarşisi net: stat karoları ("Earned this period / Upcoming lessons / No-show strikes") okunaklı, rozetler (Open to offers, Payout details on file) anlaşılır, İngilizce tutarlı, ders odası ve teklif kartı sade. Onboarding adım göstergesi (✓ yeşil) iyi. Ama Manila'daki hedef kitle telefon-ağırlıklı ve orada tasarım yarım kalıyor.

**En kötü 3 nokta (ekran görüntüsü kanıtlı):**
1. **Mobilde yatay taşma (390px, viewport meta doğru → gerçek).** `shots/15-panel-mobil.png`: stat karolarının 2.'si ("Upcoming lesson…" ve Rate sütunu), müsaitlik tablosunun "Remove" düğmesi, payout satırı ("Maria Santo…"), "Recent lessons (payment processe…" başlığı sağdan kesiliyor. Yalnız tablolar `overflow-x:auto` ile kayıyor; kartlar/başlıklar gövde taşmasıyla kırpılıyor. `@media (max-width:640px)` yalnız padding/font ayarlıyor, grid/tablo düzenini değil. Telefonda ücretimi ve "Remove"ı göremiyorum.
2. **Durum tutarsızlığı:** kısa ders odasında yeşil "Completed" rozeti ile "Under review" birlikte (`shots/14-ders-review.png`); panelde ise verilmiş-ama-incelemedeki ders "Upcoming lessons"da "Join lesson"/"Drop" ile duruyor. Rozet dili gerçeği yansıtmıyor.
3. **Tek tema (dark yok).** Tüm eğitmen yüzü parlak beyaz cam; Manila'da gece 03:00 dersine "Join" ile giren eğitmen için karanlık modu yok. Küçük ama mutlu-yolun tam vaktinde (gece dersleri) hissedilir.

---

**GÜVEN MUHASEBESİ — "Emeğimi emanet eder miyim?":** Para çekirdeği ve kural netliği bu turda beni ikna etti: ücretim her adımda net ve tek yönlü gizli, zaman-penceresi & kısa-ders koruması para güvenimi sağlıyor (2 dk'lık derste para işlemedi, review'a düştü), sözleşme 5 maddeyle ne kabul ettiğimi söylüyor, Wise/IBAN maskeli tutuluyor, strike'ım görünür, müsaitlik/bırakma/kayıp-link kendi elimde. **Ama iki şey beni tereddütte bırakıyor:** (a) daveti, HER teklifi ve panel linkimi Türkçe alacağım — profili dolduramadan kaybolabilecek bir arz için bu gerçek bir bloker; (b) teklif e-postasında ücret/süre olmadan ve panelde incelemedeki dersimin izi olmadan, "param nerede" sorusuna e-posta katmanı hâlâ cevap veremiyor. **Hüküm: Ürün çekirdeği emanete değer; pilotu açmadan önce B1–B3 (eğitmen e-postalarının İngilizcesi + teklif e-postasına ücret/süre) kapatılmalı.**
