# Teachernow

**B2B eğitmen dispatch işletim sistemi** *(plan dokümanlarındaki çalışma adı: Scholege Lite)*

Düşük-maliyet + AI-destekli eğitmen havuzlarını özel okullara toptan satan "tedarikçi + yazılım" platformu. Okul son kilometreyi (öğrenci ilişkisi, veliye satış) kendi yönetir; biz operatör değil, **dispatch OS**'iz.

## Plan paketi → [docs/plan/](docs/plan/)

| Doküman | İçerik |
|---|---|
| [00-master-plan.md](docs/plan/00-master-plan.md) | **Buradan başla:** ne/nasıl, süreç-süreç otomasyon haritası, maliyet analizi, 1-kişi-vs-10-kişi ops kaldıraç hesabı, mimari + diller, karar günlüğü |
| [01-mimari.md](docs/plan/01-mimari.md) | Sertleştirilmiş modüler monolit: stack, tenancy, para/ledger, dispatch motoru, video, agent'lar, authz, reddedilen alternatifler |
| [02-veri-modeli.md](docs/plan/02-veri-modeli.md) | DDL düzeyinde veri modeli (çift-kayıt ledger, hold, payout iki-faz, RLS) — 57 adversarial bulgu işlenmiş |
| [03-mvp-kapsam.md](docs/plan/03-mvp-kapsam.md) | Faz-1 (0–90 gün) bağlayıcı yürütme planı: 6 sprint, iptal/no-show matrisi, riskli varsayımlar, gizli-ops envanteri, pilot metrikleri |
| [04-acik-sorular.md](docs/plan/04-acik-sorular.md) | Karar günlüğü: 10 sorunun 8'i karara bağlı; kalan veri girdileri |
| [05-kapsam-elestirisi.md](docs/plan/05-kapsam-elestirisi.md) | Kapsam v1'in bağımsız eleştiri turu (arşiv) |
| [INDEX.md](docs/plan/INDEX.md) | Plan paketinin üretim süreci + karar özeti |

## Durum

- ✅ **Faz-1 mühendislik kapsamı (S1–S6) TAMAM** — 102 test / 10 paket, CI 6/6 yeşil.
  Çekirdek: çift-kayıt ledger + kill-switch + invariant nöbetçileri · self-serve okul
  kaydı + kart/havale cüzdan · HR hattı (login'siz eğitmen onboarding'i + 5-evrak payout
  hard-gate + İK görüşmesi) · dispatch (hold'lu reçete→slot→teklif + iptal/no-show matrisi
  + backfill SLA iadesi) · ders→yoklama→otomatik settle→itiraz/iade · payout (Wise-manuel
  + sonuç-dosyası mutabakatı) · ekstre + eğitmen paneli · /baslangic sihirbazı + funnel ·
  /admin/metrikler · sentetik prob.
- 🚀 **Deploy:** [docs/deploy.md](docs/deploy.md) (Render blueprint: `render.yaml`) ·
  **Pilot açılışı:** [docs/pilot-runbook.md](docs/pilot-runbook.md) (MEV · Era · Dream Big)
- ⏳ Vendor anahtarları bekleniyor (kod hazır): Stripe, Google/Microsoft OAuth, Checkly,
  Resend, Sentry, Persona/DocuSign webhook'ları, hrmasterz API (CSV çalışıyor).
- 🧭 Geliştirme: [docs/dev-setup.md](docs/dev-setup.md)
