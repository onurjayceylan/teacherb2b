// Login'siz eğitmen onboarding'i (public): davet token'ı TEK yetki kapısıdır.
// Her uç token'ı getTeacherByInviteToken ile çözer; eşleşme yoksa NOT_FOUND —
// geçersiz/expired/revoked ayrımı dışarı sızdırılmaz. İş kuralları @teachernow/hr'da.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  advanceStatus,
  getTeacherByInviteToken,
  payoutDetailsSchema,
  setPayoutDetails as hrSetPayoutDetails,
  timezoneSchema,
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
      message: "Invite not found — the link may be invalid, expired, or revoked.",
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

export interface MaskedPayoutDetails {
  method: "wise_email" | "iban";
  maskedValue: string;
  accountHolder: string;
}

/**
 * Payout hesap bilgisi API'den ASLA açık dönmez: method + değerin son 4 karakteri.
 * (Ham değer yalnız platform bağlamındaki payout CSV export'unda kullanılır.)
 */
export function maskPayoutDetails(raw: unknown): MaskedPayoutDetails | null {
  if (raw === null || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const method = d.method;
  const value = typeof d.value === "string" ? d.value : "";
  const holder =
    typeof d.accountHolder === "string"
      ? d.accountHolder
      : typeof d.account_holder === "string"
        ? d.account_holder
        : "";
  if ((method !== "wise_email" && method !== "iban") || value.length === 0) return null;
  return { method, maskedValue: `••••${value.slice(-4)}`, accountHolder: holder };
}

/** Eğitmenin kayıtlı payout bilgisini maskeli okur (platform bağlamında). */
export async function readMaskedPayoutDetails(
  db: Db,
  teacherId: string,
): Promise<MaskedPayoutDetails | null> {
  const res = await db.query<{ payout_details: unknown }>(
    "SELECT payout_details FROM teacher WHERE id = $1",
    [teacherId],
  );
  return maskPayoutDetails(res.rows[0]?.payout_details ?? null);
}

export const teacherOnboardingRouter = router({
  get: publicProcedure
    .input(z.object({ token: tokenSchema }))
    .query(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const teacher = await requireTeacherByToken(db, input.token);
        return {
          ...summarize(teacher),
          payoutDetails: await readMaskedPayoutDetails(db, teacher.teacherId),
        };
      });
    }),

  submitProfile: publicProcedure
    .input(
      z.object({
        token: tokenSchema,
        phone: z.string().trim().min(5).max(40).optional(),
        country: z.string().trim().length(2).toUpperCase().optional(),
        // IANA doğrulamalı (denetim P1): bozuk tz eğitmenin ders saatlerini kaydırır.
        timezone: timezoneSchema.optional(),
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

  // Payout hesabı (Wise e-postası / IBAN): onboarding'de OPSİYONEL — atlanabilir;
  // eksikse panel "Add your payout details" uyarısı gösterir, CSV'de kolon boş çıkar.
  // Doğrulama + yazım @teachernow/hr'da (payoutDetailsSchema + setPayoutDetails).
  setPayoutDetails: publicProcedure
    .input(z.object({ token: tokenSchema, details: payoutDetailsSchema }))
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const teacher = await requireTeacherByToken(db, input.token);
        await hrSetPayoutDetails(db, teacher.teacherId, input.details);
        return { ok: true as const, payoutDetails: maskPayoutDetails(input.details) };
      });
    }),
});
