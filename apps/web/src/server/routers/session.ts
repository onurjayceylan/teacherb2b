// Ders odası (S4): login'siz, imzalı join token'ıyla çalışan public uçlar.
// Token HER uçta yeniden doğrulanır (verifyJoinToken, secret=BETTER_AUTH_SECRET);
// geçersiz/expired token NOT_FOUND üretir — ayrıntı sızdırılmaz.
// Gizlilik hattı: eğitmen öğrenci adını MASKELİ görür ("Ad S."), KENDİ ücretini
// (teacher_pay_cents) görür; okulun ödediği fiyat (price_cents) bu uçlardan ASLA dönmez.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Db } from "@teachernow/db";
import {
  endSession,
  ensureSessionForSlot,
  markAttendance,
  settleSession,
  startSession,
  verifyJoinToken,
} from "@teachernow/sessions";
import { publicProcedure, router } from "../trpc";

// Biçim kasten gevşek: bozuk token da NOT_FOUND üretmeli (BAD_REQUEST değil).
const tokenSchema = z.string().trim().min(1).max(500);

export function joinSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET gerekli (join token imzası)");
  return secret;
}

/** Token'ı doğrular ve beklenen rolü şart koşar; aksi halde NOT_FOUND. */
// Hata metinleri role göre: eğitmen yüzü İngilizce (hedef arz native ESL),
// sınıf yüzü iki dilli (okul projeksiyonuna açılıyor).
function requireRole(token: string, role: "teacher" | "class"): { slotId: string } {
  const payload = verifyJoinToken(token, joinSecret());
  if (!payload || payload.role !== role) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message:
        role === "teacher"
          ? "This lesson link is invalid or has expired."
          : "Ders bağlantısı geçersiz ya da süresi dolmuş. / This lesson link is invalid or has expired.",
    });
  }
  return { slotId: payload.slotId };
}

/**
 * Öğrenci adı maskesi (eğitmen yüzü): adın tamamı + soyadın ilk harfi + ".".
 * "Ayşe Yılmaz" → "Ayşe Y."; tek kelimelik ad olduğu gibi kalır.
 */
export function maskStudentName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  return `${parts.slice(0, -1).join(" ")} ${last.charAt(0).toUpperCase()}.`;
}

/** UTC anını verilen timezone'da okunur biçimler; geçersiz tz'de UTC'ye düşer. */
// en-US: bu formatlar eğitmen yüzüne gider (native ESL arz — Türkçe anlamıyor).
function formatInZone(at: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: tz,
    }).format(at);
  } catch {
    return `${at.toISOString()} (UTC)`;
  }
}

interface SlotSessionRow {
  slot_id: string;
  slot_status: string;
  starts_at: Date;
  ends_at: Date;
  teacher_pay_cents: string; // pg bigint → string
  class_group_id: string;
  class_name: string;
  school_tz: string | null;
  lesson_link: string | null;
  teacher_name: string | null;
  teacher_tz: string | null;
  session_id: string | null;
  session_status: string | null;
  dosage_min: number | null;
}

/** Slot + (varsa) session + onaylı eğitmen — platform bağlamında tek sorgu. */
async function loadSlotSession(db: Db, slotId: string): Promise<SlotSessionRow | null> {
  const res = await db.query<SlotSessionRow>(
    `SELECT s.id AS slot_id, s.status AS slot_status, s.starts_at, s.ends_at,
            s.teacher_pay_cents, s.class_group_id, cg.name AS class_name,
            dp.school_tz, dp.lesson_link,
            t.full_name AS teacher_name, t.timezone AS teacher_tz,
            cs.id AS session_id, cs.status AS session_status, cs.dosage_min
       FROM booking_slot s
       JOIN class_group cg ON cg.id = s.class_group_id
       LEFT JOIN dosage_plan dp ON dp.id = s.plan_id
       LEFT JOIN class_session cs ON cs.slot_id = s.id
       LEFT JOIN assignment a ON a.slot_id = s.id AND a.status = 'confirmed'
       LEFT JOIN teacher t ON t.id = COALESCE(cs.teacher_id, a.teacher_id)
      WHERE s.id = $1`,
    [slotId],
  );
  return res.rows[0] ?? null;
}

export const sessionRouter = router({
  // Eğitmen odası görünümü: slot + session durumu + sınıf adı + saat (eğitmen tz) +
  // MASKELİ roster + mevcut yoklama işaretleri + eğitmenin ÜCRETİ.
  getRoom: publicProcedure.input(z.object({ token: tokenSchema })).query(async ({ ctx, input }) => {
    const { slotId } = requireRole(input.token, "teacher");
    return ctx.pool.withPlatform(async (db) => {
      const row = await loadSlotSession(db, slotId);
      if (!row || !row.teacher_name || !row.teacher_tz) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Lesson not found or it has no confirmed teacher assignment.",
        });
      }
      const students = await db.query<{ id: string; full_name: string }>(
        `SELECT id, full_name FROM student
          WHERE class_group_id = $1 AND status = 'active'
          ORDER BY full_name`,
        [row.class_group_id],
      );
      const marks = new Map<string, boolean>();
      if (row.session_id) {
        const att = await db.query<{ student_id: string; present: boolean }>(
          "SELECT student_id, present FROM session_attendance WHERE session_id = $1",
          [row.session_id],
        );
        for (const a of att.rows) marks.set(a.student_id, a.present);
      }
      return {
        slotStatus: row.slot_status,
        // Session henüz oluşmadıysa 'not_started' — UI "Dersi başlat" gösterir.
        sessionStatus: row.session_status ?? ("not_started" as const),
        className: row.class_name,
        teacherName: row.teacher_name,
        timezone: row.teacher_tz,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        startsAtLocal: formatInZone(row.starts_at, row.teacher_tz),
        durationMin: Math.round((row.ends_at.getTime() - row.starts_at.getTime()) / 60_000),
        dosageMin: row.dosage_min,
        // Eğitmenin ders ücreti — okul fiyatı (price_cents) BİLİNÇLİ olarak dönmez.
        teacherPayCents: Number(row.teacher_pay_cents),
        // P1-H: dersin yeri (okulun Zoom/Meet linki) — eğitmen buradan katılır.
        lessonLink: row.lesson_link,
        roster: students.rows.map((s) => ({
          studentId: s.id,
          // Eğitmene yalnız maskeli ad ("Ad S.") gider; tam ad okul yüzünde kalır.
          name: maskStudentName(s.full_name),
          present: marks.get(s.id) ?? null,
        })),
      };
    });
  }),

  // Dersi başlat: session'ı (yoksa) oluşturur + started durumuna geçirir. İdempotent.
  // Modül hataları Türkçe üretir (backend alanı); eğitmen yüzü İngilizce olduğundan
  // bilinen zaman-penceresi hataları burada çevrilir — bilinmeyenler olduğu gibi geçer.
  start: publicProcedure.input(z.object({ token: tokenSchema })).mutation(async ({ ctx, input }) => {
    const { slotId } = requireRole(input.token, "teacher");
    return ctx.pool.withPlatform(async (db) => {
      try {
        const { sessionId } = await ensureSessionForSlot(db, slotId);
        const res = await startSession(db, sessionId);
        return { sessionId, alreadyStarted: res.alreadyStarted ?? false };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        const raw = err instanceof Error ? err.message : String(err);
        const early = /başlangıca (\d+) dk var/.exec(raw);
        const message = early
          ? `The lesson cannot be started yet — it starts in ${early[1]} minutes (you can start at most 15 minutes early).`
          : raw.includes("ders penceresi geçti")
            ? "The lesson window has passed — please contact support."
            : raw;
        throw new TRPCError({ code: "BAD_REQUEST", message });
      }
    });
  }),

  // Yoklama: yalnız bu dersin sınıfındaki öğrenciler işaretlenebilir (aidiyet doğrulanır).
  mark: publicProcedure
    .input(
      z.object({
        token: tokenSchema,
        entries: z
          .array(z.object({ studentId: z.string().uuid(), present: z.boolean() }))
          .min(1)
          .max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { slotId } = requireRole(input.token, "teacher");
      return ctx.pool.withPlatform(async (db) => {
        const row = await loadSlotSession(db, slotId);
        if (!row?.session_id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Please start the lesson first." });
        }
        // Aidiyet: gönderilen her öğrenci bu dersin sınıfında ve aktif olmalı.
        const ids = input.entries.map((e) => e.studentId);
        const owned = await db.query<{ id: string }>(
          `SELECT id FROM student
            WHERE id = ANY($1::uuid[]) AND class_group_id = $2 AND status = 'active'`,
          [ids, row.class_group_id],
        );
        if (owned.rowCount !== ids.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "The list contains a student who is not in this class.",
          });
        }
        await markAttendance(db, row.session_id, input.entries);
        return { marked: input.entries.length };
      });
    }),

  // Dersi bitir: dosaj hesaplanır (endSession) + para AYRI transaction'da settle edilir
  // (settleSession kendi withPlatform tx'ini açar — endSession commit'inden sonra çağrılır).
  // Denetim P0: kısa/erken ders otomatik settle OLMAZ — settleSession reviewRequired
  // döner, oturum admin onay kuyruğuna düşer; eğitmen yüzü bunu açıkça söyler.
  finish: publicProcedure
    .input(z.object({ token: tokenSchema }))
    .mutation(async ({ ctx, input }) => {
      const { slotId } = requireRole(input.token, "teacher");
      const { sessionId, dosageMin } = await ctx.pool.withPlatform(async (db) => {
        const row = await loadSlotSession(db, slotId);
        if (!row?.session_id) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Please start the lesson first." });
        }
        if (row.session_status === "ended" || row.session_status === "settled") {
          // İdempotent bitirme: dosaj zaten donmuş — settle aşamasına düş.
          return { sessionId: row.session_id, dosageMin: row.dosage_min ?? 0 };
        }
        try {
          const res = await endSession(db, row.session_id);
          return { sessionId: row.session_id, dosageMin: res.dosageMin };
        } catch (err) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
      // Para hareketi: hold→charge + eğitmen alacağı. Kendi tx'i; idempotent.
      // reviewRequired=true ise para İŞLEMEDİ — admin onayı bekliyor.
      const settleRes = await settleSession(ctx.pool, sessionId);
      const reviewRequired = settleRes.reviewRequired === true;
      return { dosageMin, settled: !reviewRequired, reviewRequired };
    }),

  // Sınıf katılım görünümü (class token): sınıf adı + ders başladı mı. PII yok.
  getClassStatus: publicProcedure
    .input(z.object({ token: tokenSchema }))
    .query(async ({ ctx, input }) => {
      const { slotId } = requireRole(input.token, "class");
      return ctx.pool.withPlatform(async (db) => {
        const row = await loadSlotSession(db, slotId);
        if (!row) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Ders bulunamadı. / Lesson not found." });
        }
        return {
          className: row.class_name,
          startsAt: row.starts_at,
          // Saatler planın OKUL saat diliminde basılır (denetim P2) — sayfa okul/öğrenci
          // projeksiyonuna açılıyor; tarayıcının dilimi yanıltabilir. Plansız (eski) slot
          // için makul varsayılan: Europe/Istanbul (sınıflar Türkiye'de).
          schoolTz: row.school_tz ?? "Europe/Istanbul",
          started: row.session_status === "started",
          ended: row.session_status === "ended" || row.session_status === "settled",
          // P1-H: dersin yeri (okul projeksiyonuna da gösterilir — sınıf nereye bağlanacak).
          lessonLink: row.lesson_link,
        };
      });
    }),
});
