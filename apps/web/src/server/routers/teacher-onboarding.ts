// Login'siz eğitmen onboarding'i (public): davet token'ı TEK yetki kapısıdır.
// Her uç token'ı getTeacherByInviteToken ile çözer; eşleşme yoksa NOT_FOUND —
// geçersiz/expired/revoked ayrımı dışarı sızdırılmaz. İş kuralları @teachernow/hr'da.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  advanceStatus,
  getTeacherByInviteToken,
  upsertDocument,
  type InviteTokenTeacher,
} from "@teachernow/hr";
import type { Db } from "@teachernow/db";
import { publicProcedure, router } from "../trpc";

// Biçim doğrulaması kasten gevşek: bozuk token da NOT_FOUND üretmeli (BAD_REQUEST değil).
const tokenSchema = z.string().trim().min(1).max(200);

// Sözleşme bu listede YOK — o clickwrap ucundan geçer; doğrulama admin'de kalır.
const declarableKindSchema = z.enum([
  "id_verification",
  "country_clearance",
  "tax_form",
  "payout_method",
]);

async function requireTeacherByToken(db: Db, token: string): Promise<InviteTokenTeacher> {
  const teacher = await getTeacherByInviteToken(db, token);
  if (!teacher) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Davet bulunamadı — bağlantı geçersiz, süresi dolmuş ya da iptal edilmiş olabilir.",
    });
  }
  return teacher;
}

export type OnboardingStep = "profile" | "contract" | "documents" | "review";

/** Eğitmenin akışta hangi adımda olduğunu durum + evraklardan türetir. */
function currentStep(t: InviteTokenTeacher): OnboardingStep {
  if (t.status === "invited") return "profile";
  const contract = t.documents.find((d) => d.kind === "contract");
  const contractDone =
    contract !== undefined && (contract.status === "submitted" || contract.status === "verified");
  if (!contractDone) return "contract";
  const open = t.documents.some(
    (d) =>
      d.kind !== "contract" &&
      (d.status === "missing" || d.status === "rejected" || d.status === "expired"),
  );
  return open ? "documents" : "review";
}

function summarize(t: InviteTokenTeacher) {
  return { ...t, step: currentStep(t) };
}

export const teacherOnboardingRouter = router({
  get: publicProcedure
    .input(z.object({ token: tokenSchema }))
    .query(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const teacher = await requireTeacherByToken(db, input.token);
        return summarize(teacher);
      });
    }),

  submitProfile: publicProcedure
    .input(
      z.object({
        token: tokenSchema,
        phone: z.string().trim().min(5).max(40).optional(),
        country: z.string().trim().length(2).toUpperCase().optional(),
        timezone: z.string().trim().min(1).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const teacher = await requireTeacherByToken(db, input.token);
        await db.query(
          `UPDATE teacher SET
             phone      = COALESCE($2, phone),
             country    = COALESCE($3, country),
             timezone   = COALESCE($4, timezone),
             updated_at = now()
           WHERE id = $1`,
          [
            teacher.teacherId,
            input.phone ?? null,
            input.country ?? null,
            input.timezone ?? null,
          ],
        );
        if (teacher.status === "invited") {
          await advanceStatus(db, { teacherId: teacher.teacherId, to: "profile" });
        }
        return { ok: true };
      });
    }),

  acceptContract: publicProcedure
    .input(z.object({ token: tokenSchema, typedName: z.string().trim().min(2).max(200) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const teacher = await requireTeacherByToken(db, input.token);
        // PII minimizasyonu: istek IP'si KAYDEDİLMEZ. Kabul kanıtı = yazılan ad + ISO zaman.
        await upsertDocument(db, {
          teacherId: teacher.teacherId,
          kind: "contract",
          status: "submitted",
          vendor: "clickwrap",
          note: `Kabul: ${input.typedName} — ${new Date().toISOString()}`,
        });
        if (teacher.status === "profile") {
          await advanceStatus(db, { teacherId: teacher.teacherId, to: "docs_pending" });
        }
        return { ok: true };
      });
    }),

  declareDocument: publicProcedure
    .input(
      z.object({
        token: tokenSchema,
        kind: declarableKindSchema,
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const teacher = await requireTeacherByToken(db, input.token);
        // Eğitmen beyanı yalnız 'submitted' yazar; 'verified'a çekmek admin yetkisinde kalır.
        await upsertDocument(db, {
          teacherId: teacher.teacherId,
          kind: input.kind,
          status: "submitted",
          vendor: "beyan",
          ...(input.note ? { note: input.note } : {}),
        });
        return { ok: true };
      });
    }),
});
