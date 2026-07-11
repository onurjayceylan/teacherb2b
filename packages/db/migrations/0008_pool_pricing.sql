-- 0008: pool fiyat kartı — reçete fiyatının tek kaynağı (kurucu onaylı #12: native ESL
-- $40-60/45dk satış, maliyet $14-18/45dk). Reçete oluşturulurken buradan SNAPSHOT alınır;
-- kart güncellenirse yalnız YENİ reçeteler etkilenir (zam mevcut taahhüde ulaşamaz).

ALTER TABLE pool ADD COLUMN sell_per_lesson_cents bigint;
ALTER TABLE pool ADD COLUMN pay_per_lesson_cents  bigint;
ALTER TABLE pool ADD COLUMN lesson_minutes        int NOT NULL DEFAULT 45;

UPDATE pool SET sell_per_lesson_cents = 4000, pay_per_lesson_cents = 1600 WHERE key = 'native_esl';
UPDATE pool SET sell_per_lesson_cents = 13000, pay_per_lesson_cents = 6000, lesson_minutes = 60
  WHERE key = 'admission_strategist';

ALTER TABLE pool ALTER COLUMN sell_per_lesson_cents SET NOT NULL;
ALTER TABLE pool ALTER COLUMN pay_per_lesson_cents  SET NOT NULL;
-- Negatif marj fiyat kartında da yapısal imkânsız:
ALTER TABLE pool ADD CONSTRAINT pool_margin_check
  CHECK (pay_per_lesson_cents >= 0 AND pay_per_lesson_cents <= sell_per_lesson_cents);

-- Okul fiyat kartının satış yüzünü görür; maliyet (pay_per_lesson_cents) KAPALI kalır.
GRANT SELECT (sell_per_lesson_cents, lesson_minutes) ON pool TO role_school;
