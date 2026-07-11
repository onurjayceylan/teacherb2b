-- 0011: S6 güvenlik doğrulama taramasının bulgusu (GERÇEK sızıntı) kapatılıyor.
-- Bulgu: 0007'de dosage_plan grant'inin kolon listesi yalnız UPDATE'e uygulanmıştı;
-- SELECT ve INSERT tablo düzeyinde kalmış → okul rolü eğitmen maliyet snapshot'ını
-- (teacher_pay_cents) okuyabiliyor ve INSERT'te keyfi değer yazabiliyordu.
-- Çözüm: fiyat snapshot'ı DB'de alınır (SECURITY DEFINER RPC); okul maliyet kolonunu
-- ne okuyabilir ne yazabilir.

CREATE OR REPLACE FUNCTION create_dosage_plan(
  p_school_id      uuid,
  p_class_group_id uuid,
  p_pool_id        uuid,
  p_weekday        int,
  p_start_minute   int,
  p_duration_min   int,      -- NULL → pool.lesson_minutes
  p_start_date     date,
  p_weeks          int,
  p_created_by     uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_pool record;
  v_tz   text;
  v_id   uuid;
BEGIN
  -- Tenant kapısı: okul bağlamında (app.school_ids dolu) yalnız kendi okulu;
  -- platform bağlamında (GUC boş) her okul. RPC yalnız uygulama rollerine EXECUTE'lu.
  IF app_school_ids() <> '{}'::uuid[] AND NOT (p_school_id = ANY (app_school_ids())) THEN
    RAISE EXCEPTION 'create_dosage_plan: bu okul için yetki yok';
  END IF;

  SELECT timezone INTO v_tz FROM school WHERE id = p_school_id AND status = 'active';
  IF v_tz IS NULL THEN
    RAISE EXCEPTION 'create_dosage_plan: okul bulunamadı ya da aktif değil';
  END IF;
  PERFORM 1 FROM class_group
    WHERE id = p_class_group_id AND school_id = p_school_id AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_dosage_plan: sınıf bu okula ait değil ya da pasif';
  END IF;
  SELECT sell_per_lesson_cents, pay_per_lesson_cents, lesson_minutes INTO v_pool
    FROM pool WHERE id = p_pool_id AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_dosage_plan: havuz bulunamadı ya da aktif değil';
  END IF;

  INSERT INTO dosage_plan
    (school_id, class_group_id, pool_id, weekday, start_minute, duration_min,
     school_tz, price_cents, teacher_pay_cents, start_date, weeks, created_by)
  VALUES
    (p_school_id, p_class_group_id, p_pool_id, p_weekday, p_start_minute,
     COALESCE(p_duration_min, v_pool.lesson_minutes), v_tz,
     v_pool.sell_per_lesson_cents, v_pool.pay_per_lesson_cents,
     p_start_date, p_weeks, p_created_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE SELECT, INSERT ON dosage_plan FROM role_school;
GRANT SELECT (id, school_id, class_group_id, pool_id, weekday, start_minute, duration_min,
              school_tz, price_cents, start_date, weeks, status, created_by, created_at, updated_at)
  ON dosage_plan TO role_school;
GRANT EXECUTE ON FUNCTION create_dosage_plan(uuid, uuid, uuid, int, int, int, date, int, uuid)
  TO role_school, role_platform;
