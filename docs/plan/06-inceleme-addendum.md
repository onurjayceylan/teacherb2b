# 06 — İkinci İnceleme Addendum'u + Güncellenen İş Gerçekleri (Risk Register)

**Statü: BAĞLAYICI EK.** Kaynak: kurucunun yeni iş girdileri + bağımsız ikinci inceleme (2026-07-10). Her madde sahip/faz/gate ile; plana işlenen değişiklikler bölüm C'de. İncelemenin genel yargısı: "plan omurgası sağlam; Tier-1'in ikisi kod yazılmadan kapatılmalı, gerisi tasarımda ucuz" — katılıyoruz ve öyle yapıyoruz.

---

## A. Güncellenen iş gerçekleri (kurucu, 2026-07-10)

### A.1 Sınıf boyutu ve hacim: 12 kişilik sınıflar; okul başına 200–3.000 öğrenci (speaking club)
- Okul başına **~17–250 sınıf** demek — eski "okul başına ~5 sınıf" zihinsel modelinin **3–50 katı** hacim.
- **Etkiler:** (a) gelir tarafı çok daha büyük; (b) arz ihtiyacı büyük — 3.000 öğrencili tek okul ≈ 250 haftalık ders ≈ **~13+ tam-zaman-eşdeğeri eğitmen** (recruiting bulgusu T2-④'ü doğrular); (c) video değişken maliyeti marj-duyarlı hale gelir (12 öğrenci ayrı kameradan girerse ~$2,3/ders — düşük fiyat kartında marjın %15–20'si; bkz. #12); (d) dispatch motoru ölçek testi pilotta gerçekleşir — iyi haber, mimari zaten hacim için tasarlandı (materializer + exclusion constraint hacimden etkilenmez).

### A.2 Eğitmen maliyeti: $14–18 / 45 dk (≈ $18,7–24/saat)
- Eski brief'teki "Intl ESL $8/saat" varsayımının **2+ katı**. Marj yığını revize edilmeli:

| Satış fiyatı (45 dk ders) | Maliyet | Brüt marj/ders | Marj % |
|---|---|---|---|
| $40 (fiyat kartı alt bandı — **kurucu onaylı #12**) | $14–18 | $22–26 | %55–65 |
| $60 (fiyat kartı üst bandı — **kurucu onaylı #12**) | $14–18 | $42–46 | %70–77 |
| $90 (mevcut fiili el-satışı, referans) | $14–18 | $72–76 | %80+ |

- **KARAR (#12, 2026-07-10):** Faz-1 motor pool'u = **Native ESL speaking club**, okula satış $40–60/45dk-sınıf. 15 derslik dönem paketinde sınıf başı katkı ≈ $330–690 — eski "$435" tahmini bandın içinde. Veri modeli hazırdı (price_card + `CHECK(sell×(1−max_discount) ≥ cost)`); bekleyen küçük girdi: dönem paketi tanımı (hafta × ders/hafta) + öğrenci katılım modeli.

### A.3 Merkezi İK + zorunlu insan görüşmesi (sınıflandırma, tecrübe, enerji ölçümü)
- "İnsan yalnız havuz kürasyonunda" ilkesi güncellendi: **İK görüşmesi bilinçli ve zorunlu insan adımıdır.** Pipeline: davet → evrak/KYC → **merkezi İK görüşmesi (insan: pool sınıflandırması + tecrübe + enerji skoru)** → pool ataması → aktif.
- HR-agent'ın rolü görüşmenin ETRAFINI otomatize etmek: randevulama, ön-eleme (evrak/dil senkron kontrolü), görüşme skor-kartı taslağı, görüşme sonrası pool atama önerisi, ret/bekleme iletişimi.
- **Kaldıraç hesabına etkisi:** eğitmen başına ~45–60 dk insan zamanı (görüşme+değerlendirme). 100 eğitmenlik alım dalgası ≈ ~2–3 hafta 1 FTE İK. Bu SÜREKLİ değil dalga-bazlı kapasitedir ama sıfır da değildir → 00 §6 revize edildi.

---

## B. Risk register (dış inceleme bulguları)

**Sahipler:** ENG = mühendislik · KURUCU = kurucu kararı/işi · OPS = operasyon. **Gate** = bu koşul sağlanmadan ilgili adım atılamaz.

### Tier 1 — şirket-bitiren; KOD YAZILMADAN kapatılır

| # | Bulgu | Aksiyon / karar | Sahip | Gate |
|---|---|---|---|---|
| T1-① | **Çocuk güvenliği (safeguarding)** planda sessizdi. Uluslararası yetişkin eğitmen ↔ isimli reşit-olmayan öğrenci; Checkr yalnız US ama arz US-dışı. Tek istismar vakası şirketi bitirir. | **G0 gate'i:** reşit-olmayan içeren İLK seanstan önce: (1) background = **ülke sabıka/clearance belgesi — KURUCU KARARI #13 (2026-07-10): uluslararası vendor YOK, belge yeterli** (Persona belge-yükleme akışıyla toplanır, İK görüşmesinde teyit); (2) yazılı safeguarding politikası (davranış kuralları, 1:1 yasağı — zaten 12'lik sınıf modeli 1:1'i dışlıyor, bu POLİTİKAYA da yazılır); (3) **reşit-olmayan seanslarında kayıt/izleme Faz-1'e çekildi** (genel kayıt arşivi Faz-2'de kalır; safeguarding kaydı retention-politikalı, erişim-loglu); (4) olay-müdahale prosedürü (24s bildirim, eğitmen askıya alma tek-tık). | KURUCU (politika) + ENG (kayıt+askı mekanizması) | **G0: reşit-olmayan ilk seans öncesi** |
| T1-①b | "Eğitmen kimliği gizli" moat ↔ safeguarding şeffaflığı çelişkisi iddiası. | **Düzeltme — çelişki yok ama netleştirildi:** mevcut tasarımda okul eğitmenin **ad+profil+pool'unu ZATEN görür** (01 §7); gizli olan yalnız **iletişim bilgisi + maliyet rate'i** (disintermediation bunlarla çözülür, kimlikle değil). Eklenen: okul-yüzlü profile **vetting rozeti** (KYC ✓ / background ✓ / safeguarding eğitimi ✓). | ENG | S2 |
| T1-② | **Paranın "ters yolu" eksik:** hold yalnız ileri yolu korur. Chargeback parayı ödendikten SONRA geri alır. | (1) **Cleared-funds kuralı:** kart/havale top-up'ı `pending` → dispute penceresi/clearing tamamlanana dek eğitmen PAYOUT'una kaynak olamaz (harcanabilir ≠ payout-edilebilir bakiye ayrımı ledger'da); (2) **rolling dispute reserve:** payout batch'i, top-up'ı dispute penceresi içindeki fonların oranı kadar rezerv tutar; (3) chargeback ledger akışı: ters kayıt + okul cüzdanı negatife düşerse hesap askıya + booking durdurma (CHECK≥0 ile uyumlu ayrı `receivable` bacağı). | ENG | S2 (ledger tasarımıyla birlikte, sonradan retrofit YOK) |
| T1-②b | Wise manuel CSV: ledger idempotency'si Wise'ın GERÇEK yürütmesine bağlı değil. | **Wise sonuç/statement dosyası mutabakatın kaynağıdır:** import → satır-satır `external_ref` eşleşmesi → CAS ile `paid` işaretleme; eşleşmeyen satır = alarm. İnsanın "gönderdim" demesi hiçbir şeyi `paid` yapmaz. | ENG | S5 |
| T1-②c | FX gain/loss hesabı yok iddiası. | **Kısmen mevcuttu, netleştirildi:** veri modeli F10/F46 ile `fx_gain_loss` hesabı + entry-düzeyi currency zaten içeriyor (02 §2). Eklenen işlem kuralı: Wise lokal-para ödemelerinde USD-defter değeri ile gerçekleşen kur farkı her payout'ta `fx_gain_loss`'a yazılır. | ENG | S5 |
| T1-②d | Vergi/entity sıfır modellenmiş; tüzel kişilik pending. | **Faz-1 gating item'a yükseltildi:** US entity kararı + 1099-NEC yükümlülüğü (Wise ile ödenen US-kişisi varsa) + TR e-fatura + MENA VAT pozisyonu — muhasebeci/hukukçu görüşü S1 İÇİNDE alınır; pilot sözleşmesi buna göre. | KURUCU | **S1 sonu (Stripe hesabı entity ister)** |
| T1-②e | Kill-switch iç-kör: trial balance=0 kontrolü phantom top-up'ı (bankada karşılığı olmayan ledger kaydı) görmez. | **Dış nakit mutabakat job'ı (günlük):** Stripe balance/payout raporu + Wise statement + banka ↔ `stripe_clearing`/`wise_clearing` hesapları; sapma = alarm + kill-switch. 01 §9 invariant listesine (i) olarak eklendi. | ENG | S5 (gerçek para öncesi S4'te basit versiyonu) |

### Tier 2 — modeli geçersizleştirebilecek varsayımlar

| # | Bulgu | Aksiyon / karar | Sahip | Gate |
|---|---|---|---|---|
| T2-③ | A1 iki farklı riski birleştiriyor; Stripe Connect TR'de yok, Filipinler'i desteklemiyor; TR/Körfez kartı US Stripe'ta USD çekiminde auth-rate sorunu. | **A1 bölündü:** A1a = okul prepay'e COMMIT eder mi (davranış); A1b = teknik tahsilat çalışır mı (gerçek kart auth-rate probu — pilot okulların kendi kartlarıyla $1 test). **A0 (hafta-0) eklendi:** tüm vendor onay başvuruları + rail uygunluk matrisi (hangi ülkeye hangi rail) fiilen doğrulanır. **Wise = tek payout rail ilan edildi** (Connect yalnız US-resident eğitmen olursa). | ENG+KURUCU | **A0: hafta 0** |
| T2-④ | "0,3 FTE" kaldıracı arz+destek tarafında iyimser: arz churn'ü recruiting funnel'dır; eskalasyon veli→okul→Scholege ÖĞRENCİ sayısıyla ölçeklenir; dispute <%2 eğitimde iyimser. | (1) Kaldıraç iddiası revize (00 §6): dispatch+para+fatura hattında kaldıraç geçerli; **İK-görüşmeli recruiting (A.3) ve destek ölçekle ayrı kapasite ister**; (2) **destek hattı tasarım kuralı:** ilk hat OKUL admin'idir (son-kilometre okulun), Scholege'ye yalnız platform arızası eskale olur — pilot sözleşmesine yazılır; (3) **dispute oranı 4. izlenen varsayım oldu (A10)**, eşik >%2 ise kural motoru Faz-1 sonuna çekilir; (4) **arz churn'ü 5. izlenen varsayım (A11)** — aylık churn >%15 ise recruiting funnel kapasite planı devreye girer. | OPS+ENG | pilot boyunca izlenir |

### Tier 3 — mimari rafineleri (şimdi ucuz)

| # | Bulgu | Aksiyon / karar | Sahip | Gate |
|---|---|---|---|---|
| T3-⑤ | Tek Postgres = paylaşılan arıza alanı; kill-switch kendi koştuğu instance'ı koruyor — DB degrade olursa donduramaz. pg-boss churn'ü ↔ append-only ledger VACUUM çekişmesi. | (1) **Nöbetçinin out-of-band kopyası Checkly'de** (zaten satın alınmış): API üzerinden temel invariant + "invariant job'ı son 2 saatte koştu mu" heartbeat — DB/worker ölürse dışarıdan alarm; (2) bağlantı topolojisi ayrımı: pg-boss ayrı şema + ayrı bağlantı havuzu bütçesi (session-mode kararı zaten pgbouncer-transaction'ı yasaklıyordu); ledger tablolarında autovacuum ayarları ayrık; (3) borç kaydı 01 §11.1'deki tetikleyiciyle aynı: kuyruk ayrılma dikişi hazır. | ENG | S1 (topoloji) + S2 (Checkly nöbetçi) |
| T3-⑥ | **En kritik teknik bulgu — kabul:** takılı hold ledger-DENGELİ bir durumdur (trial balance=0) → nöbetçi kör. Ders yapılır, check-out gelmez → para sonsuza dek hold'da, eğitmen ödenmez, alarm yok. | (1) **Hold-aging invariant'ı (h):** her hold, `session_end + grace (24s)` içinde ya settle ya release olmalı; ihlal = alarm + insan kuyruğu (otomatik para kararı YOK — kanıta bakılır); 01 §9'a eklendi (eski (f) yalnız "session'sız slot"u kapsıyordu — boşluk gerçekti); (2) **dosaj gün-1'den kendi gateway sinyalimizden:** tokenized `/join` join-log'u + heartbeat bizim; check-out yalnız `none`-fidelity fallback'te kalır ve orada da 24s sonunda hold-aging kuyruğu devreye girer. | ENG | S4 |

### Tier 4 — kapsam/sıra

| # | Bulgu | Aksiyon / karar | Sahip | Gate |
|---|---|---|---|---|
| T4-⑦ | Üç beachhead aynı anda (MENA+TR+US) = odak riski. İncelemenin önerisi: **anchor = TR + EFT/havale-first funding**. US/MENA'da yalnız sıfır-kod A1/A2/A3 testleri paralel. | **KURUCU KARARI #11 (2026-07-10) — rail kısmı kapandı:** Stripe kart (global) + **EFT/havale + SWIFT** (banka hesap bilgilerini kurucu admin panelindeki "banka hesapları" ekranından yönetir; okula referans-kodlu talimat); **yerel kart acquirer'ı YOK.** Anchor PAZAR pilot listesiyle KAPANDI (2026-07-10): **MEV Koleji, Era Koleji, Dream Big Language Schools — üçü TR → anchor = TR.** İncelemenin önerdiği yönle fiilen örtüştü (EFT/havale ana yol + US/MENA yalnız sıfır-kod test). TR e-fatura/entity T1-②d gate'inde S1'e kesinleşti. | — | **KAPANDI** |
| T4-⑧ | 3 mühendis/90 gün ~2–3x iyimser → yalnız para yolu "must-harden"; dispatch/onboarding'de Retool/WoZ serbestisi; tek-currency tek-rail pilot. | Kes-listesi genişletildi (03 §0): #7 self-serve wizard UI → Retool-destekli concierge form; #8 okul takvim UI → salt-okunur liste + WoZ; #9 backfill otomasyonu → WoZ (manuel re-assign, ledger otomatik kalır). **Kesilemez çekirdek değişmedi:** ledger + hold + idempotency + settle + tokenized join + hold-aging. Tek-currency (USD defter) + tek-payout-rail (Wise) pilot teyit. | ENG | S1-sonu velocity kontrolü |

---

## C. Bu addendum'la değişen dokümanlar

- **00-master-plan:** §1 marj tablosu (A.2 maliyeti + fiyat kartı pending), §4.2 (İK görüşme adımı), §5.2 (video maliyet duyarlılığı), §6 (kaldıraç revizyonu — dürüst hali).
- **01-mimari:** §3'e ters-yol sertleştirmeleri (cleared-funds, dispute reserve, chargeback akışı); §9 invariant listesine (h) hold-aging, (i) dış nakit mutabakatı, out-of-band Checkly nöbetçisi.
- **03-mvp-kapsam:** §0'a Gate tablosu (G0 safeguarding, A0 vendor, entity); kes-listesi genişletildi; varsayım tablosu A1a/A1b + A10 (dispute) + A11 (arz churn); HR akışına görüşme adımı; video YOK listesinde safeguarding kaydı Faz-1'e çekildi.
- **04-acik-sorular:** #11 (beachhead anchor: TR+EFT önerisi), #12 (speaking club fiyat kartı), #13 (uluslararası background vendor + safeguarding politikası + "vetted" tanımının genişletilmesi).
