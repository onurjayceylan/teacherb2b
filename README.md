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

- ✅ Mimari, veri modeli ve MVP kapsamı **karar** statüsünde; 8 kurucu kararı işlendi.
- ⏳ Bekleyen veri girdileri (kodu bloklamaz): eğitmen kayıt kaynağı + sayılar, ülke dağılımı, pilot okul listesi, tüzel kişilik + minimum top-up.
- ⬜ Sıradaki iş: S1 iskeleti — pnpm monorepo + CI kapıları (migration smoke, cross-tenant süiti, dependency-cruiser, pii-linter) + better-auth/tenancy/RLS + ledger çekirdeği + Stripe Checkout. Gün-1 kod-dışı iş: vendor başvuruları (Stripe Connect, Wise, Persona, DocuSign).
