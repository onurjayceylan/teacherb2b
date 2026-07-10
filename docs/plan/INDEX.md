# Scholege Lite — B2B Eğitmen Dispatch İşletim Sistemi: Plan Paketi

> Düşük-maliyet + AI-augmented eğitmen havuzlarını özel okullara TOPTAN satan "tedarikçi + yazılım" platformu. Okul son kilometreyi kendi yönetir; biz operatör değil, **dispatch OS**'iz.

Bu klasör, kod yazılmadan önce oturtulan mimari/plan paketidir. Üretim süreci: 3 bağımsız mimari önerisi → 3 lensli jüri paneli → kazanan senteze kaybedenlerden graft → veri modeli taslağı → 4 lensli adversarial doğrulama (57 bulgu, tamamı karara bağlandı) → MVP kapsam taslağı → bağımsız eleştiri turu (20 değişiklik entegre).

## Dokümanlar

| Doküman | İçerik | Statü |
|---|---|---|
| [00-master-plan.md](00-master-plan.md) | **Tek doküman özet:** ne/nasıl, süreç-süreç otomasyon haritası, maliyet analizi (sabit+değişken), 1-kişi-vs-10-kişi ops kaldıraç hesabı, mimari + diller, karar günlüğü | **GÜNCEL ÖZET** |
| [01-mimari.md](01-mimari.md) | Stack + üst-seviye mimari: sertleştirilmiş modüler monolit, multi-tenancy, para/ledger, dispatch motoru, video soyutlaması, agent orkestrasyonu, authz, i18n/RTL, migration disiplini, gözlemlenebilirlik, reddedilen alternatifler | **KARAR** |
| [02-veri-modeli.md](02-veri-modeli.md) | Üretim kalitesinde veri modeli v2: DDL düzeyinde çift-kayıt ledger, hold modeli, payout iki-faz, dispatch state machine'leri, RLS/tenancy, PII, audit — 57 adversarial bulgunun tamamı işlenmiş | **KARAR** (açık sorulara bağlı ince ayar hariç) |
| [03-mvp-kapsam.md](03-mvp-kapsam.md) | Faz-1 (0–90 gün) bağlayıcı yürütme planı: VAR/YOK tabloları, iptal/no-show para matrisi, 6 sprint, riskli varsayımlar + en ucuz deneyler, gizli insan-ops envanteri (9 satır), pilot metrikleri | **BAĞLAYICI** (eleştiri sonrası v2) |
| [04-acik-sorular.md](04-acik-sorular.md) | Kurucu kararı bekleyen 10 soru (4'ü bloklayan) — her biri seçenekler + tradeoff + ekip önerisiyle | **KARAR BEKLİYOR** |
| [05-kapsam-elestirisi.md](05-kapsam-elestirisi.md) | Kapsam v1'e yapılan bağımsız eleştiri turunun tam metni (v2'ye entegre edildi; izlenebilirlik için saklanıyor) | Arşiv |
| [06-inceleme-addendum.md](06-inceleme-addendum.md) | İkinci bağımsız inceleme + yeni iş gerçekleri: risk register (safeguarding G0, para ters-yolu, hold-aging, beachhead anchor, kaldıraç revizyonu) — sahip/faz/gate ile | **BAĞLAYICI EK** |
| [07-plan-final-duz-yazi.md](07-plan-final-duz-yazi.md) | Planın tamamının okunabilir düz-yazı FİNAL hali — tüm kararlar işlenmiş (paydaşlarla paylaşmaya uygun) | **FİNAL** |

## Mimari kararın özeti

**Jüri sonucu (3 bağımsız lens: para-doğruluğu, hız+küçük-ekip, min-insan-ops+güvenlik):** modüler monolit 150 · event-driven 141 · buy-maximalist 131 → **Sertleştirilmiş Modüler Monolit** kazandı; üç jüri de aynı yönde.

- **Gövde:** TypeScript + Next.js 15 + tRPC + Drizzle + **tek Postgres 16** (Render); job/cron/outbox dahil her garanti Postgres'ten (pg-boss); Redis/Kafka/Temporal yok.
- **Para-zırhı (event-driven'dan graft):** fiziksel append-only trigger'lar, `CHECK (balance >= 0)`, cüzdan **hold modeli** (ders verildi ama para yok = yapısal imkânsız), saatlik invariant nöbetçisi + ihlalde **otomatik kill-switch**, payout iki-faz + 15 dk otomatik mutabakat.
- **Satın alınanlar (buy-maximalist'ten graft):** better-auth SSO, Stripe Checkout/Connect Express/Invoicing, Wise (fallback rail), Persona, DocuSign (clickwrap fallback), **LiveKit/Daily** (SuperClass'ın medya katmanı), Retool (yalnız iç admin), Sentry/Checkly/PostHog, Crowdin.
- **Agent ilkesi:** LLM önerir, deterministik kod karar verir; **para yolunda LLM'in okuma erişimi bile yok.** Dispatch/backfill, session-logger, billing/payout tam deterministik; onboarding-wizard ve HR-onboarding hibrit.
- **Sert kısıtların karşılığı:** her biri insan disiplinine değil mekanizmaya bağlandı — migration disiplini CI'da boot+SELECT smoke ile, IDOR üç katmanla (scopedQuery + RLS + CI cross-tenant süiti), oturum 10 dk JWT + 5 dk DB-tazeleme fail-closed, client crash zod-parse'lı tek apiClient + Sentry + Checkly sentetik prob ile.

## Faz-1'in tek cümlesi

90 günde, 3 mühendisle: 2 havuz (**Native ESL speaking club** $40–60/45dk-sınıf + Admission Strategist — strategist dosaj motoruna değil saat-bloğu modeliyle) + dispatch v1 (hold'lu guaranteed-dosage, otomatik backfill) + SuperClass + sıfır-insan para döngüsü (top-up→hold→settle→payout→fatura) + self-serve onboarding → 3–5 okul pilotu; **gerçek ücretli ilk ders 3–4. haftada** (Wizard-of-Oz), otomatik akış S4'te. İkinci inceleme gate'leri: **G0 safeguarding + para ters-yolu + A0 vendor gerçekliği** ([06](06-inceleme-addendum.md)).

## En riskli 3 varsayım (tam liste 03 §5)

1. **A1 — Okullar satışçısız, kartla prepaid öder** (MENA/TR'de PO/havale/pazarlık kültürüne rağmen). Deney: landing page + Stripe Payment Link, 10 okul, 1 hafta, sıfır kod.
2. **A2 — Admission strategist soğuk kanalda kapı açar** (land tezi). Deney: 20 okula tek-sayfa PDF, dönüşüm ≥%20 mi, 2 hafta, sıfır kod.
3. **A3 — Okullar sabit haftalık dosaj slotlarına dönem boyu commit edebilir.** Deney: 3 okulun gerçek takvimiyle spreadsheet simülasyonu + hafta 3–4'te Wizard-of-Oz gerçek dersler.

## Karar durumu → [04-acik-sorular.md](04-acik-sorular.md)

**10 sorunun 8'i karara bağlandı (kurucu, 2026-07-09) ve dokümanlara işlendi:** **(1)** SuperClass var ama API eksik → S1 API-gap spike'ı medya kararını verir, eksik API'ler S4'te eklenir; **(2)** eski Scholege'den tamamen ayrı — tek seferlik eğitmen import'u, sıfır runtime bağımlılık; **(3)** US entity + kart default + wire fallback — ledger gün-1'den pending/settled top-up ayrımıyla; **(4)** İSİMLİ öğrenci roster'ı + öğrenci-bazlı yoklama (öneri reddedildi) → çocuk-PII compliance paketi gün-1 zorunlu (03 §4 v3); **(6)** SLA + iptal/no-show matrisi sayılarıyla ONAYLI — S3 bloğu kalktı; **(8)** vetting = Persona herkese + Checkr US-resident, üçlü resmi tanım sözleşmeye girer; **(9)** Faz-1 İngilizce, sonrası geniş locale yol haritası (tr, ar, zh, ru, ja, ko vb.) → altyapı gün-1'den RTL- VE CJK-safe; **(10)** hibrit pilot — Faz-1 çıkışı: en az 1 okul insan-temassız onboard.

**Bekleyen veri girdileri (karar değil, kod yazmayı bloklamaz):** eğitmen arzının kayıt kaynağı + pool bazında sayılar + non-circumvention durumu (#5, S2'den önce); eğitmen ülke dağılımı (#7, S5 rail ağırlığından önce); pilot okul listesi (#10); eski sistemden import alan listesi (#2); fatura kesen tüzel kişilik + minimum top-up onayı (#3).
