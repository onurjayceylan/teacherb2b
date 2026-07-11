// Platform yönetimi: bekleyen havale top-up'ları, banka hesapları, payments_frozen anahtarı,
// dispatch operasyonları (eğitmen müsaitliği, materializer tetiği, pool fiyat kartı, re-offer).
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminSettleBankTopup } from "@teachernow/billing";
import { getSlotForUpdate, materializePlans, offerNext } from "@teachernow/dispatch";
import { isPaymentsFrozen, setPaymentsFrozen } from "@teachernow/ledger";
import { resolveDispute, settleSession } from "@teachernow/sessions";
import { platformProcedure, router } from "../trpc";
import { baseUrl } from "./teacher-portal";

// Panoda tam adres gösterilmez: 'a***@dom.com' (log değil API yanıtı — pii-linter kapsamı dışı).
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***@${email.slice(at + 1)}`;
}

export const adminRouter = router({
  listPendingTopups: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        id: string;
        school_id: string;
        school_name: string;
        amount_cents: string; // pg bigint → string
        currency: string;
        status: string;
        bank_reference_code: string | null;
        created_at: Date;
      }>(
        `SELECT t.id, t.school_id, s.name AS school_name, t.amount_cents, t.currency,
                t.status, t.bank_reference_code, t.created_at
           FROM topup_attempt t
           JOIN school s ON s.id = t.school_id
          WHERE t.method = 'bank_transfer' AND t.status = 'pending_review'
          ORDER BY t.created_at`,
      );
      return res.rows.map((r) => ({
        id: r.id,
        schoolId: r.school_id,
        schoolName: r.school_name,
        amountCents: Number(r.amount_cents),
        currency: r.currency.trim(),
        status: r.status,
        referenceCode: r.bank_reference_code,
        createdAt: r.created_at,
      }));
    });
  }),

  settleBankTopup: platformProcedure
    .input(z.object({ topupId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => adminSettleBankTopup(db, { topupId: input.topupId }));
    }),

  listBankAccounts: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        id: string;
        label: string;
        rail: "eft_tr" | "swift_usd";
        currency: string;
        holder: string;
        iban: string;
        bank_name: string;
        swift_bic: string | null;
        active: boolean;
      }>(
        `SELECT id, label, rail, currency, holder, iban, bank_name, swift_bic, active
           FROM bank_account ORDER BY created_at`,
      );
      return res.rows.map((r) => ({
        id: r.id,
        label: r.label,
        rail: r.rail,
        currency: r.currency.trim(),
        holder: r.holder,
        iban: r.iban,
        bankName: r.bank_name,
        swiftBic: r.swift_bic,
        active: r.active,
      }));
    });
  }),

  createBankAccount: platformProcedure
    .input(
      z.object({
        label: z.string().trim().min(2).max(120),
        rail: z.enum(["eft_tr", "swift_usd"]),
        currency: z.string().trim().length(3).toUpperCase(),
        holder: z.string().trim().min(2).max(200),
        iban: z.string().trim().min(10).max(64),
        bank_name: z.string().trim().min(2).max(200),
        swift_bic: z.string().trim().min(8).max(11).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const res = await db.query<{ id: string }>(
          `INSERT INTO bank_account (label, rail, currency, holder, iban, bank_name, swift_bic, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            input.label,
            input.rail,
            input.currency,
            input.holder,
            input.iban,
            input.bank_name,
            input.swift_bic ?? null,
            ctx.actor.userId,
          ],
        );
        const row = res.rows[0];
        if (!row) throw new Error("createBankAccount: INSERT satır dönmedi");
        return { id: row.id };
      });
    }),

  setBankAccountActive: platformProcedure
    .input(z.object({ id: z.string().uuid(), active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const res = await db.query(
          "UPDATE bank_account SET active = $2, updated_at = now() WHERE id = $1",
          [input.id, input.active],
        );
        if (res.rowCount !== 1) throw new Error("setBankAccountActive: banka hesabı bulunamadı");
        return { id: input.id, active: input.active };
      });
    }),

  paymentsFrozen: platformProcedure.query(async ({ ctx }) => {
    const frozen = await ctx.pool.withPlatform(async (db) => isPaymentsFrozen(db));
    return { frozen };
  }),

  setPaymentsFrozen: platformProcedure
    .input(z.object({ frozen: z.boolean(), detail: z.string().trim().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.pool.withPlatform(async (db) =>
        setPaymentsFrozen(db, input.frozen, input.detail),
      );
      return { frozen: input.frozen };
    }),

  // ---- Pilot go/no-go panosu (/admin/metrikler) ----
  // Tek okuma turu, tamamı platform bağlamında. Yorumlama kuralları:
  // - Aktivasyon medyanları yalnız ilgili olayı yaşamış okullar üzerinden hesaplanır.
  // - Funnel sayıları audit_log'dan (action LIKE 'funnel_%'), okul bazında tekilleştirilmiş.
  // - Dosaj penceresi ±28 gün: gerçekleşme (completed/escalated/no_show) doğası gereği
  //   geçmişte; scheduled sayısı materialize ufkunu (gelecek ≤28 gün) da kapsar ki
  //   pano "önümüzdeki ay ne planlı" sorusuna da cevap versin.
  // - Backfill vaka raporu YÜZDE DEĞİL SAYI döner (plan kuralı) — audit tabanlı.
  metrics: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const schoolCount = Number(
        (await db.query<{ n: string }>("SELECT count(*) AS n FROM school")).rows[0]?.n ?? 0,
      );

      // Kayıt→ilk settled top-up ve kayıt→ilk settled ders medyan gün.
      // İlk settled ders zamanı audit 'session_settled' kaydından okunur
      // (class_session'da settled_at kolonu yok; audit izi settle anında atılır).
      const medians = await db.query<{ topup_days: number | null; lesson_days: number | null }>(
        `WITH firsts AS (
           SELECT s.id, s.created_at,
                  (SELECT min(t.settled_at) FROM topup_attempt t
                    WHERE t.school_id = s.id AND t.status = 'settled') AS first_topup,
                  (SELECT min(a.occurred_at) FROM audit_log a
                    WHERE a.school_id = s.id AND a.action = 'session_settled') AS first_lesson
             FROM school s)
         SELECT percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY EXTRACT(EPOCH FROM (first_topup - created_at)) / 86400.0)
                  FILTER (WHERE first_topup IS NOT NULL) AS topup_days,
                percentile_cont(0.5) WITHIN GROUP
                  (ORDER BY EXTRACT(EPOCH FROM (first_lesson - created_at)) / 86400.0)
                  FILTER (WHERE first_lesson IS NOT NULL) AS lesson_days
           FROM firsts`,
      );

      const funnel = await db.query<{ action: string; schools: string; events: string }>(
        `SELECT action, count(DISTINCT school_id) AS schools, count(*) AS events
           FROM audit_log
          WHERE action LIKE 'funnel_%'
          GROUP BY action`,
      );

      const slots = await db.query<{ status: string; n: string }>(
        `SELECT status, count(*) AS n
           FROM booking_slot
          WHERE starts_at >= now() - interval '28 days'
            AND starts_at <  now() + interval '28 days'
          GROUP BY status`,
      );
      const slotCounts: Record<string, number> = {};
      for (const r of slots.rows) slotCounts[r.status] = Number(r.n);
      const completed = slotCounts["completed"] ?? 0;
      const escalated = slotCounts["escalated"] ?? 0;
      const noShow = slotCounts["no_show_teacher"] ?? 0;
      const realizationDenom = completed + escalated + noShow;

      const backfill = await db.query<{ sla_escalated: string; reoffered: string }>(
        `SELECT count(*) FILTER (WHERE action = 'sla_escalated') AS sla_escalated,
                count(*) FILTER (WHERE action IN
                  ('slot_backfill_reoffered', 'slot_teacher_drop_reoffered')) AS reoffered
           FROM audit_log`,
      );

      const money = await db.query<{ settled_lessons: string; volume_cents: string }>(
        `SELECT count(*) AS settled_lessons, COALESCE(sum(s.price_cents), 0) AS volume_cents
           FROM class_session cs
           JOIN booking_slot s ON s.id = cs.slot_id
          WHERE cs.status = 'settled'`,
      );
      const settledLessons = Number(money.rows[0]?.settled_lessons ?? 0);

      const disputeCount = Number(
        (await db.query<{ n: string }>("SELECT count(*) AS n FROM session_dispute")).rows[0]?.n ??
          0,
      );

      const repeatTopupSchools = Number(
        (
          await db.query<{ n: string }>(
            `SELECT count(*) AS n FROM (
               SELECT school_id FROM topup_attempt
                WHERE status = 'settled' GROUP BY school_id HAVING count(*) >= 2) r`,
          )
        ).rows[0]?.n ?? 0,
      );

      const teachers = await db.query<{ active: string; payout_ready: string }>(
        `SELECT count(*) FILTER (WHERE status = 'active') AS active,
                count(*) FILTER (WHERE payout_ready) AS payout_ready
           FROM teacher`,
      );

      const openPayouts = await db.query<{ n: string; total_cents: string }>(
        `SELECT count(*) AS n, COALESCE(sum(amount_cents), 0) AS total_cents
           FROM payout WHERE status IN ('pending', 'submitted')`,
      );

      return {
        activation: {
          schoolCount,
          medianDaysToFirstTopup: medians.rows[0]?.topup_days ?? null,
          medianDaysToFirstSettledLesson: medians.rows[0]?.lesson_days ?? null,
          funnel: funnel.rows.map((r) => ({
            action: r.action,
            schools: Number(r.schools),
            events: Number(r.events),
          })),
        },
        dosage: {
          windowDays: 28,
          slotCounts,
          // Gerçekleşme oranı: completed / (completed + escalated + no_show) — 0..1, veri yoksa null.
          realizationRate: realizationDenom > 0 ? completed / realizationDenom : null,
        },
        backfill: {
          slaEscalatedCount: Number(backfill.rows[0]?.sla_escalated ?? 0),
          reofferCount: Number(backfill.rows[0]?.reoffered ?? 0),
        },
        money: {
          settledLessonCount: settledLessons,
          settledVolumeCents: Number(money.rows[0]?.volume_cents ?? 0),
          disputeCount,
          // İtiraz oranı: itiraz / settled ders — hedef < %2; settled ders yoksa null.
          disputeRate: settledLessons > 0 ? disputeCount / settledLessons : null,
          repeatTopupSchools,
        },
        teachers: {
          activeCount: Number(teachers.rows[0]?.active ?? 0),
          payoutReadyCount: Number(teachers.rows[0]?.payout_ready ?? 0),
          openPayoutCount: Number(openPayouts.rows[0]?.n ?? 0),
          openPayoutTotalCents: Number(openPayouts.rows[0]?.total_cents ?? 0),
        },
      };
    });
  }),

  // ---- Dispatch operasyonları (S3) ----

  listAvailability: platformProcedure
    .input(z.object({ teacherId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const res = await db.query<{
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
          [input.teacherId],
        );
        return res.rows.map((r) => ({
          id: r.id,
          weekday: r.weekday,
          startMinute: r.start_minute,
          endMinute: r.end_minute,
          timezone: r.timezone,
        }));
      });
    }),

  addAvailability: platformProcedure
    .input(
      z
        .object({
          teacherId: z.string().uuid(),
          weekday: z.number().int().min(0).max(6), // 0=Pazartesi (ISO)
          startMinute: z.number().int().min(0).max(1439),
          endMinute: z.number().int().min(1).max(1440),
          timezone: z.string().trim().min(1).max(64),
        })
        .refine((v) => v.endMinute > v.startMinute, {
          message: "bitiş başlangıçtan sonra olmalı",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const res = await db.query<{ id: string }>(
          `INSERT INTO teacher_availability (teacher_id, weekday, start_minute, end_minute, timezone)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [input.teacherId, input.weekday, input.startMinute, input.endMinute, input.timezone],
        );
        const row = res.rows[0];
        if (!row) throw new Error("addAvailability: INSERT satır dönmedi");
        return { id: row.id };
      });
    }),

  removeAvailability: platformProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const res = await db.query(
          "UPDATE teacher_availability SET active = false WHERE id = $1 AND active",
          [input.id],
        );
        if (res.rowCount !== 1) {
          throw new TRPCError({ code: "NOT_FOUND", message: "müsaitlik penceresi bulunamadı" });
        }
        return { id: input.id, active: false };
      });
    }),

  // Demo/test tetiği: aktif planları 4 haftalık ufukta materialize eder (idempotent).
  runMaterializer: platformProcedure.mutation(async ({ ctx }) => {
    return materializePlans(ctx.pool, { horizonWeeks: 4 });
  }),

  // Fiyat kartı yönetimi (yalnız platform: maliyet kolonunu yalnız bu rol görür).
  listPoolPricing: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        id: string;
        key: string;
        name: string;
        active: boolean;
        sell_per_lesson_cents: string;
        pay_per_lesson_cents: string;
        lesson_minutes: number;
      }>(
        `SELECT id, key, name, active, sell_per_lesson_cents, pay_per_lesson_cents, lesson_minutes
           FROM pool ORDER BY name`,
      );
      return res.rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        active: r.active,
        sellPerLessonCents: Number(r.sell_per_lesson_cents),
        payPerLessonCents: Number(r.pay_per_lesson_cents),
        lessonMinutes: r.lesson_minutes,
      }));
    });
  }),

  // Kart güncellenirse yalnız YENİ reçeteler etkilenir (plan satırı snapshot taşır).
  updatePoolPricing: platformProcedure
    .input(
      z.object({
        poolId: z.string().uuid(),
        sellPerLessonCents: z.number().int().positive().max(100_000_000),
        payPerLessonCents: z.number().int().min(0).max(100_000_000),
        lessonMinutes: z.number().int().min(15).max(240),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        try {
          const res = await db.query(
            `UPDATE pool
                SET sell_per_lesson_cents = $2, pay_per_lesson_cents = $3, lesson_minutes = $4
              WHERE id = $1`,
            [input.poolId, input.sellPerLessonCents, input.payPerLessonCents, input.lessonMinutes],
          );
          if (res.rowCount !== 1) {
            throw new TRPCError({ code: "NOT_FOUND", message: "havuz bulunamadı" });
          }
        } catch (err) {
          // 23514: pool_margin_check — negatif marj yapısal imkânsız, kullanıcıya anlaşılır dönsün.
          if ((err as { code?: string }).code === "23514") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "eğitmen maliyeti satış fiyatını aşamaz",
            });
          }
          throw err;
        }
        return { poolId: input.poolId };
      });
    }),

  // Teklifi yeniden gönder: mevcut offered atamayı CAS'la cancelled yapar ve sıradaki
  // adaya (aynı eğitmen dahil — cancelled dışlanmaz) yeni token'lı teklif açar.
  // Ham token yalnız bu yanıtın içinde yaşar (DB'de hash durur).
  reissueOffer: platformProcedure
    .input(z.object({ slotId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const slot = await getSlotForUpdate(db, input.slotId);
        if (!slot) {
          throw new TRPCError({ code: "NOT_FOUND", message: "slot bulunamadı" });
        }
        if (slot.status !== "scheduled") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `yalnız scheduled slot için teklif yenilenebilir (durum: ${slot.status})`,
          });
        }
        const confirmed = await db.query(
          "SELECT 1 FROM assignment WHERE slot_id = $1 AND status = 'confirmed'",
          [slot.id],
        );
        if ((confirmed.rowCount ?? 0) > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "slotta onaylı atama var — teklif yenilenemez",
          });
        }
        // CAS: canlı teklif varsa geri çekilir (offered→cancelled whitelist'te).
        await db.query(
          `UPDATE assignment SET status = 'cancelled', updated_at = now()
            WHERE slot_id = $1 AND status = 'offered'`,
          [slot.id],
        );
        const next = await offerNext(db, slot);
        if (!next) {
          return { ok: false as const, reason: "uygun aday bulunamadı" };
        }
        // Yeni teklifin son geçerliliği + eğitmen adı: panoda "linki ilet" kartı için.
        const detail = await db.query<{ offer_expires_at: Date; full_name: string; email: string }>(
          `SELECT a.offer_expires_at, t.full_name, t.email
             FROM assignment a JOIN teacher t ON t.id = a.teacher_id
            WHERE a.id = $1`,
          [next.assignmentId],
        );
        const d = detail.rows[0];
        if (!d) throw new Error("reissueOffer: yeni atama satırı okunamadı");
        return {
          ok: true as const,
          teacherId: next.teacherId,
          teacherName: d.full_name,
          teacherEmail: d.email,
          token: next.token,
          // Tam URL burada kurulur: bugün teklif linkini eğitmene ulaştırmanın panel yolu.
          url: `${baseUrl()}/egitmen/teklif/${next.token}`,
          expiresAt: d.offer_expires_at,
        };
      });
    }),

  // ---- Bekleyen teklifler (denetim P0: teklif linki iletim UI'ının veri kaynağı) ----

  // offered durumundaki atamalar: slot zamanı + okul/sınıf/havuz + eğitmen adı ve
  // e-postası (MASKESİZ — platform admin linki eğitmene elle iletecek; bu bir API
  // yanıtıdır, log değildir) + teklifin son geçerliliği.
  listOpenOffers: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        assignment_id: string;
        slot_id: string;
        starts_at: Date;
        ends_at: Date;
        offer_expires_at: Date;
        school_name: string;
        class_name: string;
        pool_name: string;
        teacher_name: string;
        teacher_email: string;
      }>(
        `SELECT a.id AS assignment_id, a.slot_id, s.starts_at, s.ends_at, a.offer_expires_at,
                sch.name AS school_name, cg.name AS class_name, pl.name AS pool_name,
                t.full_name AS teacher_name, t.email AS teacher_email
           FROM assignment a
           JOIN booking_slot s ON s.id = a.slot_id
           JOIN school sch ON sch.id = s.school_id
           JOIN class_group cg ON cg.id = s.class_group_id
           JOIN pool pl ON pl.id = s.pool_id
           JOIN teacher t ON t.id = a.teacher_id
          WHERE a.status = 'offered'
          ORDER BY s.starts_at`,
      );
      return res.rows.map((r) => ({
        assignmentId: r.assignment_id,
        slotId: r.slot_id,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        expiresAt: r.offer_expires_at,
        expired: r.offer_expires_at.getTime() <= Date.now(),
        schoolName: r.school_name,
        className: r.class_name,
        poolName: r.pool_name,
        teacherName: r.teacher_name,
        teacherEmail: r.teacher_email,
      }));
    });
  }),

  // ---- Settle onay kuyruğu (denetim P0: kısa/erken ders insan onayına düşer) ----

  // review_required=true oturumlar: bağlam (okul/sınıf/eğitmen), planlı saat,
  // gerçekleşen start/end + dosaj ve settle'ın neden beklediği (review_reason).
  listSettleReviews: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        id: string;
        started_at: Date | null;
        ended_at: Date | null;
        dosage_min: number | null;
        review_reason: string | null;
        starts_at: Date;
        ends_at: Date;
        school_name: string;
        class_name: string;
        teacher_name: string;
      }>(
        `SELECT cs.id, cs.started_at, cs.ended_at, cs.dosage_min, cs.review_reason,
                s.starts_at, s.ends_at,
                sch.name AS school_name, cg.name AS class_name, t.full_name AS teacher_name
           FROM class_session cs
           JOIN booking_slot s ON s.id = cs.slot_id
           JOIN school sch ON sch.id = cs.school_id
           JOIN class_group cg ON cg.id = cs.class_group_id
           JOIN teacher t ON t.id = cs.teacher_id
          WHERE cs.review_required
          ORDER BY cs.created_at`,
      );
      return res.rows.map((r) => ({
        sessionId: r.id,
        schoolName: r.school_name,
        className: r.class_name,
        teacherName: r.teacher_name,
        plannedStartsAt: r.starts_at,
        plannedEndsAt: r.ends_at,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        dosageMin: r.dosage_min,
        reason: r.review_reason,
      }));
    });
  }),

  // Onay: settleSession force:true ile çağrılır — para işler (hold bölüşülür),
  // review bayrağını settle akışı temizler.
  approveSettle: platformProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const res = await settleSession(ctx.pool, input.sessionId, { force: true });
        return { sessionId: input.sessionId, alreadySettled: res.alreadySettled };
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  // Ret: PARA İŞLEMEZ — yalnız review bayrağı düşer + audit izi atılır. Oturum 'ended',
  // slot 'scheduled' kalır; slot böylece hold-aging uyarısına düşer ve karar (iptal/iade
  // /manuel düzeltme) o kuyrukta verilir.
  rejectSettle: platformProcedure
    .input(z.object({ sessionId: z.string().uuid(), note: z.string().trim().min(2).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const res = await db.query<{ school_id: string; review_reason: string | null }>(
          `UPDATE class_session
              SET review_required = false, updated_at = now()
            WHERE id = $1 AND review_required
            RETURNING school_id, review_reason`,
          [input.sessionId],
        );
        const row = res.rows[0];
        if (!row) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "onay bekleyen oturum bulunamadı (zaten sonuçlanmış olabilir)",
          });
        }
        await db.query(
          `INSERT INTO audit_log (actor_kind, actor_id, school_id, action, entity_type, entity_id, after)
           VALUES ('platform_admin', $1, $2, 'settle_rejected', 'class_session', $3, $4::jsonb)`,
          [
            ctx.actor.userId,
            row.school_id,
            input.sessionId,
            JSON.stringify({
              note: input.note,
              review_reason: row.review_reason,
              // Para bilinçli işlenmedi: slot 'scheduled' kaldığı için hold-aging
              // uyarısına düşer; nihai karar orada verilir.
              money_untouched: true,
            }),
          ],
        );
        return { sessionId: input.sessionId };
      });
    }),

  // ---- Bildirim outbox'ı ----

  // Son 30 outbox kaydı. resendConfigured=false ise kayıtlar 'pending' birikiyordur —
  // pano bunu 'e-posta anahtarı bekleniyor' notuyla gösterir.
  listNotifications: platformProcedure.query(async ({ ctx }) => {
    const rows = await ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        id: string;
        recipient_email: string;
        template: string;
        status: string;
        attempt: number;
        created_at: Date;
      }>(
        `SELECT id, recipient_email, template, status, attempt, created_at
           FROM notification_outbox
          ORDER BY created_at DESC
          LIMIT 30`,
      );
      return res.rows;
    });
    return {
      resendConfigured: Boolean(process.env.RESEND_API_KEY),
      items: rows.map((r) => ({
        id: r.id,
        recipient: maskEmail(r.recipient_email),
        template: r.template,
        status: r.status,
        attempt: r.attempt,
        createdAt: r.created_at,
      })),
    };
  }),

  pendingNotificationCount: platformProcedure.query(async ({ ctx }) => {
    const pending = await ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM notification_outbox WHERE status = 'pending'",
      );
      return Number(res.rows[0]?.n ?? 0);
    });
    return { pending };
  }),

  // ---- İtirazlar (S4) ----

  // Açık itirazlar: karar kuyruğu. Okul adı + ders bağlamı + tutar (iade kararı için).
  listDisputes: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        id: string;
        session_id: string;
        reason: string;
        created_at: Date;
        school_name: string;
        class_name: string;
        occurrence_key: string;
        dosage_min: number | null;
        price_cents: string;
      }>(
        `SELECT d.id, d.session_id, d.reason, d.created_at,
                sch.name AS school_name, cg.name AS class_name,
                s.occurrence_key::text AS occurrence_key, cs.dosage_min, s.price_cents
           FROM session_dispute d
           JOIN school sch ON sch.id = d.school_id
           JOIN class_session cs ON cs.id = d.session_id
           JOIN booking_slot s ON s.id = cs.slot_id
           JOIN class_group cg ON cg.id = cs.class_group_id
          WHERE d.status = 'open'
          ORDER BY d.created_at`,
      );
      return res.rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        reason: r.reason,
        createdAt: r.created_at,
        schoolName: r.school_name,
        className: r.class_name,
        lessonDate: r.occurrence_key,
        dosageMin: r.dosage_min,
        priceCents: Number(r.price_cents),
      }));
    });
  }),

  // Karar Faz-1'de insanda: refund daima ters kayıtla (modül resolveDispute kendi
  // withPlatform tx'ini açar — pool verilir).
  resolveDispute: platformProcedure
    .input(
      z.object({
        disputeId: z.string().uuid(),
        decision: z.enum(["rejected", "refund"]),
        note: z.string().trim().min(2).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await resolveDispute(ctx.pool, {
          disputeId: input.disputeId,
          decision: input.decision,
          note: input.note,
        });
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return { disputeId: input.disputeId, decision: input.decision };
    }),
});
