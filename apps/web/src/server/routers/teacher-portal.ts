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
import { getTeacherPayouts } from "@teachernow/payouts";
import { platformProcedure, publicProcedure, router } from "../trpc";
import { joinSecret } from "./session";

const tokenSchema = z.string().trim().min(1).max(500);

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
