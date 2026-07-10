// Wizard-of-Oz manuel ders kaydı (platform): okul cüzdanından satış düşer,
// eğitmen alacağı ledger'a maliyet olarak işlenir. Yalnız admin gözü.
import { z } from "zod";
import { chargeManualLesson } from "@teachernow/billing";
import { platformProcedure, router } from "../trpc";

export const lessonsRouter = router({
  listSchools: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{ id: string; name: string }>(
        "SELECT id, name FROM school ORDER BY name",
      );
      return res.rows;
    });
  }),

  // Yalnız admin gözü: eğitmen adları okul yüzüne bu router'dan SIZMAZ (platformProcedure).
  listActiveTeachers: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{ id: string; full_name: string }>(
        "SELECT id, full_name FROM teacher WHERE status = 'active' ORDER BY full_name",
      );
      return res.rows.map((r) => ({ id: r.id, fullName: r.full_name }));
    });
  }),

  chargeManual: platformProcedure
    .input(
      z
        .object({
          schoolId: z.string().uuid(),
          teacherId: z.string().uuid(),
          classGroupId: z.string().uuid().optional(),
          lessonDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "tarih YYYY-AA-GG olmalı"),
          minutes: z.number().int().min(1).max(600),
          chargeCents: z.number().int().min(1),
          teacherPayCents: z.number().int().min(0),
          note: z.string().trim().max(500).optional(),
        })
        .refine((v) => v.teacherPayCents <= v.chargeCents, {
          message: "eğitmen ücreti satış tutarını aşamaz",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) =>
        chargeManualLesson(db, {
          schoolId: input.schoolId,
          teacherId: input.teacherId,
          lessonDate: input.lessonDate,
          minutes: input.minutes,
          chargeCents: input.chargeCents,
          teacherPayCents: input.teacherPayCents,
          createdBy: ctx.actor.userId,
          ...(input.classGroupId ? { classGroupId: input.classGroupId } : {}),
          ...(input.note ? { note: input.note } : {}),
        }),
      );
    }),
});
