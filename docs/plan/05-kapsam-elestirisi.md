# Scholege Lite MVP Kapsam Planı — Eleştiri Raporu

## 1. 90 GÜNDE SIĞAR MI? — Hayır, mevcut haliyle ~%125–140 kapasite. Koşullu sığar.

### Kapasite gerçeği

Planın gerçekçi olması **3 mühendis + agent'lar** varsayımına bağlı; plan bu varsayımı hiç açıkça yazmamış. **1 mühendisle bu 6+ aylık bir plan** — plan "1–3 mühendis" aralığını tek kapsamla karşılıyor, bu dürüst değil. Plana "N=3 varsayılmıştır; N=1 ise degrade kapsam şudur" satırı eklenmeli.

Sprint bazında aşırı yük noktaları:

- **S1 (en şişkin sprint):** Multi-tenant auth + RBAC + sliding session + JWT-DB tazeleme + migration-disiplinli şema + Stripe Checkout + double-entry ledger + idempotency test suite = tek başına 4–6 mühendis-haftası iş. 2 haftaya sığmaz.
- **S2 (dört harici entegrasyon):** DocuSign + Persona + W-8BEN + Stripe Connect + Wise aynı sprintte. Her biri sandbox kurulumu, webhook, edge-case demektir. Daha kötüsü: **bunlar mühendislik süresi değil, TAKVİM süresi riski** — Wise Platform API erişimi haftalar süren iş onayı ister; Stripe Connect platform incelemesi, DocuSign kurumsal sözleşmesi de öyle. Başvurular S2'de başlarsa S2 kesin kayar.
- **S3:** Recurring booking + timezone/DST matematiği + accept/decline timeout zinciri + takvim UI — recurrence + timezone kombinasyonu yazılımın en klasik "2 hafta sanıp 5 hafta süren" işidir.
- **Gizli iş: SuperClass.** Plan SuperClass'ın (a) API ile meeting provision edebildiğini, (b) join/leave event'lerini ödeme-trigger'ı güvenilirliğinde ürettiğini varsayıyor. Zoom için A6 spike'ı var ama SuperClass için yok. "Kendi ürünümüz" olması entegrasyon maliyetini sıfırlamaz — multi-tenant provisioning API'si ve event webhook'u yoksa bu 2–3 haftalık ek iştir ve hiçbir sprintte bütçelenmemiş.

### Kes-listesi (önem sırasıyla — üstteki önce kesilir)

1. **Zoom entegrasyonu — koşullu değil, ŞİMDİDEN kes.** Plan bunu "S3'te geride kalırsak" koşuluna bağlamış; koşulsuz kesilmeli. Gerekçe: (a) A6 zaten Zoom webhook güvenilirliğinden şüpheli, (b) SuperClass-only pilot **video-lock/disintermediation stratejisini güçlendirir**, (c) pilot sözleşmesine "SuperClass-only" maddesi koymak sıfır mühendislik maliyetiyle aynı sonucu verir. Zoom'u "okul ısrar ederse" diye tutmak, pilotta okulun ısrar etmesini davet eder.
2. **Wise API otomasyonu → ledger-otomatik + manuel-yürütülen payout.** Accrual, batch hesabı, external_ref UNIQUE, idempotency = tamamen otomatik ve DB'de. Fiili transfer = sistemin ürettiği CSV ile manuel Wise gönderimi, external_ref geri işlenir. Pilot ölçeğinde (10–15 eğitmen × 2 haftada bir) bu 2 haftada ~30 dakikadır. "Para döngüsünde sıfır insan" tezini ledger katmanında kanıtlarsın; ray otomasyonu Faz-2. (Not: Stripe Connect'in eğitmen coğrafyasını — Mısır vb. — kapsamama ihtimali yüksek; Wise'ı tamamen kesemezsin, otomasyonunu kesersin.)
3. **Auto-topup** (low-balance uyarısı + kayıtlı kartla tek-tık yükleme kalır).
4. **Fatura PDF → ekstre ekranı + aylık manuel fatura şablonu.** Prepaid modelde fatura tahsilat aracı değil muhasebe belgesi; TR'de zaten e-Arşiv gibi uyum gerektirir ve bunu MVP'de otomatize edemezsin (bkz. Bölüm 2) — manuel olması kaçınılmaz, dürüst ol.
5. **Onboarding-wizard agent → statik yönlendirmeli form.** Planın kendi 5. gizli-ops maddesi zaten "wizard aslında danışmanlık, concierge call kesin" diyor — o zaman agent'ı MVP'de yazmak israf; call'da kullanılan statik form + call notlarından Faz-2 agent tasarımı.
6. **Utilization dashboard → düz sayfada 3 sayı** (satın alınan saat / tüketilen saat / doluluk %). "Dashboard" kelimesi UI haftası yakar.
7. **Backfill'in T-24s-içi "agent dener" kolu → yalnız alert + otomatik kredi iadesi.** T-24s dışı otomatik backfill kalır (asıl tez o).
8. **DocuSign → yedek plan olarak clickwrap** (audit-trail'li in-app kabul): DocuSign tedariki uzarsa eğitmen sözleşmesi için hukuken çoğu yargı alanında yeterli, S2'yi bloklamasın.

**Asla kesilmeyecekler** (plan doğru tutmuş, teyit): ledger atomikliği/idempotency, prepaid cüzdan, accept/decline akışı, session-logger güvenilirliği, tenant scoping.

---

## 2. EKSİK KRİTİK İŞLER

### Para (en ağır eksikler burada)

- **İptal/no-show politika matrisi YOK.** Planın en büyük deliği. Gerçek derslerin ilk haftasında yaşanacak senaryoların hiçbirinin ledger sonucu tanımlanmamış: okul T-48s'te iptal ederse cüzdan düşer mi? Okul T-2s'te iptal ederse eğitmene ödeme yapılır mı (yapılmazsa eğitmen churn'ü, yapılırsa kim öder)? Öğrenci/sınıf no-show ≠ eğitmen no-show — 5. gizli-ops maddesi dispute'u biliyor ama **politikanın kendisi** hiçbir sprintte yok. Bu sözleşme maddesi + ledger kuralıdır, S3–S4'e girmek zorunda.
- **Sıfır-bakiye davranışı tanımsız.** Guaranteed-dosage ile prepaid çelişir: cüzdan dönem ortasında biterse scheduled booking'lere ne olur? Kural gerekli: "runway < X gün → uyarı; bakiye ≤ 0 → booking askıya" + dashboard'da runway göstergesi.
- **Payout failure state machine yok.** Yanlış IBAN, reddedilen Wise transferi, Stripe Connect hold → "geciken payout 0" metriği daha ilk batch'te kırılır. failed/retry/manual-review durumları şart.
- **Stripe chargeback senaryosu:** okul dersleri tükettikten sonra chargeback açarsa ledger'da ne olur? En azından tanımlı bir manuel prosedür.
- **Fatura uyumu:** TR tüzel kişisine kesilen fatura e-Arşiv/e-Fatura ister; KSA/UAE VAT (%15/%5) vardır. MVP kararı net olmalı: "pilotta ABD tüzel kişisinden USD fatura kesilir, yerel vergi uyumu okul tarafında" — bu bir kod işi değil ama **yazılı bir karar** olmalı, yoksa ilk TR pilotunda muhasebe krizi çıkar.
- **Webhook imza doğrulaması** (Stripe, Persona, DocuSign) hiçbir yerde anılmamış. İdempotency yetmez; imzasız webhook kabul eden ledger, para güvenliği kısıtının ihlalidir.
- **DB yedekleme + restore tatbikatı** S4'te gerçek para akmaya başlamadan ÖNCE yapılmalı. Yedeklenmemiş ledger = dava. Planda yok.
- **Manuel ledger işlemleri için append-only audit log:** manual_topup ve adjustment "izlenebilir" denmiş ama açık bir audit-trail gereksinimi olarak yazılmalı (kim, ne zaman, hangi kanıtla).

### Güvenlik

- **AuthZ/IDOR S6'ya bırakılmış — bu planın en tehlikeli sıralama hatası.** 10 hafta endpoint yazıp 11. haftada "tarama" yapmak, sert kısıtın ("her record endpoint = liste scope'u") tam tersidir. Üstelik okul #2–3 **S5'te** canlıya alınıyor, yani multi-tenant IDOR taramasından ÖNCE gerçek tenant'lar yan yana yaşıyor. Tenant scoping S1'de **yapısal** olmalı (her sorgu tenant-scoped query builder/middleware'den geçer); S6 yalnızca doğrulama olur.
- **Reşit olmayan öğrenci PII'ı tamamen atlanmış.** CSV roster import = çocuk verisi → KVKK (TR), PDPL (KSA/UAE), GDPR. Recording'in ertelenmesi doğru ama attendance loglarında öğrenci ismi tutmak bile DPA + gizlilik politikası ister. MVP çözümü ucuz: (a) pilot sözleşmesine DPA eki, (b) veri minimizasyonu — mümkünse öğrenci ismi yerine sınıf-düzeyi roster/pseudonym. Sıfır anılmamış olması ciddi açık.
- **Self-serve kayıt + Stripe Checkout = card-testing fraud yüzeyi.** Stripe Radar + basit rate-limit yeterli ama listede olmalı.

### Pilot okulun günlük kullanımı

- **Bildirim katmanı hiç yok — oysa dispatch SLA'sının gizli bağımlılığı.** "Timeout'ta sıradaki adaya geçiş" ancak eğitmen daveti FARK EDERSE çalışır; eğitmenler web app'te yaşamaz. Transactional e-posta (accept/decline imzalı link ile e-postadan) MVP'ye şart; MENA/TR gerçeğinde WhatsApp kanalı Faz-2'ye ertelenebilir ama e-posta ertelenemez. Şu an accept-rate'i taşıyacak hiçbir kanal bütçelenmemiş.
- **"Pause/skip week" primitifi koşula bağlanmamalı, ŞİMDİDEN Faz-1'e alınmalı.** A3 deneyi ">%15 istisna çıkarsa alırız" diyor; MENA/TR okul takviminde (ara tatiller, sınav haftaları, dini bayramlar — 90 günlük pilot pencerede kasım ara tatili + yarıyıl kesin denk gelir) eşiğin aşılacağı bellidir. Deneyi yine koş ama sonucu bekleme, S3'e koy.
- **Öğrenciler derse nasıl girer?** join_url Session'da duruyor — ama sınıfa kim dağıtıyor? Sınıf projeksiyonla tek ekrandan mı giriyor, öğrenciler tek tek mi? Bu tanımsızlık ilk canlı derste patlar. Bir paragraf tasarım kararı yeter ama yok.
- **Eğitmen-yüzlü ekran eksik:** eğitmenin haftalık programı + earning bakiyesi + payout geçmişi ekranı hiçbir sprintte açıkça yok. Yoksa her eğitmen "bu ay ne kadar kazandım?" diye insana yazar — gizli insan-ops üretirsin.
- **Yedek eğitmenin ders bağlamı:** backfill gelen eğitmen sınıfın seviyesini/nerede kaldığını bilmiyor → kalite şikayeti. Minimum: booking üzerinde seviye + not alanı.

---

## 3. GİZLİ İNSAN-OPS AVI — İyi ama 4 avlanmamış hayvan var

Listedeki 5 madde (havale mutabakatı, T-24s backfill, KYC exception, dispute, wizard-danışmanlık) isabetli ve workaround'ları dürüst. Atlananlar:

1. **Arz bakımı (en büyüğü).** "Arz zaten var" statik bir iddia; availability grid'leri 2 haftada bayatlar, accept-rate düşer, reserve-pool derinliği kendiliğinden erimeye başlar. Pilotta birinin (kurucu) her hafta eğitmenleri dürtüp availability tazeletmesi ve slot-başına yedek derinliğini takip etmesi gerekecek — haftada saatler süren, hiçbir yerde bütçelenmemiş iş. Faz-2 yolu: availability-staleness otomasyonu + taahhüt teşviki.
2. **Strategist havuzu dispatch-şekilli DEĞİL.** Bu ürün-model uyumsuzluğu ve gizli-ops aynı anda: admission strategist işi sınıf-başına-haftalık-saat reçetesine oturmaz; aile/öğrenci bazlı, kapsamı görüşmeyle belirlenen danışmanlık engagement'ıdır. "Land" ürününün — yani GTM tezinin kapısının — MVP'nin temel soyutlamasına uymadığı gerçeği planda hiç yüzleşilmemiş. Pilotta strategist scoping'i %100 insan (kurucu) olacak. Dürüst MVP çözümü: strategist'i "aylık saat-bloğu + takvimden randevu" olarak ayrı hafif bir modelle sat; dosaj motoruna zorlama.
3. **SuperClass canlı destek.** Video kendi ürünün olduğu için ders sırasındaki her teknik arıza SENİN on-call'un. "Video sorunu = eğitmen çözemez, okul çözemez" → pilotta kurucu telefonu. Bilinçli kabul edilip yazılmalı.
4. **Founder-led sales'in kendisi.** Plan "sıfır satışçı" derken S1–S6 boyunca kurucu discovery call, concierge onboarding, pilot review yapıyor — bu satıştır ve pilot için DOĞRUdur; sorun yapılması değil, **A1/aktivasyon metriklerinin bunu görmezden gelmesi** (aşağıda).

Ayrıca **iç tutarsızlık:** Kabul kriteri 1.1 "insan teması olmadan medyan <15 dk" derken gizli-ops #5 "Zoom call neredeyse kesin" diyor. İkisi aynı belgede duruyor. Çözüm: pilot kabul kriteri "tüm tıklamalar okul tarafından + kurucu-dokunuşu ≤1 call" olsun; "<15 dk insan-temassız" pilotun geçme şartı değil, enstrümante edilen Faz-2 hedefi olarak kalsın.

---

## 4. SPRINT SIRALAMASI — En riskli iki şey yeterince erken doğrulanmıyor

**Doğru olanlar:** A1/A2'nin sıfır-kod deneylerle S1'e paralel koşması mükemmel. Para atomikliğinin 1. günden test suite ile gelmesi doğru. Kesme kuralının önceden yazılı olması doğru.

**Yanlış olanlar:**

1. **İlk gerçek ücretli ders 7. haftada.** 12 haftalık planda gerçek okul + gerçek eğitmen + gerçek para ancak S4'te buluşuyor; canlı öğrenme için sadece 5 hafta kalıyor. Oysa A3 (reçete gerçek takvimde yaşar mı) ve A4 (arz kabul eder mi) — dispatch OS kimliğinin özü — spreadsheet simülasyonuyla değil canlı dersle doğrulanır. **Çözüm: Wizard-of-Oz dispatch, hafta 3–4.** Okul #1 ile gerçek ücretli dersleri manuel booking (spreadsheet + SuperClass linki + admin aracından manuel ledger girişi) ile başlat. Dispatch kodu yokken dispatch tezini test edersin; S3'te otomatiğe göç edersin. Bu tek değişiklik planın öğrenme hızını ikiye katlar.
2. **AuthZ S6'da (yukarıda detay):** okul #2–3, IDOR taramasından önce canlıda. Yapısal scoping S1'e, S6 sadece doğrulama.
3. **Vendor başvuruları sprint planında yok:** Stripe Connect incelemesi, Wise Platform onayı, Persona/DocuSign tedariki 1. hafta İLK GÜN başlamalı — yoksa S2 mühendislikten değil bürokrasiden kayar.
4. **SuperClass event-güvenilirlik spike'ı yok:** Ödeme trigger'ının kaynağı olan SuperClass join/leave event'leri için A6-eşdeğeri 1 günlük spike S1'e konmalı (yeni varsayım **A9: "SuperClass provisioning + attendance event'leri ödeme-trigger'ı güvenilirliğinde üretim-hazır"** — risk listesine girmeli, muhtemelen A5–A6 arası sıraya).
5. **Kesme kontrol noktası S3'te ama şişkin sprintler S1–S2.** Velocity checkpoint'i S1 sonunda karara bağla (planda anılmış ama kesme kuralı S3'e bağlanmış) ve S2'nin ön-kesilmiş versiyonunu (Wise-manuel, clickwrap-fallback) şimdiden yaz.

**Metrik notları (küçük ama karar bozar):** n=3–5 okulda NPS anlamsız — çıkar, yerine yapılandırılmış çıkış görüşmesi koy. "T-24s dışı iptallerin ≥%90'ı otomatik backfill" pilotta belki 5–10 iptal vakası görür — yüzde yerine "N vakanın N'i mekanizmayla çözüldü" diye raporla. "Expand ≥%50" 90 günde agresif — go/no-go kapısı değil sinyal olsun. A1 metriği dürüstleştirilmeli: pilotların hepsi founder-touched olacağı için A1 pilotta "satışçısız edinim"i değil yalnızca "kartla prepaid ödeme isteği"ni doğrular; landing-page deneyi bu yüzden pilottan bile değerli, mutlaka koşulmalı.

---

## 5. SOMUT DEĞİŞİKLİK ÖNERİLERİ (uygulama sırasıyla)

1. **Zoom'u koşulsuz kes**; pilot sözleşmesine "SuperClass-only" maddesi ekle (video-lock'u da güçlendirir). Kesme kuralının 1. maddesi boşa çıkar, listeye yeni yedek ekle: T-24s-içi agent-backfill kolu.
2. **Hafta 1, gün 1: tüm vendor başvurularını gönder** (Stripe Connect platform, Wise Platform API, Persona, DocuSign). DocuSign gecikirse clickwrap fallback'i önceden tasarla.
3. **Yeni varsayım A9 ekle** (SuperClass event güvenilirliği) + S1'e 1 günlük SuperClass provisioning/attendance spike'ı koy.
4. **Tenant scoping'i S1'de yapısal yap** (tenant-scoped query katmanı, scope'suz sorgu derlemede/testte reddedilir); S6 IDOR işini "ilk kez uygulama" değil "doğrulama" olarak yeniden tanımla.
5. **Wizard-of-Oz dispatch'i S2'ye ekle:** okul #1 ile gerçek ücretli dersler hafta 3–4'te manuel booking'le başlar; S3'te otomatiğe göç. S4'ün "ilk gerçek ücretli ders" satırı "otomatik akışa göç" olur.
6. **İptal/no-show politika matrisini yaz (S3) ve ledger'a göm (S4):** okul-iptali (erken/geç), eğitmen-iptali, sınıf no-show, eğitmen no-show → her hücrenin cüzdan + eğitmen-earning sonucu tanımlı. Pilot sözleşmesine aynı matris madde olarak girer.
7. **"Pause/skip week" primitifini koşulsuz S3'e al** (A3 deneyini yine koş ama sonuç ne olursa olsun primitif MVP'de).
8. **Transactional e-posta katmanı + e-postadan imzalı linkle accept/decline'ı S3'e ekle** — dispatch SLA'sının ön koşulu olarak.
9. **Wise otomasyonunu kes → "ledger-otomatik, yürütme-manuel" payout:** sistem batch'i + CSV'yi üretir, insan gönderir, external_ref geri işlenir. Gizli-ops tablosuna 6. satır olarak dürüstçe ekle (~30 dk / 2 hafta).
10. **Sıfır-bakiye kuralı + runway göstergesi tanımla (S4):** bakiye ≤ 0 → yeni booking üretimi durur, mevcut hafta işlenir, okula runway uyarıları N gün önceden.
11. **Payout failure state machine ekle (S5):** failed/retry/manual-review; "geciken payout 0" metriğini "failure'ların %100'ü 72 saat içinde çözüldü" ile değiştir.
12. **Güvenlik tabanını S1 tanımına yaz:** webhook imza doğrulaması, manuel ledger işlemlerine append-only audit log, self-serve kayıt rate-limit + Stripe Radar.
13. **S4 öncesi DB yedekleme + restore tatbikatı** sprint çıktısı olarak yaz (gerçek para akmadan önce).
14. **Çocuk-PII paketi ekle (S2–S3):** pilot sözleşmesine DPA eki, roster import'ta veri minimizasyonu (mümkünse isim yerine pseudonym/sınıf düzeyi), attendance loglarında PII rol-bazlı maskeleme.
15. **Eğitmen ekranını S4'e ekle:** haftalık program + earning bakiyesi + payout geçmişi (yoksa her eğitmen soru için insana yazar).
16. **Strategist'i dosaj motorundan ayır:** "aylık saat-bloğu + randevu" hafif modeli; kurucu scoping'i gizli-ops tablosuna 7. satır olarak ekle. Dispatch mühendisliğini ESL'e odakla.
17. **Gizli-ops tablosuna 8. satır: arz bakımı** (availability tazeleme + reserve-pool derinlik takibi, kurucu, ~2–3 saat/hafta) ve **9. satır: SuperClass ders-anı on-call**.
18. **Metrikleri düzelt:** NPS'i çıkar (n çok küçük) → yapılandırılmış görüşme; backfill %'sini vaka-sayısı raporuna çevir; expand ≥%50'yi kapı değil sinyal yap; kabul kriteri 1.1'i "tüm tıklamalar okulda + kurucu ≤1 call" olarak concierge gerçeğiyle uzlaştır; A1 metriğine "landing-page kart-ödeme deneyi koşuldu ve sonucu raporlandı" şartını ekle.
19. **Plana kapasite dürüstlüğü satırı ekle:** "Bu kapsam N=3 mühendis varsayar. N=1 ise: yalnız ESL havuzu, wizard-of-oz dispatch kalıcı, payout tamamen manuel, hedef 1–2 okul, süre 120+ gün."
20. **Fatura kararını yaz (kod değil):** pilotta ABD tüzel kişisinden USD + manuel şablon fatura; TR e-Arşiv / MENA VAT uyumu Faz-2'de yerel faturalama kararıyla birlikte ele alınır.

**Özet yargı:** Plan disiplinli ve kesme refleksi doğru; ama (a) 3 mühendissiz sığmaz ve bunu söylemiyor, (b) para döngüsünün en sık gerçek olayı olan iptal/no-show ekonomisi tanımsız, (c) AuthZ'nin sona bırakılması sert kısıtla çelişiyor, (d) ilk gerçek ders 7. haftada — dispatch tezi çok geç gerçekle buluşuyor, (e) bildirim katmanı ve strategist'in dispatch-uyumsuzluğu görülmemiş. Yukarıdaki 20 değişiklikle plan hem daha dar hem daha doğrulanabilir hale gelir.