// Eğitmen paneli (login'siz, kalıcı imzalı link — davet deseninin devamı):
// getPanel token'ı her istekte DB'deki hash'le doğrular (getTeacherByPortalToken).
// Panel EĞİTMEN yüzüdür: kazanç bakiyesi (teacher_payable) + gelecek confirmed dersler
// (kendi tz'sinde) + son settle edilmiş dersler. Okulun ödediği fiyat ASLA dönmez.
// Link üretme/iptal yalnız platform admin ucudur.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createPortalToken,
  getTeacherByPortalToken,
  revokePortalTokens,
  signJoinToken,
} from "@teachernow/sessions";
import { teacherDropByTeacher } from "@teachernow/dispatch";
import { getTeacherPayouts } from "@teachernow/payouts";
import {
  payoutDetailsSchema,
  requestPortalLink,
  setPayoutDetails as hrSetPayoutDetails,
  timezoneSchema,
} from "@teachernow/hr";
import { platformProcedure, publicProcedure, router } from "../trpc";
import { joinSecret } from "./session";
import { maskPayoutDetails, readMaskedPayoutDetails } from "./teacher-onboarding";

const tokenSchema = z.string().trim().min(1).max(500);

/** 3 strike = suspend (teacherNoShow matrisi) — panelde "N/3" olarak gösterilir. */
export const STRIKE_LIMIT = 3;

// Modül hataları Türkçe üretebilir (backend alanı); eğitmen yüzü İngilizce olduğundan
// bilinen drop hataları burada çevrilir — bilinmeyenler olduğu gibi geçer (session.start deseni).
function englishDropError(raw: string): string {
  if (/not assigned to you/i.test(raw)) return "This lesson is not assigned to you.";
  if (/scheduled değil/.test(raw) || /confirmed atama yok/.test(raw)) {
    return "This lesson can no longer be dropped — it may have started, been cancelled, or already been reassigned.";
  }
  if (/bulunamadı/.test(raw)) return "Lesson not found.";
  return raw;
}

export function baseUrl(): string {
  return (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3010").replace(/\/+$/, "");
}

/** Join linki: ders bitiminden 2 saat sonrasına kadar geçerli imzalı token. */
export function buildJoinUrl(slotId: string, role: "teacher" | "class", endsAt: Date): string {
  const token = signJoinToken(
    { slotId, role, expiresAt: new Date(endsAt.getTime() + 2 * 3_600_000) },
    joinSecret(),
  );
  return `${baseUrl()}/join/${token}`;
}

// en-US: panel eğitmen yüzüdür (native ESL arz — Türkçe anlamıyor).
function formatInZone(at: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: tz,
    }).format(at);
  } catch {
    return `${at.toISOString()} (UTC)`;
  }
}

export const teacherPortalRouter = router({
  getPanel: publicProcedure.input(z.object({ token: tokenSchema })).query(async ({ ctx, input }) => {
    return ctx.pool.withPlatform(async (db) => {
      const teacher = await getTeacherByPortalToken(db, input.token);
      if (!teacher) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "This panel link is invalid or has been revoked.",
        });
      }

      // Kazanç bakiyesi = teacher_payable cache kolonu (tek yazım kapısı ledger'da).
      const bal = await db.query<{ balance_cents: string }>(
        `SELECT balance_cents FROM ledger_account
          WHERE owner_type = 'teacher' AND owner_id = $1 AND kind = 'teacher_payable'`,
        [teacher.teacherId],
      );
      const payableCents = Number(bal.rows[0]?.balance_cents ?? 0);

      // Strike sayacı: teacherNoShow her no-show'da artırır, 3'te suspend.
      const strike = await db.query<{ strike_count: number }>(
        "SELECT strike_count FROM teacher WHERE id = $1",
        [teacher.teacherId],
      );
      const strikeCount = strike.rows[0]?.strike_count ?? 0;

      // Haftalık müsaitlik pencereleri (self-servis CRUD'un okuma yüzü).
      const availability = await db.query<{
        id: string;
        weekday: number;
        start_minute: number;
        end_minute: number;
        timezone: string;
      }>(
        `SELECT id, weekday, start_minute, end_minute, timezone
           FROM teacher_availability
          WHERE teacher_id = $1 AND active
          ORDER BY weekday, start_minute`,
        [teacher.teacherId],
      );

      // Gelecek confirmed dersler (slot hâlâ scheduled) — saat eğitmenin tz'sinde.
      const upcoming = await db.query<{
        slot_id: string;
        starts_at: Date;
        ends_at: Date;
        teacher_pay_cents: string;
        class_name: string;
        school_name: string;
      }>(
        `SELECT s.id AS slot_id, s.starts_at, s.ends_at, s.teacher_pay_cents,
                cg.name AS class_name, sch.name AS school_name
           FROM assignment a
           JOIN booking_slot s ON s.id = a.slot_id
           JOIN class_group cg ON cg.id = s.class_group_id
           JOIN school sch ON sch.id = s.school_id
          WHERE a.teacher_id = $1 AND a.status = 'confirmed'
            AND s.status = 'scheduled' AND s.ends_at > now()
          ORDER BY s.starts_at
          LIMIT 50`,
        [teacher.teacherId],
      );

      // Son 20 settle edilmiş ders: tarih, dosaj dk, kazanç (slot.teacher_pay_cents).
      const settled = await db.query<{
        session_id: string;
        ended_at: Date | null;
        dosage_min: number | null;
        teacher_pay_cents: string;
        class_name: string;
        school_name: string;
      }>(
        `SELECT cs.id AS session_id, cs.ended_at, cs.dosage_min, s.teacher_pay_cents,
                cg.name AS class_name, sch.name AS school_name
           FROM class_session cs
           JOIN booking_slot s ON s.id = cs.slot_id
           JOIN class_group cg ON cg.id = cs.class_group_id
           JOIN school sch ON sch.id = cs.school_id
          WHERE cs.teacher_id = $1 AND cs.status = 'settled'
          ORDER BY cs.ended_at DESC NULLS LAST
          LIMIT 20`,
        [teacher.teacherId],
      );

      // Ödemelerim: payout geçmişi (tutar, durum, tarih) — modül sorgusu kendi platform
      // tx'ini açar (pool alır); Wise referansı buradaki bağlantıyla zenginleştirilir.
      const payouts = await getTeacherPayouts(ctx.pool, teacher.teacherId);
      const refRows =
        payouts.length === 0
          ? []
          : (
              await db.query<{ id: string; external_ref: string | null }>(
                "SELECT id, external_ref FROM payout WHERE id = ANY($1::uuid[])",
                [payouts.map((p) => p.id)],
              )
            ).rows;
      const externalRefs = new Map(refRows.map((r) => [r.id, r.external_ref]));

      return {
        teacherName: teacher.fullName,
        timezone: teacher.timezone,
        payableCents,
        strikeCount,
        strikeLimit: STRIKE_LIMIT,
        availability: availability.rows.map((r) => ({
          id: r.id,
          weekday: r.weekday,
          startMinute: r.start_minute,
          endMinute: r.end_minute,
          timezone: r.timezone,
        })),
        // Maskeli görünüm (method + son 4): ham hesap değeri panele hiç dönmez.
        payoutDetails: await readMaskedPayoutDetails(db, teacher.teacherId),
        upcoming: upcoming.rows.map((r) => ({
          slotId: r.slot_id,
          schoolName: r.school_name,
          className: r.class_name,
          startsAt: r.starts_at,
          startsAtLocal: formatInZone(r.starts_at, teacher.timezone),
          durationMin: Math.round((r.ends_at.getTime() - r.starts_at.getTime()) / 60_000),
          teacherPayCents: Number(r.teacher_pay_cents),
          // Ders linki: /join → join olayı kaydedilir, sonra odaya 302.
          joinUrl: buildJoinUrl(r.slot_id, "teacher", r.ends_at),
        })),
        settled: settled.rows.map((r) => ({
          sessionId: r.session_id,
          schoolName: r.school_name,
          className: r.class_name,
          endedAt: r.ended_at,
          endedAtLocal: r.ended_at ? formatInZone(r.ended_at, teacher.timezone) : "—",
          dosageMin: r.dosage_min ?? 0,
          earnedCents: Number(r.teacher_pay_cents),
        })),
        payouts: payouts.map((p) => ({
          id: p.id,
          amountCents: p.amountCents,
          status: p.status,
          failureReason: p.failureReason,
          paidAt: p.paidAt,
          paidAtLocal: p.paidAt ? formatInZone(p.paidAt, teacher.timezone) : "—",
          createdAtLocal: formatInZone(p.createdAt, teacher.timezone),
          externalRef: externalRefs.get(p.id) ?? null,
        })),
      };
    });
  }),

  // Payout hesabını güncelle (eğitmen, panel token'ıyla): token her istekte doğrulanır.
  // Doğrulama + yazım @teachernow/hr'da; yanıt yalnız maskeli görünümü döner.
  updatePayoutDetails: publicProcedure
    .input(z.object({ token: tokenSchema, details: payoutDetailsSchema }))
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const teacher = await getTeacherByPortalToken(db, input.token);
        if (!teacher) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "This panel link is invalid or has been revoked.",
          });
        }
        await hrSetPayoutDetails(db, teacher.teacherId, input.details);
        return { ok: true as const, payoutDetails: maskPayoutDetails(input.details) };
      });
    }),

  // ---- Müsaitlik self-servisi (denetim P2): token her istekte doğrulanır ----

  // Pencere ekle: admin.addAvailability ile aynı doğrulama (IANA tz dahil) — fark,
  // teacherId'nin token'dan çözülmesi. Eğitmen yalnız KENDİ satırını yazabilir.
  addAvailability: publicProcedure
    .input(
      z
        .object({
          token: tokenSchema,
          weekday: z.number().int().min(0).max(6), // 0=Monday (ISO)
          startMinute: z.number().int().min(0).max(1439),
          endMinute: z.number().int().min(1).max(1440),
          // IANA doğrulamalı (denetim P1): bozuk tz eğitmen eşleştirmesini kaydırır.
          timezone: timezoneSchema,
        })
        .refine((v) => v.endMinute > v.startMinute, {
          message: "End time must be after start time.",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const teacher = await getTeacherByPortalToken(db, input.token);
        if (!teacher) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "This panel link is invalid or has been revoked.",
          });
        }
        const res = await db.query<{ id: string }>(
          `INSERT INTO teacher_availability (teacher_id, weekday, start_minute, end_minute, timezone)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [teacher.teacherId, input.weekday, input.startMinute, input.endMinute, input.timezone],
        );
        const row = res.rows[0];
        if (!row) throw new Error("teacherPortal.addAvailability: INSERT satır dönmedi");
        return { id: row.id };
      });
    }),

  // Pencere sil (soft): sahiplik WHERE teacher_id ile şart — başkasının satırı NOT_FOUND.
  removeAvailability: publicProcedure
    .input(z.object({ token: tokenSchema, id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const teacher = await getTeacherByPortalToken(db, input.token);
        if (!teacher) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "This panel link is invalid or has been revoked.",
          });
        }
        const res = await db.query(
          `UPDATE teacher_availability SET active = false
            WHERE id = $1 AND teacher_id = $2 AND active`,
          [input.id, teacher.teacherId],
        );
        if (res.rowCount !== 1) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Availability window not found." });
        }
        return { id: input.id, active: false as const };
      });
    }),

  // Dersi bırak (denetim P2): sahiplik + iş kuralları @teachernow/dispatch'te —
  // teacherDropByTeacher başkasının dersinde hata fırlatır, kendi dersinde atamayı
  // düşürür ve HEMEN re-offer dener. Yeni eğitmenin kimliği bırakan eğitmene SIZDIRILMAZ.
  dropLesson: publicProcedure
    .input(z.object({ token: tokenSchema, slotId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const teacher = await ctx.pool.withPlatform(async (db) =>
        getTeacherByPortalToken(db, input.token),
      );
      if (!teacher) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "This panel link is invalid or has been revoked.",
        });
      }
      try {
        // Modül kendi withPlatform tx'ini açar (pool alır) — cancelBySchool deseni.
        const res = await teacherDropByTeacher(ctx.pool, {
          slotId: input.slotId,
          teacherId: teacher.teacherId,
        });
        return { reoffered: res.reoffered };
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: englishDropError(err instanceof Error ? err.message : String(err)),
        });
      }
    }),

  // Panel linki self-yenileme (public, denetim P2): varlık sızdırmaz — kayıtlı olsun
  // olmasın aynı {ok:true} döner; outbox yazımı + 15dk rate-limit @teachernow/hr'da.
  requestLink: publicProcedure
    .input(z.object({ email: z.string().trim().email().max(320) }))
    .mutation(async ({ ctx, input }) => {
      return requestPortalLink(ctx.pool, input.email);
    }),

  // Panel linki üret (platform): ham token yalnız dönen URL'de ve outbox payload'ında
  // yaşar (DB'de hash durur). Panel e-postası AYNI transaction'da outbox'a düşer.
  createLink: platformProcedure
    .input(z.object({ teacherId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { token } = await ctx.pool.withPlatform(async (db) => {
        const created = await createPortalToken(db, { teacherId: input.teacherId });
        const teacher = await db.query<{ email: string; full_name: string }>(
          "SELECT email, full_name FROM teacher WHERE id = $1",
          [input.teacherId],
        );
        const row = teacher.rows[0];
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "eğitmen bulunamadı" });
        await db.query(
          `INSERT INTO notification_outbox (channel, recipient_email, template, payload)
           VALUES ('email', $1, 'teacher_portal',
                   jsonb_build_object('token', $2::text, 'fullName', $3::text))`,
          [row.email, created.token, row.full_name],
        );
        return created;
      });
      return { url: `${baseUrl()}/egitmen/panel/${token}` };
    }),

  // Tüm panel linklerini iptal et (platform): mevcut linkler anında geçersizleşir.
  revokeLinks: platformProcedure
    .input(z.object({ teacherId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.pool.withPlatform(async (db) => revokePortalTokens(db, input.teacherId));
      return { ok: true as const };
    }),
});
