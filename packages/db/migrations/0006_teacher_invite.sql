-- 0006: eğitmen davet token'ı — login'siz onboarding akışının kapısı.
-- Ham token yalnız URL'de yaşar; DB'de SHA-256 hash'i durur (sızıntıda kullanılamaz).

CREATE TABLE teacher_invite (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  uuid NOT NULL REFERENCES teacher(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  first_used_at timestamptz,          -- audit; tek-kullanımlık değil (eğitmen akışa geri döner)
  revoked_at  timestamptz,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_teacher_invite_teacher ON teacher_invite (teacher_id);

ALTER TABLE teacher_invite ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_teacher_invite_platform ON teacher_invite FOR ALL TO role_platform USING (true);
GRANT SELECT, INSERT, UPDATE ON teacher_invite TO role_platform;
