// HR hatırlatma taraması: 3+ gündür 'missing'/'rejected' evrakı bekleyen eğitmenler
// için audit_log'a 'hr_reminder_due' kaydı yazar. E-posta gönderimi Resend anahtarı
// gelince bu kayıtlara bağlanacak — şimdilik yalnız kalıcı iz (kayıt = tek gerçek).
// Spam koruması: aynı eğitmen için son 24 saatte kayıt varsa yenisi yazılmaz.
import type { ActorPool } from "@teachernow/db";

export interface HrRemindersResult {
  reminded: number;
}

export async function runHrReminders(pool: ActorPool): Promise<HrRemindersResult> {
  return pool.withPlatform(async (db) => {
    const res = await db.query(
      `WITH due AS (
         SELECT d.teacher_id, jsonb_agg(d.kind ORDER BY d.kind) AS kinds
           FROM teacher_document d
           JOIN teacher t ON t.id = d.teacher_id
          WHERE d.status IN ('missing', 'rejected')
            -- updated_at = son durum değişikliği; seed'de created_at ile aynıdır
            AND d.updated_at < now() - interval '3 days'
            AND t.status NOT IN ('rejected', 'suspended')
            AND NOT EXISTS (
              SELECT 1
                FROM audit_log a
               WHERE a.action = 'hr_reminder_due'
                 AND a.entity_type = 'teacher'
                 AND a.entity_id = d.teacher_id
                 AND a.occurred_at > now() - interval '24 hours'
            )
          GROUP BY d.teacher_id
       )
       INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, after)
       SELECT 'agent', 'hr_reminder_due', 'teacher', due.teacher_id,
              jsonb_build_object('missing_kinds', due.kinds)
         FROM due`,
    );
    return { reminded: res.rowCount ?? 0 };
  });
}
