-- 0004: better-auth çekirdek şeması — auth_user / auth_session / auth_account / auth_verification
-- better-auth kolon adları camelCase'tir; kolonlar çift tırnakla AYNEN yaratılır
-- (better-auth config'indeki modelName eşlemeleri bu tablolara işaret eder).
--
-- GÜVENLİK: bu tablolar PII + kimlik sırları (parola hash'i, oturum token'ı) içerir.
-- role_school / role_platform'a HİÇBİR grant verilmez — yalnız owner bağlantısı
-- (better-auth'un kendi pg Pool'u) erişir. RLS yine de açılır (fail-closed savunma).

CREATE TABLE auth_user (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  email           text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image           text,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_session (
  id          text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token       text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId"    text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE
);
CREATE INDEX idx_auth_session_user ON auth_session ("userId");

CREATE TABLE auth_account (
  id                      text PRIMARY KEY,
  "accountId"             text NOT NULL,
  "providerId"            text NOT NULL,
  "userId"                text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope                   text,
  password                text,
  "createdAt"             timestamptz NOT NULL DEFAULT now(),
  "updatedAt"             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_account_user ON auth_account ("userId");

CREATE TABLE auth_verification (
  id           text PRIMARY KEY,
  identifier   text NOT NULL,
  value        text NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_verification_identifier ON auth_verification (identifier);

-- Fail-closed: RLS açık + hiçbir policy yok → owner dışındaki roller (grant verilse bile)
-- satır göremez. role_school/role_platform'a zaten tablo grant'i de verilmiyor.
ALTER TABLE auth_user         ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session      ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_account      ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_verification ENABLE ROW LEVEL SECURITY;
