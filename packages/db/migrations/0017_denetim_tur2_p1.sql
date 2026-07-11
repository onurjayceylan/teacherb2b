-- 0017: İkinci denetimin (docs/denetim-3-rol-tur2.md) kalan P1 düzeltmeleri için şema.
-- P1-H: reçeteye "ders bağlantısı" (okulun Zoom/Meet linki) — ders odası + projeksiyon +
-- program bunu gösterir; 12 öğrenci ve Manila'daki eğitmenin nerede buluşacağı belli olur.
-- (P1-C kill-switch izi, P1-E öğrenci arşivi, P1-F itiraz kilidi, P1-G panel — kod seviyesinde;
--  student.status 'removed' ve session_dispute.status zaten mevcut, migration gerekmiyor.)

ALTER TABLE dosage_plan ADD COLUMN lesson_link text;

-- Link okul verisidir; okul bağlamında (role_school) OKUNUR ve YAZILIR. 0011 kolon-kapsamlı
-- grant'i lesson_link'i içermiyordu — ekonomi kolonu OLMADIĞI için okula SELECT+UPDATE veriyoruz.
GRANT SELECT (lesson_link), UPDATE (lesson_link) ON dosage_plan TO role_school;
