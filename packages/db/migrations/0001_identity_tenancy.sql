-- 0001: uzantılar, DB rolleri, kimlik + tenancy çekirdeği, RLS
-- Kural (02-veri-modeli §0): kolon önce burada doğrulanır, sonra TS şemasına girer.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- Aktör rolleri (NOLOGIN): bağlantı havuzu istek başına SET LOCAL ROLE yapar.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'role_platform') THEN
    CREATE ROLE role_platform NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'role_school') THEN
    CREATE ROLE role_school NOLOGIN;
  END IF;
END $$;
GRANT role_platform, role_school TO CURRENT_USER;

-- Üyelik-temelli tenancy GUC'u: oturum açılışında aktörün erişebildiği okul kümesi.
CREATE OR REPLACE FUNCTION app_school_ids() RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    string_to_array(NULLIF(current_setting('app.school_ids', true), ''), ',')::uuid[],
    '{}'::uuid[]
  );
$$;

-- Append-only zorlaması: bu fonksiyona bağlanan tabloda UPDATE/DELETE fiziksel imkânsız.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only tablo: % üzerinde % yasak; düzeltme = ters kayıt',
    TG_TABLE_NAME, TG_OP USING ERRCODE = 'raise_exception';
END $$;

CREATE TABLE organization (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'school_owner'
             CHECK (kind IN ('school_owner', 'distributor')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE school (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  name            text NOT NULL,
  country         text NOT NULL DEFAULT 'TR',
  timezone        text NOT NULL DEFAULT 'Europe/Istanbul',
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'suspended', 'closed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_school_org ON school (organization_id);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,                 -- PII
  name          text,                                   -- PII
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  token_version int  NOT NULL DEFAULT 1,                -- bump = tüm JWT'ler fail-closed düşer
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE school_user (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id  uuid NOT NULL REFERENCES school(id),
  user_id    uuid NOT NULL REFERENCES app_user(id),
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'finance', 'coordinator')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, user_id)
);
CREATE INDEX idx_school_user_user ON school_user (user_id);

CREATE TABLE platform_admin (
  user_id    uuid PRIMARY KEY REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Audit: append-only, gün-1'den partitioned (aylık; DEFAULT partition güvenlik ağı).
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_kind  text NOT NULL CHECK (actor_kind IN
              ('school_user', 'teacher_user', 'platform_admin', 'agent', 'system', 'webhook')),
  actor_id    uuid,
  school_id   uuid,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  request_id  text,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, occurred_at);
CREATE INDEX idx_audit_school ON audit_log (school_id, occurred_at);
CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---- RLS ----
ALTER TABLE school      ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_user ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_school_self ON school FOR ALL TO role_school
  USING (id = ANY (app_school_ids()));
CREATE POLICY p_school_platform ON school FOR ALL TO role_platform USING (true);

CREATE POLICY p_school_user_self ON school_user FOR ALL TO role_school
  USING (school_id = ANY (app_school_ids()));
CREATE POLICY p_school_user_platform ON school_user FOR ALL TO role_platform USING (true);

-- ---- Grant'ler ----
GRANT USAGE ON SCHEMA public TO role_platform, role_school;
GRANT SELECT, INSERT, UPDATE ON organization, school, app_user, school_user TO role_platform;
GRANT SELECT ON platform_admin TO role_platform;
GRANT INSERT ON platform_admin TO role_platform;
GRANT SELECT ON school, school_user TO role_school;
GRANT UPDATE (name, timezone, updated_at) ON school TO role_school;
GRANT SELECT (id, email, name, status) ON app_user TO role_school;
GRANT INSERT ON audit_log TO role_platform, role_school;
GRANT SELECT ON audit_log TO role_platform;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO role_platform, role_school;
