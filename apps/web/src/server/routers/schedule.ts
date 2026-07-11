// Ders programı (okul-scoped): pool fiyat kartı görünümü, dosaj reçetesi (plan) oluşturma,
// slot listesi ve okul iptali. Para/dispatch iş kuralları @teachernow/dispatch'te —
// burada yalnız giriş doğrulama + yetki + bağlam seçimi (okul RLS / platform).
// Gizlilik hattı: okul rolü pool.pay_per_lesson_cents ve booking_slot.teacher_pay_cents
// kolonlarını SELECT EDEMEZ (grant kısıtlı); maliyet yalnız platform bağlamında okunur
// ve plan satırına snapshot olarak yazılır. Eğitmenden okula yalnız AD gösterilir.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { cancelBySchool, materializePlans } from "@teachernow/dispatch";
import { openDispute } from "@teachernow/sessions";
import { router, schoolProcedure } from "../trpc";
import { buildJoinUrl } from "./teacher-portal";

const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "tarih YYYY-AA-GG biçiminde olmalı");

export const scheduleRouter = router({
  // Aktif havuzlar: satış fiyatı + ders süresi. Maliyet kolonu SELECT edilmez —
  // okul rolünün grant'i zaten yok; sorgu bilinçli olarak yalnız satış yüzünü çeker.
  listPools: schoolProcedure.query(async ({ ctx }) => {
    return ctx.withSchoolDb(async (db) => {
      const res = await db.query<{
        id: string;
        key: string;
        name: string;
        sell_per_lesson_cents: string; // pg bigint → string
        lesson_minutes: number;
      }>(
        `SELECT id, key, name, sell_per_lesson_cents, lesson_minutes
           FROM pool WHERE active ORDER BY name`,
      );
      return res.rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        sellPerLessonCents: Number(r.sell_per_lesson_cents),
        lessonMinutes: r.lesson_minutes,
      }));
    });
  }),

  // Reçete oluştur: fiyatlar POOL kartından platform bağlamında okunur (okul maliyeti
  // göremez ama snapshot plan satırına yazılmalı), plan OKUL bağlamında INSERT edilir
  // (RLS WITH CHECK ikinci hat), ardından materializer slot+hold+teklifi üretir.
  createPlan: schoolProcedure
    .input(
      z.object({
        classGroupId: z.string().uuid(),
        poolId: z.string().uuid(),
        weekday: z.number().int().min(0).max(6), // 0=Pazartesi (ISO)
        startMinute: z.number().int().min(0).max(1439),
        durationMin: z.number().int().min(15).max(240).optional(),
        startDate: dateSchema,
        weeks: z.number().int().min(1).max(52),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Plan oluşturma SECURITY DEFINER RPC'de (0011): fiyat snapshot'ını DB alır —
      // okul rolü maliyeti (teacher_pay_cents) ne okuyabilir ne yazabilir. Okul
      // bağlamında çağrılır; RPC tenant kapısını app.school_ids ile kendisi doğrular.
      const planId = await ctx.withSchoolDb(async (db) => {
        // Nazik hata mesajları için ön kontroller (okul-granted kolonlarla):
        const pool = await db.query<{ id: string }>(
          "SELECT id FROM pool WHERE id = $1 AND active",
          [input.poolId],
        );
        if (!pool.rows[0]) {
          throw new TRPCError({ code: "NOT_FOUND", message: "havuz bulunamadı ya da aktif değil" });
        }
        const cg = await db.query<{ id: string }>(
          "SELECT id FROM class_group WHERE id = $1 AND active",
          [input.classGroupId],
        );
        if (!cg.rows[0]) {
          throw new TRPCError({ code: "NOT_FOUND", message: "sınıf bulunamadı" });
        }
        const ins = await db.query<{ id: string }>(
          `SELECT create_dosage_plan($1, $2, $3, $4, $5, $6, $7, $8, $9) AS id`,
          [
            ctx.activeSchoolId,
            input.classGroupId,
            input.poolId,
            input.weekday,
            input.startMinute,
            input.durationMin ?? null,
            input.startDate,
            input.weeks,
            ctx.actor.userId,
          ],
        );
        const row = ins.rows[0];
        if (!row) throw new Error("createPlan: RPC satır dönmedi");
        return row.id;
      });

      // 3) Materialize — platform bağlamı (dispatch kendi withPlatform transaction'larını açar).
      // Okul reçeteyi kaydeder kaydetmez slotlar + hold'lar + ilk teklifler oluşur.
      const materialize = await materializePlans(ctx.pool, { horizonWeeks: 4 });
      return { planId, materialize };
    }),

  // Okulun planları: sınıf + havuz adı join'li, slot sayaçlarıyla.
  listPlans: schoolProcedure.query(async ({ ctx }) => {
    return ctx.withSchoolDb(async (db) => {
      const res = await db.query<{
        id: string;
        weekday: number;
        start_minute: number;
        duration_min: number;
        school_tz: string;
        price_cents: string;
        start_date: string;
        weeks: number;
        status: string;
        created_at: Date;
        class_name: string | null;
        pool_name: string | null;
        total_slots: string;
        scheduled_count: string;
        blocked_count: string;
      }>(
        `SELECT p.id, p.weekday, p.start_minute, p.duration_min, p.school_tz,
                p.price_cents, p.start_date::text AS start_date, p.weeks, p.status, p.created_at,
                cg.name AS class_name, pl.name AS pool_name,
                count(s.id) AS total_slots,
                count(s.id) FILTER (WHERE s.status = 'scheduled') AS scheduled_count,
                count(s.id) FILTER (WHERE s.status = 'blocked_insufficient_funds') AS blocked_count
           FROM dosage_plan p
           LEFT JOIN class_group cg ON cg.id = p.class_group_id
           LEFT JOIN pool pl ON pl.id = p.pool_id
           LEFT JOIN booking_slot s ON s.plan_id = p.id
          GROUP BY p.id, cg.name, pl.name
          ORDER BY p.created_at DESC`,
      );
      return res.rows.map((r) => ({
        id: r.id,
        weekday: r.weekday,
        startMinute: r.start_minute,
        durationMin: r.duration_min,
        schoolTz: r.school_tz,
        priceCents: Number(r.price_cents),
        startDate: r.start_date,
        weeks: r.weeks,
        status: r.status,
        createdAt: r.created_at,
        className: r.class_name ?? "—",
        poolName: r.pool_name ?? "—",
        totalSlots: Number(r.total_slots),
        scheduledCount: Number(r.scheduled_count),
        blockedCount: Number(r.blocked_count),
      }));
    });
  }),

  // Slotlar + atanmış eğitmenin YALNIZ adı. Slot okuması okul bağlamında (RLS + kolon
  // grant'i teacher_pay/hold kolonlarını dışarıda tutar); confirmed atamanın eğitmen adı
  // platform bağlamında join'lenir — iletişim/maliyet alanı asla dönmez.
  // Ders (session) durumu okul bağlamında join'lenir: okul kendi satırlarını okuyabilir.
  listSlots: schoolProcedure
    .input(z.object({ planId: z.string().uuid().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const slots = await ctx.withSchoolDb(async (db) => {
        const res = await db.query<{
          id: string;
          plan_id: string;
          occurrence_key: string;
          starts_at: Date;
          ends_at: Date;
          price_cents: string;
          status: string;
          class_name: string | null;
          school_tz: string;
          session_id: string | null;
          session_status: string | null;
          dosage_min: number | null;
        }>(
          `SELECT s.id, s.plan_id, s.occurrence_key::text AS occurrence_key,
                  s.starts_at, s.ends_at, s.price_cents, s.status,
                  cg.name AS class_name, p.school_tz,
                  cs.id AS session_id, cs.status AS session_status, cs.dosage_min
             FROM booking_slot s
             JOIN dosage_plan p ON p.id = s.plan_id
             LEFT JOIN class_group cg ON cg.id = s.class_group_id
             LEFT JOIN class_session cs ON cs.slot_id = s.id
            WHERE ($1::uuid IS NULL OR s.plan_id = $1)
            ORDER BY s.starts_at`,
          [input?.planId ?? null],
        );
        return res.rows;
      });

      const slotIds = slots.map((s) => s.id);
      const assignments =
        slotIds.length === 0
          ? []
          : await ctx.pool.withPlatform(async (db) => {
              const res = await db.query<{ slot_id: string; status: string; full_name: string }>(
                `SELECT a.slot_id, a.status, t.full_name
                   FROM assignment a
                   JOIN teacher t ON t.id = a.teacher_id
                  WHERE a.slot_id = ANY($1::uuid[]) AND a.status IN ('offered', 'confirmed')`,
                [slotIds],
              );
              return res.rows;
            });
      const confirmedName = new Map<string, string>();
      const offered = new Set<string>();
      for (const a of assignments) {
        if (a.status === "confirmed") confirmedName.set(a.slot_id, a.full_name);
        else offered.add(a.slot_id);
      }

      return slots.map((s) => ({
        id: s.id,
        planId: s.plan_id,
        occurrenceKey: s.occurrence_key,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
        priceCents: Number(s.price_cents),
        status: s.status,
        className: s.class_name ?? "—",
        schoolTz: s.school_tz,
        // Yalnız onaylanmış atamanın eğitmen ADI; teklif aşamasında ad sızdırılmaz.
        teacherName: confirmedName.get(s.id) ?? null,
        offerPending: offered.has(s.id),
        sessionId: s.session_id,
        sessionStatus: s.session_status,
        dosageMin: s.dosage_min,
        settled: s.session_status === "settled",
      }));
    }),

  // Slot yoklaması (okul yüzü, denetim P1): okul KENDİ öğrencisini TAM ADLA görür —
  // RLS zaten okul-scoped (class_session/session_attendance/student politikaları);
  // maskeleme yalnız eğitmen yüzünde. Tamamlanmış/bitmiş derslerin yoklama listesi.
  slotAttendance: schoolProcedure
    .input(z.object({ slotId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.withSchoolDb(async (db) => {
        const session = await db.query<{ id: string; status: string }>(
          "SELECT id, status FROM class_session WHERE slot_id = $1",
          [input.slotId],
        );
        const s = session.rows[0];
        if (!s) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "bu ders için oturum kaydı yok — yoklama girilmemiş olabilir",
          });
        }
        const att = await db.query<{
          student_id: string;
          full_name: string;
          present: boolean;
          marked_at: Date;
        }>(
          `SELECT a.student_id, st.full_name, a.present, a.marked_at
             FROM session_attendance a
             JOIN student st ON st.id = a.student_id
            WHERE a.session_id = $1
            ORDER BY st.full_name`,
          [s.id],
        );
        return {
          sessionId: s.id,
          sessionStatus: s.status,
          entries: att.rows.map((r) => ({
            studentId: r.student_id,
            fullName: r.full_name,
            present: r.present,
            markedAt: r.marked_at,
          })),
        };
      });
    }),

  // Ders katılım linkleri: yalnız onaylı atamalı scheduled slot için üretilir.
  // Sahiplik okul bağlamında (RLS'li SELECT), atama kontrolü platform bağlamında.
  // Token exp = ders bitişi + 2 saat; ham token yalnız dönen URL'lerde yaşar.
  joinLinks: schoolProcedure
    .input(z.object({ slotId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const slot = await ctx.withSchoolDb(async (db) => {
        const res = await db.query<{ id: string; ends_at: Date; status: string }>(
          "SELECT id, ends_at, status FROM booking_slot WHERE id = $1",
          [input.slotId],
        );
        return res.rows[0] ?? null;
      });
      if (!slot) {
        throw new TRPCError({ code: "NOT_FOUND", message: "slot bulunamadı" });
      }
      if (slot.status !== "scheduled") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `yalnız planlanmış ders için link üretilebilir (durum: ${slot.status})`,
        });
      }
      const confirmed = await ctx.pool.withPlatform(async (db) => {
        const res = await db.query(
          "SELECT 1 FROM assignment WHERE slot_id = $1 AND status = 'confirmed'",
          [slot.id],
        );
        return (res.rowCount ?? 0) > 0;
      });
      if (!confirmed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "slotta onaylı eğitmen ataması yok — önce atama tamamlanmalı",
        });
      }
      return {
        teacherUrl: buildJoinUrl(slot.id, "teacher", slot.ends_at),
        classUrl: buildJoinUrl(slot.id, "class", slot.ends_at),
      };
    }),

  // Okul itirazı: session sahipliği OKUL bağlamında doğrulanır (RLS: okul yalnız kendi
  // satırını görür), kayıt platform tx'inde açılır. Karar Faz-1'de insanda (admin).
  openDispute: schoolProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        reason: z.string().trim().min(3).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.withSchoolDb(async (db) => {
        const res = await db.query<{ id: string }>(
          "SELECT id FROM class_session WHERE id = $1",
          [input.sessionId],
        );
        return res.rows.length > 0;
      });
      if (!owned) {
        throw new TRPCError({ code: "NOT_FOUND", message: "ders oturumu bulunamadı" });
      }
      try {
        const disputeId = await ctx.pool.withPlatform(async (db) =>
          openDispute(db, {
            sessionId: input.sessionId,
            schoolId: ctx.activeSchoolId,
            reason: input.reason,
            createdBy: ctx.actor.userId,
          }),
        );
        return { disputeId };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  // Okul iptali: slot aktif okula mı ait (okul bağlamında RLS'li SELECT) → matris uygular.
  cancelSlot: schoolProcedure
    .input(z.object({ slotId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.withSchoolDb(async (db) => {
        const res = await db.query<{ id: string }>(
          "SELECT id FROM booking_slot WHERE id = $1",
          [input.slotId],
        );
        return res.rows.length > 0;
      });
      if (!owned) {
        throw new TRPCError({ code: "NOT_FOUND", message: "slot bulunamadı" });
      }
      try {
        return await cancelBySchool(ctx.pool, { slotId: input.slotId });
      } catch (err) {
        // scheduled dışı slot / başlamış ders: modül hatası kullanıcıya anlaşılır dönsün.
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  // Gelecekteki hafta için atlama. O haftanın slotu zaten materialize olduysa (denetim P1):
  // derse >24 saat varsa slot OTOMATİK iptal edilir (erken yol — ücretsiz, hold tam iade);
  // ≤24 saatse İPTAL EDİLMEZ — geç iptal %50 keser, karar bilinçli olarak okula bırakılır.
  addSkipWeek: schoolProcedure
    .input(
      z.object({
        planId: z.string().uuid(),
        skipDate: dateSchema,
        reason: z.string().trim().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // 1) Okul bağlamı: plan sahipliği (RLS) + exception kaydı + o haftanın slotu.
      //    Slot plan_id + occurrence_key ile bulunur — plan eşleşmesi korunur.
      const base = await ctx.withSchoolDb(async (db) => {
        const plan = await db.query<{ id: string }>(
          "SELECT id FROM dosage_plan WHERE id = $1",
          [input.planId],
        );
        if (!plan.rows[0]) {
          throw new TRPCError({ code: "NOT_FOUND", message: "plan bulunamadı" });
        }
        const ins = await db.query<{ id: string }>(
          `INSERT INTO plan_exception (plan_id, skip_date, reason, created_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (plan_id, skip_date) DO NOTHING
           RETURNING id`,
          [input.planId, input.skipDate, input.reason ?? null, ctx.actor.userId],
        );
        const existing = await db.query<{ id: string; status: string; starts_at: Date }>(
          "SELECT id, status, starts_at FROM booking_slot WHERE plan_id = $1 AND occurrence_key = $2",
          [input.planId, input.skipDate],
        );
        return { created: ins.rows.length > 0, slot: existing.rows[0] ?? null };
      });

      const slot = base.slot;
      if (!slot || slot.status !== "scheduled") {
        // Slot yok (henüz materialize edilmemiş — exception yeterli) ya da zaten sonuçlanmış.
        return {
          created: base.created,
          cancelled: false,
          note: null,
          existingSlotId: slot?.id ?? null,
        };
      }

      // 2) >24h: erken iptal yolu ücretsizdir — okul adına otomatik iptal (hold tam iade).
      //    cancelBySchool kendi platform tx'ini açar; sahiplik yukarıdaki RLS'li SELECT'le kanıtlı.
      if (slot.starts_at.getTime() - Date.now() > 24 * 3_600_000) {
        try {
          await cancelBySchool(ctx.pool, { slotId: slot.id });
          return {
            created: base.created,
            cancelled: true,
            note: "O haftanın dersi de iptal edildi (ücretsiz).",
            existingSlotId: slot.id,
          };
        } catch (err) {
          // Yarış (slot bu arada başladı/iptal oldu vb.): exception kaydı geçerli kalır,
          // iptal kararı takvime bırakılır — hata yutulmaz, notta görünür.
          return {
            created: base.created,
            cancelled: false,
            note: `O haftanın dersi otomatik iptal edilemedi (${
              err instanceof Error ? err.message : String(err)
            }) — takvimden iptal edin.`,
            existingSlotId: slot.id,
          };
        }
      }

      // 3) ≤24h: otomatik İPTAL YOK — geç iptal %50 keser; bilinçli karar okulda.
      return {
        created: base.created,
        cancelled: false,
        note: "24 saatten yakın — geç iptal %50 ücret keser; takvimden bilerek iptal edin.",
        existingSlotId: slot.id,
      };
    }),

  pausePlan: schoolProcedure
    .input(z.object({ planId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.withSchoolDb(async (db) => {
        const res = await db.query(
          `UPDATE dosage_plan SET status = 'paused', updated_at = now()
            WHERE id = $1 AND status = 'active'`,
          [input.planId],
        );
        if (res.rowCount !== 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "plan aktif değil ya da bulunamadı" });
        }
        return { planId: input.planId, status: "paused" as const };
      });
    }),

  resumePlan: schoolProcedure
    .input(z.object({ planId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.withSchoolDb(async (db) => {
        const res = await db.query(
          `UPDATE dosage_plan SET status = 'active', updated_at = now()
            WHERE id = $1 AND status = 'paused'`,
          [input.planId],
        );
        if (res.rowCount !== 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "plan duraklatılmış değil ya da bulunamadı" });
        }
        return { planId: input.planId, status: "active" as const };
      });
    }),
});
