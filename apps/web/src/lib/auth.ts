// better-auth sunucu örneği.
// Kimlik tabloları (auth_*) PII + sır içerir: role_school/role_platform grant'i YOK,
// better-auth bu tablolara owner bağlantısıyla (kendi pg Pool'u) erişir.
import { betterAuth } from "better-auth";
import pg from "pg";
import { getPool } from "./pool";

const g = globalThis as typeof globalThis & { __teachernowAuthPgPool?: pg.Pool };

function authPgPool(): pg.Pool {
  if (!g.__teachernowAuthPgPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL gerekli (kök .env, next.config.ts ile yüklenir)");
    g.__teachernowAuthPgPool = new pg.Pool({ connectionString: url, max: 5 });
  }
  return g.__teachernowAuthPgPool;
}

// Sosyal sağlayıcılar yalnız env anahtarları tanımlıysa eklenir (dev/pilotta kapalı kalabilir).
const socialProviders: {
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string; clientSecret: string };
} = {};
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  socialProviders.google = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  };
}
if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
  socialProviders.microsoft = {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  };
}

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3010",
  ...(process.env.BETTER_AUTH_SECRET ? { secret: process.env.BETTER_AUTH_SECRET } : {}),
  database: authPgPool(),
  // Dev/pilot: e-posta + parola; sosyal girişler anahtar varsa yukarıda açılır.
  emailAndPassword: { enabled: true },
  socialProviders,
  session: {
    modelName: "auth_session",
    expiresIn: 60 * 60 * 24 * 30, // 30 gün
    updateAge: 60 * 60 * 24, // 24 saat
    // 5 dk cookie cache: DB'ye her istekte gitmez; pasifleştirilen kullanıcı en geç
    // 5 dk'da düşer (fail-closed ilkesi — tRPC context ayrıca app_user.status kontrol eder).
    cookieCache: { enabled: true, maxAge: 300 },
  },
  user: { modelName: "auth_user" },
  account: { modelName: "auth_account" },
  verification: { modelName: "auth_verification" },
  databaseHooks: {
    user: {
      create: {
        // JIT provisioning: better-auth kullanıcısı yaratılınca app_user satırı açılır.
        // Mevcut kullanıcı ezilmez (ON CONFLICT DO NOTHING) — tenancy upsert'iyle uyumlu.
        after: async (user) => {
          await getPool().withPlatform(async (db) => {
            await db.query(
              "INSERT INTO app_user (email, name) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING",
              [user.email, user.name ?? null],
            );
          });
        },
      },
    },
  },
});
