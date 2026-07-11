// Merkezi İK görüşmesi: zorunlu insan adımı. Karar 'accept' ise eğitmen
// interview→active geçer (trigger doğrular) ve istenirse havuza eklenir.
import type { Db } from "@teachernow/db";

export interface ScheduleInterviewInput {
  teacherId: string;
  /** ISO-8601 zaman damgası. */
  scheduledAt: string;
  interviewerUserId?: string;
}

export async function scheduleInterview(db: Db, input: ScheduleInterviewInput): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO hr_interview (teacher_id, scheduled_at, interviewer_user_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [input.teacherId, input.scheduledAt, input.interviewerUserId ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error("scheduleInterview: hr_interview INSERT satır dönmedi");
  return row.id;
}

export type InterviewDecision = "accept" | "reject" | "hold";

export interface CompleteInterviewInput {
  interviewId: string;
  experienceScore: number;
  energyScore: number;
  decision: InterviewDecision;
  decidedPoolId?: string;
  notes?: string;
}

/**
 * Görüşmeyi 'done' + skorlarla kapatır ve karara göre eğitmeni ilerletir:
 * accept → interview→active + dispatch_ready=true (görüşmeden geçen eğitmen teklif
 *          alabilmeli — P0 bulgusu: bayrak açılmadığı için davetli eğitmen asla teklif
 *          alamıyordu) (+ decidedPoolId verildiyse havuz üyeliği),
 * reject → teacher 'rejected', hold → yalnız kayıt.
 * Durum-makinesi tuzağı: eğitmen hâlâ 'docs_pending' ise (görüşme yapılmış demek)
 * önce 'interview'a ilerletilir — trigger whitelist'i docs_pending→interview→active'i
 * destekler; doğrudan docs_pending→active geçersizdi.
 */
export async function completeInterview(db: Db, input: CompleteInterviewInput): Promise<void> {
  const res = await db.query<{ teacher_id: string }>(
    `UPDATE hr_interview
        SET status = 'done',
            experience_score = $2,
            energy_score     = $3,
            decision         = $4,
            decided_pool_id  = COALESCE($5, decided_pool_id),
            notes            = COALESCE($6, notes),
            updated_at       = now()
      WHERE id = $1
      RETURNING teacher_id`,
    [
      input.interviewId,
      input.experienceScore,
      input.energyScore,
      input.decision,
      input.decidedPoolId ?? null,
      input.notes ?? null,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`completeInterview: görüşme bulunamadı: ${input.interviewId}`);

  if (input.decision === "accept") {
    const statusRes = await db.query<{ status: string }>(
      "SELECT status FROM teacher WHERE id = $1 FOR UPDATE",
      [row.teacher_id],
    );
    const current = statusRes.rows[0]?.status;
    if (!current) {
      throw new Error(`completeInterview: eğitmen bulunamadı: ${row.teacher_id}`);
    }
    if (current === "docs_pending") {
      // Görüşme tamamlandıysa görüşme yapılmıştır: ara adımı biz atarız ki
      // trigger'ın whitelist'i (docs_pending→interview→active) ihlal edilmesin.
      await db.query(
        `UPDATE teacher SET status = 'interview', updated_at = now() WHERE id = $1`,
        [row.teacher_id],
      );
    }
    await db.query(
      `UPDATE teacher SET status = 'active', dispatch_ready = true, updated_at = now() WHERE id = $1`,
      [row.teacher_id],
    );
    if (input.decidedPoolId) {
      await db.query(
        `INSERT INTO teacher_pool (teacher_id, pool_id)
         VALUES ($1, $2)
         ON CONFLICT (teacher_id, pool_id) DO NOTHING`,
        [row.teacher_id, input.decidedPoolId],
      );
    }
  } else if (input.decision === "reject") {
    await db.query(
      `UPDATE teacher SET status = 'rejected', updated_at = now() WHERE id = $1`,
      [row.teacher_id],
    );
  }
  // 'hold': yalnız görüşme kaydı güncellenir, eğitmen durumu değişmez.
}
