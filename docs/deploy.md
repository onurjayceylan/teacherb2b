# Deploy — Render (Faz-1 pilot)

Mimari karar (01-mimari): tek Docker imajı, iki proses modu (`MODE=web` / `MODE=worker`), Render managed Postgres 16. Migration release-phase'de app'ten önce koşar.

## 1. İlk kurulum (bir kez, ~20 dk)

1. [render.com](https://render.com) hesabı aç → **New → Blueprint** → bu repoyu bağla. `render.yaml` otomatik okunur: `teachernow-db` (Postgres 16) + `teachernow-web` + `teachernow-worker` oluşur.
2. İlk deploy bittiğinde web servisinin adresini al (örn. `https://teachernow-web.onrender.com`) ve iki env'i doldur (Render → teachernow-web → Environment):
   - `BETTER_AUTH_URL` = `https://<adres>`
   - `NEXT_PUBLIC_BASE_URL` = aynı değer → **redeploy** (NEXT_PUBLIC_* build'e gömülür).
3. **Postgres yedeği:** Render → teachernow-db → Backups → günlük otomatik yedek AÇIK olduğunu doğrula (basic-1gb planında dahil). İlk haftada bir kez restore tatbikatı yap (dev'de yaptığımızın aynısı).
4. **Platform admin ata** (Render → teachernow-db → Connect → PSQL):
   ```sql
   -- önce uygulamadan normal kayıt ol (e-posta+parola), sonra:
   INSERT INTO platform_admin (user_id)
   SELECT id FROM app_user WHERE email = 'senin@eposta.com';
   ```
5. **Banka hesaplarını gir** (kurucu kararı #11): `https://<adres>/admin` → Banka hesapları → EFT TL + SWIFT USD bilgilerini ekle. Okul top-up sayfasında talimatlar anında görünür.

## 2. Vendor bağlantıları (anahtar geldikçe — kod hazır)

| Vendor | Env / adım | Etkisi |
|---|---|---|
| Stripe | `STRIPE_SECRET_KEY` + Dashboard → Webhooks → endpoint: `https://<adres>/api/webhooks/stripe` (events: `checkout.session.completed`, `payment_intent.succeeded`) → `STRIPE_WEBHOOK_SECRET` | Kart top-up uçtan uca otomatik settle |
| Google/Microsoft OAuth | Client ID/Secret env'leri; redirect: `https://<adres>/api/auth/callback/google` (ve `/microsoft`) | Okullar Workspace/365 ile tek tık giriş |
| Checkly | `tools/synthetic-probe.mjs` içeriğini Checkly "API check"e taşı ya da cron'dan `BASE_URL=https://<adres> pnpm probe` koştur; **exit 2 = para donuk (kill-switch) — ayrı acil alarm** | 01-mimari §9: out-of-band nöbetçi |
| Sentry | `SENTRY_DSN` (paket kurulumu ayrı iş — bilinen S6-sonrası borç) | Client-crash görünürlüğü |

## 3. Doğrulama (her deploy sonrası)

```bash
BASE_URL=https://<adres> pnpm probe   # 4/4 OK beklenir
```
İlk kurulumdan sonra bir kez uçtan uca: kayıt → /baslangic sihirbazı → havale referansı → (admin) settle → reçete → slot+hold → teklif → ders → settle → /admin/metrikler'de sayılar.

## 4. Veri hijyeni

- **Prod her zaman taze DB ile başlar** — dev/test verisi (okul, eğitmen, ledger kaydı) prod'a ASLA taşınmaz; migration'lar şemayı kurar, veriyi kurucu + okullar üretir.
- Denetim bulgusu (3-rol): dev ortamında test okulları/eğitmenleri birikir; bunlar metrikleri kirletir. Prod'da "deneme" kaydı açmayın — gerekiyorsa ayrı bir staging deploy'u kullanın (ikinci Render blueprint'i, ayrı DB).
- Platform admin yönetimi şimdilik SQL iledir (`platform_admin` tablosu, §1 adım 4); admin ekleme/çıkarma UI'ı bilinçli olarak Faz-1 dışıdır (tek kurucu-operatör varsayımı).

## 5. Bilinen sınırlar / borçlar

- İmaj yalın değil (tam workspace); pilot ölçeğinde sorun değil, optimizasyon borç olarak kayıtlı.
- Worker `tsx` ile koşar (derleme adımı yok) — MVP kararı.
- `DATABASE_URL` Render'ın session-mode bağlantısıdır; **pgbouncer transaction-pooling KULLANMA** (01-mimari: advisory lock + SET LOCAL ROLE kırılır).
- E-posta (Resend) bağlanana dek eğitmen teklif/davet linkleri admin ekranından elle kopyalanıp iletilir.
