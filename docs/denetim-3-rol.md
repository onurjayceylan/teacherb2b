# Üç-Rol Denetim Raporu — Sentez (2026-07-11)

Üç bağımsız denetçi, canlı sistemde kendi rolünün yolculuğunu uçtan uca YAŞAYARAK (kayıt, sihirbaz, havale, reçete, ders, settle, payout, iptal, itiraz — gerçek kayıtlarla) denetledi. Aşağıda önceliklendirilmiş sentez; üç raporun tam metni eklerde.

## HÜKÜM
Para çekirdeği (ledger, hold, idempotency, payout hard-gate, kiracı izolasyonu, saat dilimi matematiği) üç denetçinin ortak kanaatiyle SAĞLAM ve vaadi taşıyacak kalitede. Ama sistem bugün pilota açılsa ilk hafta 5 yerde duvara çarpar. "Full otomatize" iddiası para/dispatch çekirdeğinde doğru; İLETİŞİM katmanında (kim kime neyi bildiriyor) ve self-servis yüzeylerinde değil.

## P0 — PİLOT BLOKERLERİ (birden fazla denetçi bağımsız doğruladı)
1. **dispatch_ready bug'ı:** davet+görüşme yolundan gelen eğitmen HİÇBİR ZAMAN teklif alamıyor (yalnız toplu import açıyor; görüşme-kabul açmıyor; UI'da alan yok). Organik arz kanalı ölü doğuyor. [sahip B1 + eğitmen C1] → Fix: completeInterview(accept) dispatch_ready'yi açsın + admin toggle.
2. **Worker görünmezliği:** worker hiç çalışmamışken healthz "ok" diyor; bloke slot açma, teklif timeout, backfill, SLA iadesi ve TÜM e-postalar sessizce birikiyor; kill-switch tetiklense kimseye haber gitmiyor. [sahip B2-B3 + okul B1/C4] → Fix: cron heartbeat'leri + healthz/probe FAIL + kritik alarm bildirimi.
3. **Ders zaman-penceresi yok:** planlı saatten GÜNLER önce başlatılıp 2 dakikada bitirilen ders TAM ücret settle ediyor. [eğitmen D5 + okul B7 — ikisi de canlı üretti] → Fix: start penceresi + min-süre eşiği altında settle yerine insan kuyruğu.
4. **Teklif/link iletim boşluğu:** e-posta anahtarı yokken teklif linkini gösteren HİÇBİR UI yok (tek yol psql); üç taraf da linki diğerinin ileteceğini sanıyor. [sahip B5 + eğitmen C4 + okul C3] → Fix: admin'de link görünür/kopyalanır + reissueOffer UI'a bağlanır.
5. **Eğitmen yüzü tamamen Türkçe:** hedef arz Manila'daki native ESL eğitmeni — davet, sözleşme, teklif, panel, e-postalar Türkçe. [eğitmen B1] → Fix: eğitmen-yüzü İngilizce (i18n borcunun ilk gerçek faturası).

## P1 — GÜVEN/PARA RİSKLERİ (pilot sırasında yakar)
- Sözleşme "yer tutucu" + ücret/ödeme döngüsü/strike politikası tebliğ edilmiyor; eğitmen ücretini ilk kez ilk teklifte öğreniyor [eğitmen D1-D2, B6]
- Wise hesap bilgisi sistemde tutulmuyor (payout_method serbest beyan; CSV'de yalnız ad+e-posta) [eğitmen D3]
- Dış banka mutabakatı yok (plan borcu) + chargeback webhook'u işlenmiyor + kart clearing/rezerv penceresi payout'ta uygulanmıyor [sahip B4]
- Okul iptali eğitmene, itiraz sonucu okula BİLDİRİLMİYOR; ders panelden sessizce kayboluyor [eğitmen B3 + okul B8]
- Skip-week yarım: mevcut slotu iptal etmiyor; unutulursa ceza okula yazar [okul B4]
- Yoklama okula görünmüyor — roster'ı isimle veren okul devam raporu alamıyor [okul B6]
- Timezone alanı doğrulanmıyor (bozuk IANA → panel sessizce UTC'ye düşüyor) [eğitmen D7]
- Test verileri (sahte banka hesapları, 9 platform_admin) prod'a taşınmamalı [okul B3 + sahip D6]
- hr akışında ham 500'ler (docs_pending→active tuzağı; mükerrer email constraint sızıntısı) [sahip B7 + eğitmen C5]

## P2 — SELF-SERVİS / ÖLÇEK
- Eğitmen self-servisi yok: müsaitlik, ders bırakma (teacherDrop hiçbir uca bağlı değil — strike sistemi fiilen çalıştırılamıyor), panel linki yenileme, strike görünürlüğü [eğitmen C2-C3, D4]
- Reçete düzenleme/silme yok; saat değişikliği = tek tek iptal + yeni reçete [okul B5]
- 250-sınıf ölçeği: toplu reçete/CSV yok; materializer tek-beklenmeyen-hata-tüm-gece kırılganlığı [sahip B6]
- Havale: referans kodu sonradan bulunamıyor, bekleyen-havale listesi/durumu yok, TL hesaba USD tutar kur açıklaması yok [okul B2-B3]
- /admin tek-bakış sağlık ekranı yok (bugünkü dersler, canlı dersler, bekleyen yaşları, failed payout rozeti) [sahip C]
- Metrik boşlukları: funnel SÜRESİ ölçülmüyor (<15dk hedefi ölçülemiyor), repeat-topup oran değil adet, dosaj slot-bazlı (dakika değil) [sahip D2]
- Ekstre indirilemez (PDF/CSV yok) ve satırlar ders-bazlı değil; sınıf katılım sayfası saati UTC gösteriyor [okul D5, D8-9]
- Yoklamada herkes baştan "geldi" işaretli — dokunulmazsa tam katılım görünür [okul D10]

## P3 — DEĞERLİ YENİ FİKİRLER (denetçilerden)
Sahibe günlük "sabah kahvesi" özet e-postası · eğitmen müsaitlik self-servisi · reçete şablonu/çoğaltma ("N sınıfa uygula") · seri teklif ("dönemin 12 dersini üstlen") · ICS takvim aboneliği · okul-yüzü eğitmen profili/vetting rozeti · "eğitmen değişimi talep et" · dekont fotoğrafı yükleme · okul sağlık skoru (churn erken uyarısı) · teklif e-postasına süre+ücret · kazanç özeti kutusu ("bu dönem X ders → Y USD, ödeme tarihi Z").

---

# EK 1 — PLATFORM SAHİBİ RAPORU (tam metin)

Denetim tamamlandı. Tüm kanıtlar toplandı; canlı sistemde veri güvenliği korundu (payments_frozen=false, Sihirbaz Koleji havalesi dokunulmadı, tüm test verim DENETIM- önekli). İşte sahip gözüyle rapor:

---

# TEACHERNOW SAHİP DENETİM RAPORU — 11.07.2026

**Yöntem:** `sahip-denetim@test.com` platform_admin hesabıyla canlı sistemde (localhost:3010) tüm admin uçları tRPC'den çağrıldı; eğitmen arz akışı uçtan uca DENETIM- verisiyle yürütüldü; `apps/worker`, `apps/web/src/server/routers`, `packages/modules`, `packages/db/migrations` ve `docs/plan` + `docs/pilot-runbook.md` kodu okundu.

## A. ÇALIŞAN VE YETERLİ

- **Para çekirdeği sağlam.** Çift kayıt defter, append-only trigger'lar, slot başına hold ("ders verildi para yok" imkânsız), idempotent Stripe webhook, iki fazlı Wise payout ("Wise'a yükledim" demek para işlemez — yalnız sonuç CSV'si işler, `packages/modules/payouts/src/batches.ts` + `results.ts`), çift ödeme yapısal engelli. Canlı doğrulandı.
- **Payout hard-gate çalışıyor.** 5 evrak verified → `payout_ready` DB trigger'ı otomatik açıldı (canlı test: DENETIM eğitmenim `payout_ready=t` oldu); bakiyesi olup evrakı eksik eğitmen batch'te "held" listesinde görünüyor.
- **"Param nerede" tek kaynaktan cevaplı.** Eğitmen paneli (`/egitmen/panel/<token>`) ödeme geçmişini durum + hata sebebi + Wise referansıyla gösteriyor; admin tarafında `payouts.listRecent` aynı veriyi veriyor (canlı: "failed / IBAN gecersiz" ve "paid / TW-123" doğru göründü).
- **Kill-switch mekaniği doğru.** `payments_frozen` tek SQL kapısında (`post_ledger_txn` ilk satırda kontrol, `0002_ledger.sql`); donunca TÜM para yazımı durur, /admin'de gösterge + toggle var.
- **Çok kiracılılık/RLS, davet-token hijyeni (DB'de hash), PII maskeleme (öğrenci "Ad S.", e-posta maskesi), audit_log** — hepsi yerinde ve disiplinli.
- **İK akışı uçtan uca çalışıyor:** davet → token'lı onboarding (profil/sözleşme/evrak beyanı) → görüşme → kabul+havuz → aktivasyon — canlı yürüttüm, çalıştı (bir tuzak hariç, bkz. B6).

## B. KRİTİK EKSİK (pilot bloker / para-güven riski)

1. **Davetle gelen eğitmen ASLA derse çıkamıyor.** `dispatch_ready`'yi true yapan tek kod yolu toplu import (`pipeline.ts:79`, varsayılan true); site davet + görüşme + evrak yolunda hiçbir uç/UI bunu açmıyor, matcher ise `t.dispatch_ready` şart koşuyor (`matcher.ts:48`). Canlı kanıt: DENETIM eğitmenim active + payout_ready ama `dispatch_ready=f`. **Sonuç: organik arz kanalı ölü doğuyor.** Öneri: `completeInterview(accept)` dispatch_ready'yi açsın + /admin/egitmenler'de manuel toggle.
2. **Kill-switch tetiklenirse BANA HABER GELMİYOR.** Sentinel donma anında yalnız `system_flag` + `audit_log` + worker stderr'e tek satır yazıyor (`apps/worker/src/index.ts:35-39`); Slack/e-posta/SMS yok, outbox'a bile düşmüyor. Tatildeysem parayı donduran sistemi ancak okullar arayınca öğrenirim. Öneri: sentinel CRITICAL'de outbox'a "platform_alert" + Slack webhook (yarım günlük iş).
3. **Worker ölürse kimse fark etmiyor — bu ortamda ZATEN ÖLÜ.** Kanıt: DB'de pg-boss `queue` şeması hiç oluşmamış (worker hiç başlamamış), buna rağmen `/api/healthz` `{"ok":true}` dönüyor ve outbox'ta 6 e-posta (3'ü ders teklifi!) sonsuza dek bekliyor. Heartbeat/dead-man switch yok; sentetik prob (`tools/synthetic-probe.mjs`) yalnız web'i yokluyor. Öneri: her cron son-koşum zamanını `system_flag`'e yazsın, healthz + prob "materializer >26 saattir koşmadı" durumunda FAIL versin.
4. **Dış banka mutabakatı YOK — plan borcu.** Plan açıkça vaat ediyor ("günlük bir iş de iç defteri Stripe/Wise/banka gerçeğiyle karşılaştırır", `07-plan-final-duz-yazi.md`); kodda hiçbir yerde Stripe/Wise API'sinden bakiye/transfer çekilip ledger'la kıyaslanmıyor. "payout-reconciler" yalnız iç tabloda 1 saatten uzun `submitted` kalanı işaretliyor. Defter yalnız kendi kendisiyle mutabık. Ayrıca **chargeback/refund webhook'u hiç işlenmiyor** (yalnız `checkout.session.*`) ve plandaki kart-clearing penceresi/rezerv oranı payout batch'inde yok — kartla yüklenen para ertesi gün eğitmene çıkabilir, chargeback gelirse delik açılır.
5. **E-posta hattı fiilen kapalı ve prod planında da kapalı.** `resendConfigured:false` (canlı doğrulandı); `render.yaml` worker'ına RESEND_API_KEY / BASE_URL / MAIL_FROM hiç tanımlanmamış. Runbook "e-posta yokken teklif linkini eğitmene ilet" diyor ama **bu linki gösteren hiçbir UI yok**: `admin.reissueOffer` UI'a bağlanmamış, `listNotifications` payload'ı (token'ı) bilerek gizliyor. Bugün bir teklifi eğitmene ulaştırmanın tek yolu psql. Pilot birinci gün burada takılır.
6. **250 sınıf = 250 elle reçete + gece işi kırılgan.** Toplu reçete/CSV yok (`schedule.createPlan` tek form, tek sınıf); 3.000 öğrencili MEV senaryosunda okul 250 form dolduracak. Materializer 250 plan × 4 hafta ≈ 1.000 occurrence'ı **tek bağlantıdan sıralı, occurrence başına ayrı transaction** ile işliyor; beklenmeyen tek hata (yalnız 23514/P0001 yakalanıyor, `materializer.ts:164`) o gecenin kalan TÜM işini iptal ediyor; pg-boss retry/timeout ayarı yok. Öneri: reçete CSV importu + materializer'da plan-başına try/catch + batching.
7. **Görüşme akışında durum-makinesi tuzağı (canlı yakalandı):** eğitmen evraklarını görüşme kararından önce beyan ederse `completeInterview(accept)` ham 500 veriyor: `"teacher: geçersiz durum geçişi docs_pending → active"`. Doğal akış (evrak önce biter) admin'i bozuk hataya düşürüyor; `hr.invite` mükerrer e-postada da ham `duplicate key value violates unique constraint "teacher_email_key"` sızdırıyor.

## C. OTOMASYON BOŞLUKLARI (bugün insan isteyen noktalar)

Günüm bugün şöyle geçer: /admin'de bekleyen havaleyi settle et (Sihirbaz Koleji $500 sabah 02:11'den beri bekliyor — **bekleme süresi uyarısı yok**), itiraz varsa karar ver, 2 haftada bir Wise CSV döngüsü, evrak doğrula, görüşme yap, müsaitlik gir. **Göremediklerim: bugün kaç ders var, şu an hangi ders canlı, hangi okulun bakiyesi bitmek üzere, başarısız payout var mı — hiçbiri /admin'de yok; tek-bakış sağlık ekranı yok.**

| İnsan işi | Bilinçli mi? |
|---|---|
| İK görüşmesi | ✔ Bilinçli (planın tek zorunlu insan adımı) |
| Havale eşleştirme/settle | ✔ Bilinçli yarı-otomatik — ama SLA göstergesi eksik |
| Wise CSV dışa/içe aktarma | ✔ Bilinçli (pilot ölçeği) |
| İtiraz kararı | ✔ Bilinçli (pilotta kurucu) |
| Evrak doğrulama (5/eğitmen) | ✔ Bilinçli — ama Persona vaadi kodda yok, 100 eğitmende 500 tık |
| **Müsaitlik girişi tamamen admin'de** | ✖ Portal read-only; plan "eğitmenleri dürt" diyordu, dürtecek e-posta da yok |
| **Teklif linkini eğitmene iletme** | ✖ Plan dışı doğan iş: e-posta kapalı + UI yok → psql |
| **Worker'ı gözlemek** | ✖ Tamamen gözsüz (B3) |
| **Dış mutabakat** | ✖ Plan "günlük otomatik" diyordu — kod yok, insan yapsa bile ekran yok |
| 250 reçete girişi | ✖ Okula yıkılmış concierge işi (B6) |

**Tatildeyken:** dersler ve settle otomatik döner (worker ayaktaysa — bunu bilemem, B3); havale settle, itiraz, yeni eğitmen aktivasyonu, Wise ödemesi ve donan sistemi çözme tamamen durur. Kill-switch tetiklenirse dönene kadar kimse ödeme alamaz ve kimseye haber gitmez.

## D. İYİLEŞTİRMELER (bloke etmez)

1. `/admin/egitmenler`'e arama + sayfalama: `hr.pipeline` LIMIT'siz tüm tabloyu çekiyor; 200 eğitmende ekran hantallaşır (status filtresi var, o iyi).
2. `/admin/metrikler` go/no-go için 3 eksik: dosaj gerçekleşme **dakika-bazlı sözleşmesel dosaj** değil slot-realization oranı; repeat top-up **oran değil adet** (≥%60 hedefi ölçülemiyor, canlıda `repeatTopupSchools: 0` çıplak sayı); **<15dk funnel süresi hiç ölçülmüyor** (funnel yalnız adım sayıyor, süre tutmuyor). Ayrıca ufak sinyal: 2 settled ders + 1 itirazla `disputeRate: 0.5` gösteriyor — küçük örneklemde eşik boyaması yanıltıcı.
3. /admin ana paneline: bugünkü ders sayısı/canlı dersler, bekleyen havale yaşı, başarısız payout rozeti, düşük bakiyeli okul listesi, worker son-koşum zamanı.
4. Hata mesajı hijyeni: ham PG hatalarını TRPCError'a çevir (B7'deki iki örnek).
5. Outbox `failed` satırları için görünür kuyruk + yeniden dene butonu (şu an 5 denemeden sonra sessizce ölüyor, 7 günde expire).
6. platform_admin tablosunda 9 kayıt var (smoke testleri); prod öncesi temizlik + admin ekleme/çıkarma UI'ı.

## E. YENİ FİKİRLER (max 5)

1. **"Sabah kahvesi" günlük özet e-postası** sahibe: dün kaç ders/settle, bekleyen havale-itiraz-evrak sayısı, worker son koşumları, bugünkü ders programı — outbox altyapısı hazır, tek şablon işi; B2+B3+C'nin yarısını tek hamlede kapatır.
2. **Eğitmen panelinden müsaitlik self-servis:** portal token altyapısı zaten var; read-only paneli yazılabilir yapmak arz yönetiminin en pahalı insan işini (müsaitlik tazeleme) sıfırlar.
3. **Reçete şablonu/çoğaltma:** "bu reçeteyi N sınıfa uygula" — tam CSV importundan bile önce, 250-sınıf problemini %90 çözer.
4. **Havale dekont fotoğrafı yükleme:** okul dekontu yüklesin, settle ekranında yan yana görün — eşleştirme hatası ve "gönderdik ama görünmüyor" destek trafiği düşer.
5. **Aylık "okul sağlık skoru":** dosaj gerçekleşme + bakiye runway + itiraz oranı tek satırda okul başına — pilotta hangi okulun churn edeceğini ben hissetmeden sistem söylesin.

**Özet hüküm:** Para çekirdeği ve kiracı izolasyonu bir kişilik operasyon vaadini taşıyacak kalitede. Ama bugün pilotu açsam üç yerde ilk hafta duvara çarparım: davetli eğitmen derse çıkamaz (B1), eğitmene teklif ulaştıramam (B5), ve sistemin en kritik bekçileri (worker + kill-switch alarmı + dış mutabakat) "sessiz" — bu denetim sırasında worker'ın hiç çalışmamış olduğunu healthz'in "ok" demesine rağmen ancak DB'ye bakarak anlayabildim. Önce B1–B5, sonra pilot.
# EK 2 — OKUL ZÜMRE BAŞKANI RAPORU (tam metin)

Denetim tamamlandı. İşte MEV Koleji İngilizce Zümre Başkanı gözüyle uçtan uca kullanım raporum.

---

# TEACHERNOW DENETİM RAPORU — MEV Koleji İngilizce Zümresi

**Denetim kapsamı:** Kayıt → /baslangic sihirbazı (4 adım) → havale + settle → 12 öğrencilik sınıf importu → 2 reçete → iptal/atlama/itiraz akışları → /okul, /okul/program, /okul/ekstre, /okul/siniflar. Denetim verileri "DENETIM-MEV" önekiyle oluşturuldu (okul: DENETIM-MEV Koleji, sınıf: DENETIM-MEV 7A, kullanıcı: zumre-denetim@mev.test). **Not:** Havale onayı ve itiraz kararı, okulun YAPAMADIĞI adımlardır — bunları 'zumre-admin-yardimci@test.com' kullanıcısını psql ile platform_admin yaparak ben simüle ettim (gerçekte Teachernow personelinin işi).

**Süre:** Kayıttan "Hazırsınız!" ekranına ~7 dakikada geldim; acele etmeyen bir zümre başkanı için 10-12 dk gerçekçi. **<15 dk vaadi kâğıt üstünde tutuyor — ama** bitiş ekranım şöyleydi: "0 ders planlandı — 4 ders bakiye yetersizliğinden bloke (bakiye yüklenince otomatik denenir)". Yani 15 dakikada reçetem oldu, dersim olmadı (ayrıntı B1).

## A. SORUNSUZ VE ANLAŞILIR OLANLAR

1. **Sihirbaz akışı** (/baslangic): 4 adım tek sayfada, adım göstergesi net, her adım tek form. Okul kurma 1 dakika sürdü.
2. **Öğrenci importu**: "Ad Soyad;Sınıf" formatı basit, sınıf otomatik açılıyor, 12 öğrenci tek yapıştırmada girdi; bozuk satırlar satır numarasıyla bildiriliyor.
3. **Veri minimizasyonu güvencesi** (sihirbaz 3. adım ve /okul/siniflar): "yalnız ad-soyad girin; doğum tarihi, T.C. kimlik no, telefon, e-posta veya veli iletişim bilgisi GİRMEYİN. Bu alanlar toplanmaz ve saklanmaz." — Öğrenci verisi teslim eden bir okul için tam yerinde. Ayrıca eğitmen tarafında öğrenci adlarının maskeli gittiğini doğruladım ("Ayşe Y.", "Ali Ç.") — takdir ettim.
4. **İptal politikası iptalden ÖNCE net uyarıyor** (/okul/program): 24 saatten uzaksa "iptal ücretsizdir, tutar cüzdanınıza tam iade edilir", kısaysa "DİKKAT: Derse 24 saatten az kaldı. İptal ederseniz tutarın yalnız %50'si iade edilir." İkisini de denedim; ekstrede birebir doğru işledi (+40 tam iade, +20 yarım iade).
5. **Reçete maliyet önizlemesi**: kaydetmeden önce "Haftada 1 ders × 4 hafta ≈ 520.00 USD (130.00 USD / ders)" gösteriliyor.
6. **Slot durum rozetleri** okunur: "planlandı / bakiye yetersiz / iptal (tam iade) / iptal (%50 kesinti) / tamamlandı (ödendi) · 2 dk".
7. **Ekstrede rezerv tanımı** tek cümleyle var: "planlanan derslerin ücretleri ders yapılana (ya da iptal edilene) kadar bakiyenizden ayrılır" — bu cümleyi anladım.
8. /admin, okul kullanıcısına düzgün kapalı ("platform yöneticisi yetkisi gerekli").

## B. BENİ DURDURAN EKSİKLER

1. **Bakiyem onaylandı, bloke derslerim asla açılmadı.** Havale settle edildi, /okul'da 500.00 USD göründü; ama 4 bloke ders "bakiye yetersiz"de kaldı. Sihirbaz "bakiye yüklenince otomatik denenir" demişti; sayfada "yeniden dene" düğmesi yok. Kodda gördüm: bunu gece 02:00'de bir arka plan görevi yapıyor ve **bu sunucuda o görevleri çalıştıran worker süreci hiç çalışmıyor** (yalnız next-server ayakta). Yani bu kurulumda bloke ders, teklif zaman aşımı, eğitmen backfill, SLA iadesi ve TÜM e-postalar sonsuza dek bekler. → Öneri: settle anında tetikleme + programda "şimdi dene" düğmesi + worker sağlık kontrolü.
2. **Havale referans kodum bir daha bulunamıyor.** Sihirbazdan çıktım; TN-D988EF93 kodunu not almasaydım hiçbir ekranda göremezdim — /okul'da "bekleyen havaleler" listesi yok. Muhasebeye "açıklamaya ne yazayım?" diye sorulduğunda cevabım ekran görüntüsü. Ayrıca havalenin onaylanıp onaylanmadığını da göremiyorum; bakiyeyi yenileyip tahmin ediyorum.
3. **Para göndereceğim ekranda sahte hesaplar listeleniyor** (sihirbaz 2. adım ve /okul): "Smoke USD — Teachernow Inc — US00SMOKE0000000001 — Smoke Bank" diye İKİ test hesabı, gerçek Ziraat TL hesabının yanında duruyor. Hangi hesaba göndereceğim belirsiz; okul müdürüne bu ekranı gösteremem. Üstelik tutar USD isteniyor ama hesap TL — hangi kurdan, kim hesaplayacak, tek satır açıklama yok.
4. **Sınav haftası atlama yarım çalışıyor.** 2026-07-26 için "Haftayı atla" dedim; cevap: "Atlama haftası kaydedildi — o hafta zaten oluşmuş — slotu ayrıca iptal edin." Ders takvimde aynen durdu. Yani sınav haftasını atlamak = iki ayrı işlem; ikincisini unutursam ders "yapılmadı"ya düşer, geç kalırsam %50 kesinti bana yazar. → Atlama, o haftanın mevcut slotunu da ücretsiz iptal etmeli (tek onayla).
5. **Ders saatini değiştiremiyorum, yanlış reçeteyi silemiyorum.** Yanlışlıkla 130 USD'lik "Admission Strategist" reçetesi açtım (speaking club sanmıştım — açılır listede ilk oydu). Düzeltme yolu yok: reçete düzenleme/silme yok, yalnız "Duraklat". O satır artık panelimde sonsuza dek "0/4, 4 bloke, duraklatıldı" olarak duracak. Saat değişikliği için resmi yol: tüm slotları tek tek iptal et + yeni reçete aç.
6. **Yoklama okula hiç görünmüyor.** 12 öğrencimin adını sisteme verdim, eğitmen yoklama aldı — ama /okul tarafında hangi öğrencinin derse katıldığını gösteren TEK BİR ekran yok (kod düzeyinde de doğruladım: okul-yüzü uçlarda yoklama verisi yok). Ben yalnız "tamamlandı (ödendi) · 2 dk" görüyorum. Müdüriyete "kaç öğrenci katıldı" raporu veremem — o zaman roster'ı isimle niye verdim?
7. **45 dakikalık ders 2 dakika sürdü, tam ücret çekildi — üstelik ders gününden 8 gün önce.** Eğitmen linkiyle, 19 Temmuz'a planlı dersi 11 Temmuz'da başlatabildim, 2 dakika sonra bitirdim; sistem "tamamlandı (ödendi) · 2 dk" yazdı ve 40 USD'nin tamamını düştü. Ders saati penceresi kontrolü yok. Okul olarak tek çarem itiraz etmek.
8. **İtirazımın akıbeti görünmüyor.** "İtiraz et" dedim (tek satırlık bir soru kutusu açıldı), "platform ekibi inceleyip sonucu bildirecek" dendi. Karar verildi ve iade geldi — ama bana hiçbir şey "bildirilmedi": ekstrede yalnız anonim bir "Yükleme/İade +40.00" satırı belirdi, slot hâlâ "tamamlandı (ödendi)" ve "İtiraz et" düğmesi hâlâ orada. İtirazım kabul mü edildi, hangi derse iade geldi — hiçbir yerde yazmıyor.
9. **Eğitmen derse gelmezse yapabileceğim hiçbir şey yok.** "Eğitmen gelmedi" bildirme düğmesi yok; itiraz yalnız ödenmiş (settled) derslerde açılabiliyor — hiç başlamayan derste açamıyorum. SLA iadesi de yine çalışmayan worker'a emanet.
10. **"Eğitmen aranıyor" bir kara kutu.** İlk dersim hiç teklif almadı, ekranda süresiz "eğitmen aranıyor" yazdı; diğerleri "teklif bekliyor"da kaldı. Teklifin 20 dakikada zaman aşımına düştüğünü ve sıradaki eğitmene geçişin yine worker'a bağlı olduğunu koddan öğrendim — ekranda ne bir süre, ne "bulunamazsa ne olur", ne de arayacağım bir kişi var.

## C. OTOMATİK SANDIĞIM AMA İNSAN İSTEYENLER

1. **Havale onayı** → Teachernow personeli elle "settle" ediyor (admin panel). Okul tarafında "onay bekliyor" der ama ne kadar bekleyeceğim, kim onaylayacak yazmaz. (Bu adımı denetimde admin-yardımcı kullanıcıyla ben yaptım — okul asla yapamaz.)
2. **İtiraz kararı** → insan; admin panelde "karar Faz-1'de insanda" notu bile var — ama okul yüzünde bu beklenti hiç yönetilmiyor.
3. **Katılım linklerinin dağıtımı** → BEN. Program sayfası "kopyalayıp eğitmene/sınıfa iletin" diyor — eğitmenin kendi linkini bile okulun mu ileteceği belirsiz; eğitmenin teklif kabul ekranı ise "Ders detayları için Teachernow ekibi sizinle iletişimde olacak" diyor. Üç taraf da diğerinin yapacağını sanıyor.
4. **Bloke ders açma / teklif yenileme / e-posta gönderimi** → insan değil ama "hemen" de değil: gece 02:00 ve 5-10 dk'lık cron görevleri; bu kurulumda hiç çalışmıyor (B1). Tüm e-postalar outbox tablosunda "pending" birikmiş durumda.

## D. KÜÇÜK AMA SİNİR BOZUCULAR

1. Ana sayfa (/) bana hiçbir şey satmıyor — direkt login formu. Ders havuzlarını ve fiyatları görmek için kayıt olmak zorunda kaldım. Sayfa meta açıklaması "S1 kabuğu" (geliştirici jargonu).
2. Menüde herkese açık "Admin" linki duruyor; okul kullanıcısı tıklayınca yetki hatası alıyor.
3. /okul'da ham teknik metin: "Kart ödemesi henüz yapılandırılmadı (STRIPE_SECRET_KEY tanımlı değil)."
4. Reçete tablosunda "2026-07-12 +4h" — "4 hafta"nın "h" ile kısaltılması saat gibi okunuyor; "Slot 0/4" başlığı açıklamasız.
5. **Sınıf katılım sayfası ders saatini UTC gösteriyor**: "Planlanan başlangıç: 19.07.2026 07:00:00" — ders okul saatiyle 10:00'da. Projeksiyonu açan öğretmen yanlış saate bakar.
6. Katılım linkinde kopyala düğmesi yok (uzun URL'yi elle seçiyorum); sayfada 12 öğrencinin nasıl gireceği (tek link, projeksiyon?) hiç anlatılmıyor.
7. İptal edilmiş derste bile "Eğitmen: eğitmen aranıyor" yazıyor.
8. Ekstre satırları anonim: "Ders/Kesinti -40.00 USD" — hangi ders, hangi sınıf, hangi tarih yok; geç iptal cezam ayrı bir "kesinti" satırı olarak değil "Yükleme/İade +20.00" olarak görünüyor; havale satırında referans kodu yok. "Rezerv net değişimi +80.00" ifadesindeki işaret yönü kafa karıştırıyor.
9. **Ekstrenin yazdırılabilir/indirilebilir hali yok** (PDF/CSV/yazdır düğmesi yok) — ay sonu müdüriyet raporunu ekran görüntüsüyle vermek zorundayım.
10. Yoklamada tüm öğrenciler baştan "geldi" işaretli geliyor; eğitmen hiç dokunmadan kaydederse sınıfın tamamı katılmış görünür.
11. "Reçete/dosaj" metaforu okul insanına yabancı — "İlk reçete" adımını ilk gördüğümde revir modülü sandım. Runway cümlesi "yaklaşık 24 hafta taahhüt karşılanıyor" — hesabı belirsiz.

## E. KEŞKE OLSAYDI DEDİKLERİM

1. **Okul tarafına bildirim**: eğitmen atandı / ders iptal / itiraz sonuçlandı / havale onaylandı / bakiye azaldı e-postaları. Bugün şablon listesinde okula giden yalnız iki e-posta var (SLA iadesi ve düşük bakiye) — gerisi için sürekli siteye girip bakmam gerekiyor.
2. **Eğitmen profili/vetting rozeti**: Derse giren "S5 Egitmen Bir" kim? Özgeçmiş, sertifika, "Teachernow onaylı" rozeti okul yüzünde yok — çocuklarımın karşısına çıkan kişi hakkında tek bilgim adı.
3. **"Eğitmen değişimi talep et" düğmesi** — memnun kalmazsam bugünkü tek yolum ders ders iptal etmek.
4. **Ders bazlı açıklamalı, indirilebilir aylık ekstre** (PDF/CSV).
5. **Takvim görünümü / ICS aboneliği + öğrenci bazlı devam raporu** (hangi öğrenci kaç derse katıldı).

**Ekran kanıtları:** 24 tam sayfa ekran görüntüsü scratchpad'de duruyor (01-landing.png … 24-siniflar.png). Denetim verileri DB'de "DENETIM-MEV" önekiyle ayrıştırılabilir; koda, ödeme donduruculara ve sunucuya dokunulmadı.
# EK 3 — ESL EĞİTMENİ RAPORU (tam metin)

The audit is complete. I have everything I need — all flows lived end-to-end, timezone math verified with numbers, and the state left intact (server running, payments_frozen untouched, other teachers' payouts unmodified). Here is the report.

---

# TEACHERNOW EĞİTMEN DENETİM RAPORU
**Persona:** "DENETIM-ESL Öğretmen" — Manila'da yaşayan native ESL eğitmeni (Asia/Manila, UTC+8)
**Yaşanan akış:** davet → onboarding → evrak → teklif (kabul + red) → ders (başlat/yoklama/bitir) → settle → payout (paid) → okul iptali. Tümü canlı sistemde (localhost:3010) gerçek kayıtlarla yaşandı.

---

## A. İYİ ÇALIŞANLAR (bana güven verenler)

1. **Saat dilimi matematiği DOĞRU.** Sayılarla doğruladım:
   - DB'de slot `2026-07-11 10:35:00+00` (UTC) → teklif sayfası "11 Temmuz 2026 Cumartesi **18:35** (Asia/Manila saatiyle)". 10:35+8=18:35 ✓
   - DB'de `2026-07-17 12:00:00+00` → "17 Temmuz 2026 Cuma **20:00**" ✓ (12+8=20)
   - Panelde settle olan ders `10:29 UTC` → "11 Tem 2026 **18:29**" ✓
   Teklif, panel ve ders odası saatleri hep BENİM dilimimde ve "(Asia/Manila saatiyle)" etiketiyle geliyor.
2. **Ücretim teklifte net:** `/egitmen/teklif/<token>` sayfası okul adı, sınıf adı, ders türü, süre (45 dk) ve "Ücretiniz **16.00 USD**" gösteriyor. Okulun ödediği fiyat bana hiç sızmıyor (API'den de dönmüyor — doğru gizlilik hattı).
3. **Ders odası ücretimi tekrar gösteriyor** ("ücretiniz 16.00 USD") ve para dersi bitirdiğim anda gerçekten işledi: `teacher_payable` 0 → 1600 cent, panelde anında göründü.
4. **Panel para izi tutarlı:** "Son dersler" tablosunda hangi dersten ne kazandığım tek tek var (DENETIM-ESL 7A, 1 dk, 16.00 USD). Payout satırında durum rozetleri ("ödendi"), Wise referansı (WISE-DENETIM-001) ve "Başarısız ödemelerde alacağınız korunur — devreder" güvencesi var.
5. **Reddetmek cezasız ve sayfa bunu söylüyor:** Teklifi reddettim → strike_count 0 kaldı, sayfa "Sorun değil — müsaitliğinize uyan yeni dersler için tekrar teklif alacaksınız" dedi.
6. **Davet linkim kalıcı ilerleme tutuyor:** 14 gün geçerli; aktifleştikten sonra tekrar açtım, 5 evrakım "Doğrulandı" rozetiyle görünüyor. Onboarding'de yarım kalırsam kaldığım yerden devam edebiliyorum.
7. **Ders akışı basit ve idempotent:** /join → 302 → /ders; başlat → maskeli yoklama (upsert, düzeltilebilir) → bitir. Çift tıklama para hareketini tekrarlayamıyor (idempotency anahtarları DB'de).

---

## B. BENİ KAYBETTİRECEK EKSİKLER (eğitmen churn'ü)

1. **Bütün eğitmen yüzü TÜRKÇE — ben native ESL eğitmeniyim, Türkçe bilmiyorum.** Davet sayfası "Hoş geldiniz", telefon placeholder'ı "+90 5xx", ülke "TR", saat dilimi "Europe/Istanbul"; sözleşme metni Türkçe; teklif e-postası şablonu Türkçe ("Basit Türkçe şablonlar" — notification-dispatcher.ts); tarih formatı `tr-TR` ("11 Temmuz Cumartesi"). **Manila'daki hedef kitleniz bu sayfaların tek kelimesini anlamaz.** Daha profili dolduramadan kaybederim. → İngilizce (en azından) dil seçeneği şart.
2. **Teklif 20 DAKİKADA ölüyor ve bana ulaşan tek kanal e-posta.** `offer_expires_at - created_at` = tam 20 dk (10:25:09 → 10:45:09). Gece 03:00'te (Manila) gelen teklifi uyurken kaçırırım; ders "sıradaki eğitmene" gider. E-posta şablonu "Teklifler süreli" diyor ama **kaç dakika olduğunu yazmıyor**; ÜCRETİ de yazmıyor. → TTL'i müsaitlik saatine göre ayarlayın, e-postaya süre+ücret koyun.
3. **Okul dersimi iptal edince BANA HİÇBİR ŞEY SÖYLENMİYOR.** Canlı test: 24 Tem 20:00 dersimi kabul ettim (panelimde göründü) → okul iptal etti → ders panelimden **sessizce yok oldu**; outbox'a benim için tek kayıt bile düşmedi (okula SLA e-postası var, eğitmene şablon YOK). Takvimimi o derse göre kurmuştum. <24s iptalde yarım ücret alıyorum ama bunu da kimse söylemiyor. → `teacher_slot_cancelled` şablonu + panelde "iptal edilen dersler" bölümü.
4. **Ders odasında VİDEO YOK ve sayfa ne olacağını hiç söylemiyor.** /ders sayfası yalnız yoklama + başlat/bitir. Dersi NEREDE işleyeceğim (Zoom? Meet? platform içi?) hakkında tek cümle yok, placeholder bile yok. İlk dersimde öğrenciler nerede diye panikleyeceğim an bu. → En azından "video bağlantısı okul tarafından sağlanır / şu linkte" açıklaması.
5. **Sorun anında ne yapacağım yazmıyor.** Öğrenciler gelmezse, teknik arıza olursa, yanlışlıkla "Dersi bitir"e basarsam? Sayfada ne bir yönerge ne bir destek kanalı var. Tüm eğitmen sayfalarında `mailto`/destek adresi araması: **sıfır sonuç**. Panel hata sayfası "Teachernow ekibine ulaşın" diyor ama NASIL ulaşacağımı söylemiyor.
6. **Onboarding sırasında ÜCRETİMİ HİÇ ÖĞRENMİYORUM.** Profil → sözleşme → evrak → "İnceleme" bitti; hiçbir adımda "$16/ders" görmedim. Ücretimi ilk kez **ilk teklif geldiğinde** öğreniyorum — işe alım sürecinde pazarlık/karar şansım yok. Havuz-ücret kartı görüşmede belirleniyor ama bana tebliğ edilmiyor.

---

## C. OTOMASYON / SELF-SERVİS BOŞLUKLARI (admin'e muhtaç kaldığım yerler)

1. **KRİTİK BUG: Davet yoluyla gelen eğitmen HİÇBİR ZAMAN teklif alamıyor.** `dispatch_ready` DB default'u `false` (migration 0005:30); davet+görüşme-kabul yolunda bunu `true` yapan **hiçbir kod yok** (yalnız toplu import setliyor; `grep dispatch_ready` — admin/hr router'da sıfır referans). Canlı kanıt: tüm evraklarım verified + görüşme accept + havuz üyesi + müsaitlik varken okul reçete oluşturdu → **2 slot yaratıldı, 0 teklif**. Ancak ben `psql` ile elle flip edince teklif düştü. Tam onboard olmuş eğitmen sessizce raflarda çürür ve nedenini kimse göremez — UI'da bu alan hiç yok.
2. **Müsaitliğimi BEN giremiyorum/güncelleyemiyorum.** `admin.addAvailability` yalnız `platformProcedure`. Onboarding'de müsaitlik adımı bile yok; panelde görüntüleme dahi yok. Manila'da hastanede olsam pencerelerimi kapatamam.
3. **Hastalanırsam dersi BEN bırakamıyorum.** `teacherDrop` modülde yazılmış ama **hiçbir tRPC ucuna bağlanmamış** (apps/web/src/server'da sıfır referans) — panelde buton yok, admin panelinde bile yok. Bugün dersi bırakmanın tek yolu birinin veritabanına girmesi. `teacherNoShow` (strike mekanizması) da aynı durumda — yani strike sistemi de fiilen çalıştırılamıyor.
4. **Panel linkimi kendim alamıyorum:** `teacherPortal.createLink` admin-only; admin unutursa panelim yok. (Davet e-postası da bu ortamda outbox'ta `pending` bekliyordu — dispatcher/e-posta anahtarı yoksa linkler bana hiç ulaşmaz.)
5. **Admin akışı da kırılgan (beni geciktirir):** `hr.completeInterview` doğrudan çağrılınca ham 500 döndü: `"teacher: geçersiz durum geçişi docs_pending → active"` — admin'in önce gizli bir `advanceStatus(interview)` çağırması gerektiğini bilmesi lazım. Görüşme planlandığında bana e-posta şablonu da yok (outbox'a hiçbir kayıt düşmedi) — **görüşmenin ne zaman/nasıl olacağını hiçbir kanaldan öğrenmiyorum.**

---

## D. GÜVEN / ŞEFFAFLIK SORUNLARI (para + sözleşme + strike)

1. **Sözleşme beni korumuyor ve ücretimi söylemiyor.** Clickwrap metni kendini "YER TUTUCU" ilan ediyor ("pilot dönem yer tutucusudur; nihai metin hukuk onayıyla güncellenecektir"). Ücret maddesi: "Ders başına ücret, evrak seti doğrulanmadan ödeme yapılmaz" — **tutar yok, para birimi yok, ödeme döngüsü yok, iptal/yarım-ücret matrisi yok, strike/süspansiyon politikası yok.** Adımı yazıp neyi kabul ettiğimi bilmiyorum; sonradan değişecek bir metne imza atmışım.
2. **Ödemenin NE ZAMAN geleceği hiçbir yerde yazmıyor.** Panel "ödemeler dönemsel olarak hazırlanır" diyor — 2 haftalık döngü bana hiçbir yerde tebliğ edilmemiş. Bakiyem 16.00 USD'yken bunun bu ay mı, gelecek yıl mı ödeneceğini bilmiyorum.
3. **Wise hesabımı NEREYE bildireceğim belli değil.** "payout_method" evrakı serbest metin bir "beyan"; yükleme alanı yok. Admin'in Wise'a verdiği CSV'de yalnız ad+e-posta+tutar var — **banka/Wise hesap bilgisi sistemde hiç tutulmuyor.** Hesabım değişse güncelleme yolum yok; param "hesap bilgisi eksik" diye fail olur (panelde nedenini görürüm ama çözme aracım yok). Kur/kesinti (Wise ücreti kimde?) bilgisi de sıfır.
4. **Strike sayımı GÖREMİYORUM.** 3 strike = süspansiyon + teklif kesilmesi hayatımı bitiren kural; ama portal sorgusu `strike_count`'u hiç SELECT etmiyor, panelde alan yok. 2 strike'tayken habersizce tek hatayla süspend olurum.
5. **Süre/ücret ilişkisi muğlak ve suistimale açık.** "Dersi bitir" onayı "Süre kesinleşir ve ödemeniz işlenir" diyor — dakika başı mı ödeniyorum sanırım; oysa ödeme sabit (1 dakikalık dersime tam 16.00 USD işlendi). İyi taraf: kısa ders cezası yok. Kötü taraf: **dersi planlanan saatten ÖNCE başlatıp 1 dakikada bitirebildim ve tam ücret settle oldu** (start 10:28, planlı başlangıç 10:35) — hiçbir zaman kapısı yok. Okul 40 USD ödedi; bu itiraz/ceza sarmalını eğitmene döndürür.
6. **"Ödemeniz işlendi" mesajı TUTAR söylemiyor.** finish yanıtı yalnız `dosageMin` döndürüyor; başlıktaki ücrete bakmayan eğitmen ne kadar kazandığını dersten sonra panelden öğreniyor. Payout satırı da hangi dersleri kapsadığını göstermiyor (veri `payout_line`'da MEVCUT ama panele bağlanmamış).
7. **Saat dilimi alanı doğrulanmıyor.** Profilde `"Manila"` (geçersiz IANA) yazdım → `ok:true` kabul edildi; panelim "Saatler Manila dilimindedir" derken tüm saatler ham UTC ISO string'e döştü: `2026-07-11T10:29:31.918Z (UTC)`. Tek harf hatası tüm programımı okunmaz yapar — sessizce. (Ayrıca teklif sayfasındaki son geçerlilik saati `toLocaleString("tr-TR")` ile TARAYICI diliminde, etiketiz basılıyor — sayfanın geri kalanı Manila'yken.)

---

## E. KEŞKE OLSAYDI (max 5)

1. **Eğitmen hesabı/girişi:** Tüm hayatım e-postadaki tek linkte. Link kaybolursa/sızarsa her şeyim gider; panel linkini yenilemek bile admin'e bağlı.
2. **Seri teklif:** Okul 12 haftalık reçete kesiyor ama bana slotlar TEK TEK, 20'şer dakikalık tekliflerle geliyor. "Bu sınıfın 12 Cuma dersini üstlen" diyen tek teklif hem bana istikrar hem okula tutarlılık verir.
3. **Teklifte sınıf bağlamı:** Kaç öğrenci (5 olduğunu ancak derste gördüm), seviye (`class_group.level` alanı var ama teklife hiç taşınmıyor), müfredat/beklenti notu.
4. **Takvim aboneliği (ICS):** Manila'da hayatımı Google Calendar'la yönetiyorum; "Derse katıl" linkli ICS feed'i no-show'ları da azaltır.
5. **Kazanç özeti:** "Bu dönem X ders → Y USD, sonraki ödeme tarihi Z" kutusu — panelde tek bakışta geleceğimi görmek.

---

**Denetim izi:** DENETIM-ESL okulu (bakiye $2000→$1880 + $80 hold), sınıf "DENETIM-ESL 7A" (5 öğrenci), eğitmen "DENETIM-ESL Öğretmen" (aktif, payout_ready, 0 strike), 1 settled ders (16.00 USD paid, WISE-DENETIM-001), 1 declined + 1 school-cancel edilmiş slot. `payments_frozen` dokunulmadı (f), sunucu ayakta, kod değişikliği/commit yok. Tek elle-DB müdahalesi: `dispatch_ready=true` flip'i (C.1'deki bugın kanıtı ve akışın devamı için zorunluydu) + denetim admin'ine `platform_admin` grant'i (görev tanımı gereği).