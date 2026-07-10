# Geliştirici Kurulumu

## Gereksinimler

- Node.js 22+
- pnpm 10 (`package.json` → `packageManager` alanı; `corepack enable` yeterli)
- PostgreSQL 16 (server + client araçları: `psql`, `createdb`)

## Lokal kurulum

```sh
pnpm install

# Postgres'i lokal başlat (örnek: kullanıcı dizininde bir cluster)
initdb -D ~/pgdata --auth=trust --username=postgres
pg_ctl -D ~/pgdata -l ~/pgdata/log start

# Geliştirme veritabanı
createdb -U postgres teachernow_dev
```

`.env` dosyası: `.env.example`'ı kopyala ve değerleri kendi ortamına göre doldur.

```sh
cp .env.example .env
```

- `DATABASE_URL` — migration'ların uygulanacağı geliştirme DB'si.
- `DATABASE_ADMIN_URL` — test koşucusunun **yeni veritabanları yaratabilmesi** için
  süper-yetkili bağlantı (ör. `postgres://postgres@localhost:5432/postgres`).

## Komutlar

| Komut | Ne yapar |
| --- | --- |
| `pnpm db:migrate` | Bekleyen SQL migration'ları uygular (idempotent — iki kez koşmak güvenlidir). `DATABASE_URL` ister. |
| `pnpm typecheck` | Tüm paketlerde `tsc --noEmit`. |
| `pnpm test` | Tüm paketlerde vitest. `DATABASE_ADMIN_URL` ister. |
| `pnpm lint:boundaries` | dependency-cruiser ile modül sınırı kuralları (döngü yok, packages→apps yok, testdb yalnız testlerden, ledger yalnız db'ye bağımlı). |
| `pnpm lint:pii` | Log satırlarında (console.* / logger.*) PII alan adı (email, iban, phone, tax_id, national_id) arar. Bilinçli muafiyet: satıra `// pii-ok`. |

## Test altyapısı

Her test dosyası `createTestDb()` ile **kendi taze veritabanını** alır: DB yaratılır,
migration'lar koşulur, test bitince `drop()` ile silinir. Testler birbirinin verisini
göremez; sıralamaya bağımlılık yoktur. Dönen `pool` (ActorPool) üzerindeki
`withPlatform` / `withSchool` / `withOwner` çağrılarının her biri kendi transaction'ıdır
ve doğru rol + `app.school_ids` GUC'u ile açılır.

## Migration disiplini

Şema değişikliğinin kaynağı **SQL migration'dır**, TS kodu değil:

1. Önce `packages/db/migrations/` altına numaralı SQL dosyasını yaz.
2. `pnpm db:migrate` ile lokal DB'de uygula, davranışı `psql` ile doğrula
   (kısıtlar, trigger'lar, RLS gerçekten çalışıyor mu?).
3. Ancak ondan sonra TS tarafına (tip/fonksiyon imzası) yansıt.

Migration dosyaları uygulandıktan sonra **değiştirilmez**; düzeltme yeni bir
migration ile gelir. CI, migration'ları iki kez koşarak idempotenceyi ve
`ledger_invariant_violations()` ile defter tutarlılığını doğrular.
