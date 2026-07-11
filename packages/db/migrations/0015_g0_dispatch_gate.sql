-- 0015: G0 kapısı KODA taşınır (denetim-sonrası bulgu).
-- Plan (03-mvp-kapsam G0): reşit-olmayan içeren İLK ders, eğitmenin kimlik + ülke sabıka
-- belgesi 'verified' olmadan YAPILMAZ. Bugüne dek bu yalnız runbook disipliniydi; matcher
-- active+dispatch_ready+strike<3'e bakıyordu. Payout 5-evrak kapısıyla korunuyordu ama
-- DERS VERMEK korunmuyordu. Bu migration + matcher değişikliğiyle kural veritabanından beslenir.

-- Okul reşit-olmayan öğrenci içeriyor mu? Varsayılan TRUE (güvenli taraf) — MEV/Era içerir;
-- yalnız-yetişkin okul (örn. kurumsal dil sınıfı) admin'den kapatır.
ALTER TABLE school ADD COLUMN minors boolean NOT NULL DEFAULT true;

-- TÜRETİLİR (payout_ready gibi elle yazılmaz): kimlik + ülke sabıka belgeleri verified mi?
-- G0 dispatch kapısının veri tabanı; 5-evrak payout kapısından bilinçli olarak dar
-- (sözleşme/vergi/ödeme evrağı ders vermeyi değil parayı bloklar).
ALTER TABLE teacher ADD COLUMN safeguarding_ready boolean NOT NULL DEFAULT false;

-- Mevcut recompute fonksiyonu iki bayrağı birden türetecek şekilde genişler
-- (0005'teki trigger tanımı aynen geçerli kalır; yalnız fonksiyon gövdesi değişir).
CREATE OR REPLACE FUNCTION recompute_teacher_payout_ready() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t_id uuid := COALESCE(NEW.teacher_id, OLD.teacher_id);
  pay_ready boolean;
  sg_ready boolean;
BEGIN
  SELECT COUNT(*) FILTER (WHERE kind IN ('contract', 'id_verification', 'country_clearance', 'tax_form', 'payout_method')
                            AND status = 'verified') = 5,
         COUNT(*) FILTER (WHERE kind IN ('id_verification', 'country_clearance')
                            AND status = 'verified') = 2
    INTO pay_ready, sg_ready
    FROM teacher_document WHERE teacher_id = t_id;
  UPDATE teacher
     SET payout_ready = COALESCE(pay_ready, false),
         safeguarding_ready = COALESCE(sg_ready, false),
         updated_at = now()
   WHERE id = t_id;
  RETURN NULL;
END $$;

-- Mevcut eğitmenler için geriye dönük doldurma (trigger yalnız yeni doc olaylarında koşar).
UPDATE teacher t
   SET safeguarding_ready = COALESCE(sub.ready, false)
  FROM (SELECT teacher_id,
               COUNT(*) FILTER (WHERE kind IN ('id_verification', 'country_clearance')
                                  AND status = 'verified') = 2 AS ready
          FROM teacher_document GROUP BY teacher_id) sub
 WHERE sub.teacher_id = t.id
   AND t.safeguarding_ready IS DISTINCT FROM COALESCE(sub.ready, false);
