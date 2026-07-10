// Eğitmen/HR hattı (yalnız platform): pipeline, davet, toplu import, evrak durumu,
// İK görüşmesi. İş kuralları @teachernow/hr modülünde — burada yalnız giriş doğrulama + yetki.
import { z } from "zod";
import {
  advanceStatus,
  completeInterview,
  createInviteToken,
  importTeachers,
  inviteTeacher,
  listPipeline,
  missingDocuments,
  revokeInviteTokens,
  scheduleInterview,
  upsertDocument,
} from "@teachernow/hr";
import { platformProcedure, router } from "../trpc";

const sourceSchema = z.enum(["site", "ilan", "hrmasterz"]);
const statusSchema = z.enum([
  "invited",
  "profile",
  "docs_pending",
  "interview",
  "active",
  "rejected",
  "suspended",
]);
const documentKindSchema = z.enum([
  "contract",
  "id_verification",
  "country_clearance",
  "tax_form",
  "payout_method",
]);
const documentStatusSchema = z.enum(["missing", "submitted", "verified", "rejected", "expired"]);

export const hrRouter = router({
  pipeline: platformProcedure
    .input(z.object({ status: statusSchema.optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) =>
        listPipeline(db, input?.status ? { status: input.status } : {}),
      );
    }),

  invite: platformProcedure
    .input(
      z.object({
        fullName: z.string().trim().min(2).max(200),
        email: z.string().trim().email().max(320),
        phone: z.string().trim().min(5).max(40).optional(),
        country: z.string().trim().length(2).toUpperCase().optional(),
        timezone: z.string().trim().max(64).optional(),
        source: sourceSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const id = await ctx.pool.withPlatform(async (db) =>
        inviteTeacher(db, {
          fullName: input.fullName,
          email: input.email,
          source: input.source,
          invitedBy: ctx.actor.userId,
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.country ? { country: input.country } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
        }),
      );
      return { id };
    }),

  // Onboarding davet linki: ham token yalnız dönen URL'de yaşar (DB'de hash durur).
  createInvite: platformProcedure
    .input(z.object({ teacherId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { token } = await ctx.pool.withPlatform(async (db) =>
        createInviteToken(db, { teacherId: input.teacherId, createdBy: ctx.actor.userId }),
      );
      const base = (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3010").replace(/\/+$/, "");
      return { url: `${base}/egitmen/davet/${token}` };
    }),

  revokeInvites: platformProcedure
    .input(z.object({ teacherId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const revoked = await ctx.pool.withPlatform(async (db) =>
        revokeInviteTokens(db, input.teacherId),
      );
      return { revoked };
    }),

  import: platformProcedure
    .input(
      z.object({
        rows: z
          .array(
            z.object({
              fullName: z.string().trim().min(2).max(200),
              email: z.string().trim().email().max(320),
              country: z.string().trim().length(2).toUpperCase().optional(),
            }),
          )
          .min(1)
          .max(500),
        source: sourceSchema,
        dispatchReady: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) =>
        importTeachers(
          db,
          input.rows.map((r) => ({
            fullName: r.fullName,
            email: r.email,
            source: input.source,
            ...(r.country ? { country: r.country } : {}),
          })),
          input.dispatchReady === undefined ? {} : { dispatchReady: input.dispatchReady },
        ),
      );
    }),

  advanceStatus: platformProcedure
    .input(z.object({ teacherId: z.string().uuid(), to: statusSchema }))
    .mutation(async ({ ctx, input }) => {
      await ctx.pool.withPlatform(async (db) => advanceStatus(db, input));
      return { teacherId: input.teacherId, status: input.to };
    }),

  setDocument: platformProcedure
    .input(
      z.object({
        teacherId: z.string().uuid(),
        kind: documentKindSchema,
        status: documentStatusSchema,
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.pool.withPlatform(async (db) =>
        upsertDocument(db, {
          teacherId: input.teacherId,
          kind: input.kind,
          status: input.status,
          ...(input.note ? { note: input.note } : {}),
        }),
      );
      return { teacherId: input.teacherId, kind: input.kind, status: input.status };
    }),

  listMissingDocuments: platformProcedure
    .input(z.object({ teacherId: z.string().uuid().optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => missingDocuments(db, input?.teacherId));
    }),

  scheduleInterview: platformProcedure
    .input(z.object({ teacherId: z.string().uuid(), scheduledAt: z.string().datetime() }))
    .mutation(async ({ ctx, input }) => {
      const id = await ctx.pool.withPlatform(async (db) =>
        scheduleInterview(db, {
          teacherId: input.teacherId,
          scheduledAt: input.scheduledAt,
          interviewerUserId: ctx.actor.userId,
        }),
      );
      return { id };
    }),

  completeInterview: platformProcedure
    .input(
      z.object({
        interviewId: z.string().uuid(),
        experienceScore: z.number().int().min(1).max(5),
        energyScore: z.number().int().min(1).max(5),
        decision: z.enum(["accept", "reject", "hold"]),
        decidedPoolId: z.string().uuid().optional(),
        notes: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.pool.withPlatform(async (db) =>
        completeInterview(db, {
          interviewId: input.interviewId,
          experienceScore: input.experienceScore,
          energyScore: input.energyScore,
          decision: input.decision,
          ...(input.decidedPoolId ? { decidedPoolId: input.decidedPoolId } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        }),
      );
      return { interviewId: input.interviewId, decision: input.decision };
    }),

  // Açık görüşmeler: sonuçlandırma formunun kaynağı (hr modülünde list API'si yok — salt-okur).
  listOpenInterviews: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{ id: string; teacher_id: string; full_name: string; scheduled_at: Date | null }>(
        `SELECT i.id, i.teacher_id, t.full_name, i.scheduled_at
           FROM hr_interview i
           JOIN teacher t ON t.id = i.teacher_id
          WHERE i.status = 'scheduled'
          ORDER BY i.scheduled_at NULLS LAST, i.created_at`,
      );
      return res.rows.map((r) => ({
        id: r.id,
        teacherId: r.teacher_id,
        teacherName: r.full_name,
        scheduledAt: r.scheduled_at,
      }));
    });
  }),

  listPools: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{ id: string; key: string; name: string }>(
        "SELECT id, key, name FROM pool WHERE active ORDER BY name",
      );
      return res.rows;
    });
  }),
});
