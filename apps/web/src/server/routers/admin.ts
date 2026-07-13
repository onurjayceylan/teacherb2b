// Platform yönetimi: bekleyen havale top-up'ları, banka hesapları, payments_frozen anahtarı,
// dispatch operasyonları (eğitmen müsaitliği, materializer tetiği, pool fiyat kartı, re-offer).
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminSettleBankTopup } from "@teachernow/billing";
import { getSlotForUpdate, materializePlans, offerNext } from "@teachernow/dispatch";
import { timezoneSchema } from "@teachernow/hr";
import { isPaymentsFrozen, setPaymentsFrozen } from "@teachernow/ledger";
import { listWiseFundings, recordWiseFunding } from "@teachernow/payouts";
import { resolveDispute, settleSession, voidRejectedSession } from "@teachernow/sessions";
import { platformProcedure, router } from "../trpc";
import { baseUrl } from "./teacher-portal";

// Panoda tam adres gösterilmez: 'a***@dom.com' (log değil API yanıtı — pii-linter kapsamı dışı).
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***@${email.slice(at + 1)}`;
}

/** Sağlık şeridi worker eşikleri (ms): cron aralığı + makul gecikme payı (healthz deseni). */
const HEALTH_WORKER_STALE_MS: Record<string, number> = {
  "invariant-sentinel": 2 * 60 * 60_000, // saatlik cron → 2 saat
  "dispatch-materializer": 26 * 60 * 60_000, // günlük cron → 26 saat
  "offer-timeout-sweeper": 15 * 60_000, // 5 dk cron → 15 dk
  "notification-dispatcher": 10 * 60_000, // 2 dk cron → 10 dk
  "backfill-sweeper": 30 * 60_000, // 10 dk cron → 30 dk
  "payout-reconciler": 30 * 60_000, // 15 dk cron → 30 dk
  "hr-reminders": 26 * 60 * 60_000, // günlük cron → 26 saat
  "low-balance-check": 26 * 60 * 60_000, // günlük cron → 26 saat
  "external-reconciler": 26 * 60 * 60_000, // günlük cron → 26 saat
};

/** Funnel adım sırası — geçiş süresi medyanları bu ardışık çiftler üzerinden hesaplanır. */
const FUNNEL_STEP_ORDER = [
  "funnel_school_created",
  "funnel_wallet_funded",
  "funnel_roster_imported",
  "funnel_first_plan",
  "funnel_wizard_done",
];

/** Medyan (saat cinsi girdi bekler); boş dizide null. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
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

  // P1-C (tur-2): manuel kill-switch iz bırakmıyordu. Artık SEBEP zorunlu; bayrak değişimi
  // AYNI transaction'da audit_log'a yazılır ve DONDURMA'da platform_alert outbox'a düşer
  // (sentinel-engage yolundaki alarmın manuel karşılığı — bir admin sessizce donduramaz).
  setPaymentsFrozen: platformProcedure
    .input(z.object({ frozen: z.boolean(), reason: z.string().trim().min(5).max(500) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.pool.withPlatform(async (db) => {
        await setPaymentsFrozen(db, input.frozen, input.reason);
        // entity_id UUID'dir; system_flag'in UUID'i yok → kolon boş bırakılır (sentinel'in
        // kill_switch_engaged audit'i de aynı deseni kullanır). Anahtar 'after' payload'ında.
        await db.query(
          `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, after)
           VALUES ('platform_admin', $1, $2, 'system_flag', $3::jsonb)`,
          [
            ctx.actor.userId,
            input.frozen ? "payments_frozen_on" : "payments_frozen_off",
            JSON.stringify({ flag: "payments_frozen", frozen: input.frozen, reason: input.reason }),
          ],
        );
        if (input.frozen) {
          await db.query(
            `INSERT INTO notification_outbox (recipient_email, template, payload)
             VALUES ($1, 'platform_alert', $2::jsonb)`,
            [
              process.env.ALERT_EMAIL ?? "alerts@yerel",
              JSON.stringify({
                checks: ["manual_kill_switch"],
                detail: `Ödemeler admin tarafından MANUEL donduruldu. Sebep: ${input.reason}`,
              }),
            ],
          );
        }
      });
      return { frozen: input.frozen };
    }),

  // ---- Sağlık şeridi (/admin üstü, denetim P2) ----

  // Tek bakışta operasyon durumu: bugünkü dersler (Europe/Istanbul günü — admin yüzü
  // Türkiye'den bakar), şu an canlı ders, en eski bekleyen havale yaşı, failed payout,
  // worker heartbeat tazeliği (eşikler cron aralığı + pay), bekleyen bildirim sayısı ve
  // e-posta teslim hattı durumu (tur-2 P0-C: anahtar/tıkanıklık görünür olmalı).
  healthStrip: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const today = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM booking_slot
          WHERE (starts_at AT TIME ZONE 'Europe/Istanbul')::date =
                (now() AT TIME ZONE 'Europe/Istanbul')::date`,
      );
      const live = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM class_session
          WHERE started_at IS NOT NULL AND ended_at IS NULL`,
      );
      const oldestPending = await db.query<{ age_days: number | null }>(
        `SELECT EXTRACT(EPOCH FROM (now() - min(created_at))) / 86400.0 AS age_days
           FROM topup_attempt
          WHERE method = 'bank_transfer' AND status = 'pending_review'`,
      );
      const failedPayouts = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM payout WHERE status = 'failed'",
      );
      // P2 (tur-2): 6 saatten uzun 'submitted' kalan payout Wise'da takılmış olabilir —
      // healthStrip yalnız failed sayıyordu; stuck-submitted de rozetlenir.
      const stuckPayouts = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM payout
          WHERE status = 'submitted' AND updated_at < now() - interval '6 hours'`,
      );
      const pendingNotifications = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM notification_outbox WHERE status = 'pending'",
      );
      // E-posta hattı (denetim tur-2 P0-C): anahtar yokken ya da dispatcher tıkalıyken
      // hiçbir gösterge kırmızıya dönmüyordu — en eski pending'in yaşı da ölçülür.
      const oldestPendingNotif = await db.query<{ age_min: number | null }>(
        `SELECT EXTRACT(EPOCH FROM (now() - min(created_at))) / 60.0 AS age_min
           FROM notification_outbox
          WHERE status = 'pending'`,
      );
      const hb = await db.query<{ job: string; last_run_at: Date }>(
        "SELECT job, last_run_at FROM worker_heartbeat WHERE job = ANY($1::text[])",
        [Object.keys(HEALTH_WORKER_STALE_MS)],
      );
      const lastRunByJob = new Map(hb.rows.map((r) => [r.job, r.last_run_at]));
      const now = Date.now();
      const workers = Object.entries(HEALTH_WORKER_STALE_MS).map(([job, staleAfterMs]) => {
        const lastRunAt = lastRunByJob.get(job) ?? null;
        return {
          job,
          lastRunAt,
          stale: lastRunAt === null || now - lastRunAt.getTime() > staleAfterMs,
        };
      });
      const oldestAge = oldestPending.rows[0]?.age_days;
      const oldestNotifAge = oldestPendingNotif.rows[0]?.age_min;
      return {
        todayLessonCount: Number(today.rows[0]?.n ?? 0),
        liveLessonCount: Number(live.rows[0]?.n ?? 0),
        oldestPendingTopupDays: oldestAge === null || oldestAge === undefined ? null : Number(oldestAge),
        failedPayoutCount: Number(failedPayouts.rows[0]?.n ?? 0),
        stuckPayoutCount: Number(stuckPayouts.rows[0]?.n ?? 0),
        pendingNotificationCount: Number(pendingNotifications.rows[0]?.n ?? 0),
        // E-posta teslim hattı durumu (P0-C): configured = RESEND anahtarı takılı mı;
        // pending + en eski bekleme süresi karoyu kırmızıya döndüren iki sinyaldir.
        emailPipeline: {
          configured: Boolean(process.env.RESEND_API_KEY),
          pending: Number(pendingNotifications.rows[0]?.n ?? 0),
          oldestPendingMinutes:
            oldestNotifAge === null || oldestNotifAge === undefined ? null : Number(oldestNotifAge),
        },
        workers,
      };
    });
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

      // Funnel geçiş SÜRELERİ (denetim P2): okul başına adımın İLK olayı alınır,
      // ardışık adım çiftinin farkı (saat) toplanır; medyan JS'te (pilot ölçeği küçük).
      const funnelFirsts = await db.query<{ school_id: string; action: string; first_at: Date }>(
        `SELECT school_id, action, min(occurred_at) AS first_at
           FROM audit_log
          WHERE action LIKE 'funnel_%' AND school_id IS NOT NULL
          GROUP BY school_id, action`,
      );
      const firstsBySchool = new Map<string, Map<string, Date>>();
      for (const r of funnelFirsts.rows) {
        const m = firstsBySchool.get(r.school_id) ?? new Map<string, Date>();
        m.set(r.action, r.first_at);
        firstsBySchool.set(r.school_id, m);
      }
      const funnelDurations = FUNNEL_STEP_ORDER.slice(0, -1).map((fromAction, i) => {
        const toAction = FUNNEL_STEP_ORDER[i + 1]!;
        const diffsHours: number[] = [];
        for (const m of firstsBySchool.values()) {
          const from = m.get(fromAction);
          const to = m.get(toAction);
          if (from && to) diffsHours.push((to.getTime() - from.getTime()) / 3_600_000);
        }
        return {
          fromAction,
          toAction,
          schoolCount: diffsHours.length,
          medianHours: median(diffsHours),
        };
      });

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

      // Dosaj gerçekleşmesi DAKİKA bazında (denetim P2): settle edilmiş dosage_min toplamı
      // / "olması gereken" derslerin planlı dakika toplamı (sonuçlanmış slotlar — aynı
      // pencere). Sayım oranı kaba kalıyordu: kısa biten ders sayımda tam görünür.
      const minutes = await db.query<{ planned_min: string; settled_min: string }>(
        `SELECT COALESCE(sum(EXTRACT(EPOCH FROM (s.ends_at - s.starts_at)) / 60.0)
                  FILTER (WHERE s.status IN ('completed', 'escalated', 'no_show_teacher')), 0)
                  AS planned_min,
                COALESCE(sum(cs.dosage_min) FILTER (WHERE cs.status = 'settled'), 0)
                  AS settled_min
           FROM booking_slot s
           LEFT JOIN class_session cs ON cs.slot_id = s.id
          WHERE s.starts_at >= now() - interval '28 days'
            AND s.starts_at <  now() + interval '28 days'`,
      );
      const plannedMinutes = Math.round(Number(minutes.rows[0]?.planned_min ?? 0));
      const settledMinutes = Math.round(Number(minutes.rows[0]?.settled_min ?? 0));

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

      // Repeat-topup ORANI (denetim P2): ≥2 settled top-up'lı okul / ≥1 settled top-up'lı
      // okul — payda "hiç yükleme yapmamış" okulları içermez (oran retention'ı ölçer).
      const repeatTopup = await db.query<{ repeat_schools: string; funded_schools: string }>(
        `SELECT count(*) FILTER (WHERE n >= 2) AS repeat_schools,
                count(*) AS funded_schools
           FROM (SELECT school_id, count(*) AS n FROM topup_attempt
                  WHERE status = 'settled' GROUP BY school_id) r`,
      );
      const repeatTopupSchools = Number(repeatTopup.rows[0]?.repeat_schools ?? 0);
      const fundedSchools = Number(repeatTopup.rows[0]?.funded_schools ?? 0);

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
          // Adımlar arası geçiş süresi medyanı (saat) — yalnız iki adımı da yaşamış okullar.
          funnelDurations,
        },
        dosage: {
          windowDays: 28,
          slotCounts,
          // Gerçekleşme oranı: completed / (completed + escalated + no_show) — 0..1, veri yoksa null.
          realizationRate: realizationDenom > 0 ? completed / realizationDenom : null,
          // Dakika bazında gerçekleşme: settle edilmiş dosaj dk / planlı dk (denetim P2).
          plannedMinutes,
          settledMinutes,
          minuteRealizationRate: plannedMinutes > 0 ? settledMinutes / plannedMinutes : null,
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
          fundedSchools,
          // Oran: ≥2 settled top-up'lı okul / ≥1 settled top-up'lı okul — veri yoksa null.
          repeatTopupRate: fundedSchools > 0 ? repeatTopupSchools / fundedSchools : null,
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
          // IANA doğrulamalı (denetim P1): bozuk tz eğitmen eşleştirmesini kaydırır.
          timezone: timezoneSchema,
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

  // ---- G0 kapısı (0015): okul minors bayrağı yönetimi ----

  // Okulun reşit-olmayan içerip içermediği dispatch uygunluğunu belirler: minors=true
  // okulda yalnız safeguarding_ready (kimlik+ülke-sabıka verified) eğitmen teklif alır.
  // Varsayılan TRUE (güvenli taraf); yalnız-yetişkin okul buradan kapatılır.
  listSchools: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{ id: string; name: string; minors: boolean; created_at: Date }>(
        "SELECT id, name, minors, created_at FROM school ORDER BY created_at",
      );
      return res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        minors: r.minors,
        createdAt: r.created_at,
      }));
    });
  }),

  setSchoolMinors: platformProcedure
    .input(z.object({ schoolId: z.string().uuid(), minors: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const res = await db.query(
          "UPDATE school SET minors = $2, updated_at = now() WHERE id = $1",
          [input.schoolId, input.minors],
        );
        if (res.rowCount !== 1) {
          throw new TRPCError({ code: "NOT_FOUND", message: "okul bulunamadı" });
        }
        await db.query(
          `INSERT INTO audit_log (actor_kind, actor_id, school_id, action, entity_type, entity_id, after)
           VALUES ('platform_admin', $1, $2, 'school_minors_set', 'school', $2, $3::jsonb)`,
          [ctx.actor.userId, input.schoolId, JSON.stringify({ minors: input.minors })],
        );
        return { schoolId: input.schoolId, minors: input.minors };
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
  // slot 'scheduled' kalır; review_rejected_at damgası (0016) oturumu görünür çözüm
  // kuyruğuna (listRejectedSessions) düşürür — nihai karar orada verilir.
  rejectSettle: platformProcedure
    .input(z.object({ sessionId: z.string().uuid(), note: z.string().trim().min(2).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const res = await db.query<{ school_id: string; review_reason: string | null }>(
          `UPDATE class_session
              SET review_required = false, review_rejected_at = now(), updated_at = now()
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
              // Para bilinçli işlenmedi: oturum review_rejected_at damgasıyla görünür
              // çözüm kuyruğuna düşer; nihai karar (tam iade / yeniden settle) orada.
              money_untouched: true,
            }),
          ],
        );
        return { sessionId: input.sessionId };
      });
    }),

  // ---- Ret sonrası para çözümü (denetim tur-2 P1-B) ----

  // Çözüm bekleyen retler: settle'ı REDDEDİLMİŞ (review_rejected_at dolu) ama parası
  // hâlâ hold'da bekleyen ended oturumlar. Slot voided_review/iade olunca (ya da oturum
  // yeniden settle edilince) satır bu listeden kendiliğinden düşer.
  listRejectedSessions: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        id: string;
        review_rejected_at: Date;
        review_reason: string | null;
        starts_at: Date;
        ends_at: Date;
        price_cents: string; // pg bigint → string
        school_name: string;
        class_name: string;
        teacher_name: string;
      }>(
        `SELECT cs.id, cs.review_rejected_at, cs.review_reason,
                s.starts_at, s.ends_at, s.price_cents,
                sch.name AS school_name, cg.name AS class_name, t.full_name AS teacher_name
           FROM class_session cs
           JOIN booking_slot s ON s.id = cs.slot_id
           JOIN school sch ON sch.id = cs.school_id
           JOIN class_group cg ON cg.id = cs.class_group_id
           JOIN teacher t ON t.id = cs.teacher_id
          WHERE cs.review_rejected_at IS NOT NULL
            AND cs.settle_txn_id IS NULL
            AND cs.status = 'ended'
            AND s.status = 'scheduled'
          ORDER BY cs.review_rejected_at`,
      );
      return res.rows.map((r) => ({
        sessionId: r.id,
        schoolName: r.school_name,
        className: r.class_name,
        teacherName: r.teacher_name,
        lessonStartsAt: r.starts_at,
        lessonEndsAt: r.ends_at,
        priceCents: Number(r.price_cents),
        rejectedAt: r.review_rejected_at,
        reason: r.review_reason,
      }));
    });
  }),

  // Tam iade kararı: modül tek transaction'da hold'u okula geri verir, slot'u
  // voided_review'a kapatır ve eğitmene bilgilendirme e-postasını outbox'a düşürür.
  voidRejectedSessionProc: platformProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const res = await voidRejectedSession(ctx.pool, { sessionId: input.sessionId });
        return { sessionId: input.sessionId, refundCents: res.refundCents, txnId: res.txnId };
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : String(err),
        });
      }
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

  // ---- Kart itirazları (denetim P1) ----

  // Dispute başına SON durum (aynı dispute'un yaşam döngüsü ayrı event satırlarıyla gelir);
  // açık olanlar (needs_response/under_review) listenin üstünde. Salt görünürlük — para
  // düzeltmesi bu uçtan YAPILMAZ (düzeltme = mevcut reversal yolları).
  listChargebacks: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        id: string;
        stripe_dispute_id: string;
        payment_intent_id: string | null;
        amount_cents: string; // pg bigint → string
        currency: string;
        status: string;
        created_at: Date;
        school_name: string | null;
      }>(
        `SELECT DISTINCT ON (c.stripe_dispute_id)
                c.id, c.stripe_dispute_id, c.payment_intent_id, c.amount_cents, c.currency,
                c.status, c.created_at, s.name AS school_name
           FROM chargeback_event c
           LEFT JOIN school s ON s.id = c.school_id
          ORDER BY c.stripe_dispute_id, c.created_at DESC`,
      );
      const open = (status: string) => status === "needs_response" || status === "under_review";
      return res.rows
        .map((r) => ({
          id: r.id,
          disputeId: r.stripe_dispute_id,
          paymentIntentId: r.payment_intent_id,
          amountCents: Number(r.amount_cents),
          currency: r.currency.trim(),
          status: r.status,
          createdAt: r.created_at,
          schoolName: r.school_name,
          open: open(r.status),
        }))
        .sort((a, b) =>
          a.open === b.open
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.open
              ? -1
              : 1,
        );
    });
  }),

  // ---- Wise fonlaması (tur-2 P1-D: çift-kayıt) ----

  // Kurucu kendi bankasından Wise'a payout float'u aktardığında BUNU ledger'a yazar:
  // [wise_clearing −X, platform_capital +X]. Böylece −SUM(wise_clearing) = fonlama − ödenen =
  // Wise'ın GERÇEK bakiyesi olur ve mutabakat (aşağıda) anlamlı hâle gelir. PARA HAREKETİDİR
  // (snapshot değil): yalnız gerçekten transfer yaptığında gir.
  recordWiseFunding: platformProcedure
    .input(
      z.object({
        amountUsd: z.number().positive().max(10_000_000),
        note: z.string().trim().max(500).optional(),
        // İstemcinin form-başına ürettiği idempotency anahtarı (çift-tık/yeniden gönderim koruması).
        idempotencyKey: z.string().min(8).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const amountCents = Math.round(input.amountUsd * 100);
      return ctx.pool.withPlatform((db) =>
        recordWiseFunding(db, {
          amountCents,
          createdBy: ctx.actor.userId,
          ...(input.note ? { note: input.note } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        }),
      );
    }),

  listWiseFundings: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform((db) => listWiseFundings(db));
  }),

  // ---- Dış bakiye mutabakatı (denetim P1) ----

  // Manuel Wise bakiye beyanı: kurucu Wise panosundan okuduğu değeri girer.
  // Para OYNAMAZ — yalnız snapshot satırı; mutabakat farkı listExternalBalances'ta görünür.
  recordExternalBalance: platformProcedure
    .input(
      z.object({
        balanceCents: z
          .number()
          .int()
          .min(-100_000_000_000)
          .max(100_000_000_000),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const res = await db.query<{ id: string }>(
          `INSERT INTO external_balance_snapshot (provider, balance_cents, currency, source, note)
           VALUES ('wise', $1, 'USD', 'manual', $2)
           RETURNING id`,
          [input.balanceCents, input.note ?? null],
        );
        const row = res.rows[0];
        if (!row) throw new Error("recordExternalBalance: INSERT satır dönmedi");
        return { id: row.id };
      });
    }),

  // Son 10 snapshot + sağlayıcı başına ledger clearing karşılaştırması.
  // İşaret kuralı: clearing hesapları bu ledger'da varlık tarafını NEGATİF taşır
  // (topup: school_cash +, stripe_clearing −). Sağlayıcıda "olması gereken" para
  // dolayısıyla −SUM(entries)'tir; fark = snapshot − beklenen.
  listExternalBalances: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const snaps = await db.query<{
        id: string;
        provider: "stripe" | "wise";
        balance_cents: string;
        currency: string;
        source: string;
        note: string | null;
        captured_at: Date;
      }>(
        `SELECT id, provider, balance_cents, currency, source, note, captured_at
           FROM external_balance_snapshot
          ORDER BY captured_at DESC
          LIMIT 10`,
      );
      // clearing hesapları track_balance dışıdır (cache kolonu güncellenmez) —
      // bakiye entry toplamından okunur (metrics'teki sum deseni).
      const ledger = await db.query<{ kind: string; sum_cents: string }>(
        `SELECT a.kind, COALESCE(sum(e.amount_cents), 0) AS sum_cents
           FROM ledger_account a
           LEFT JOIN ledger_entry e ON e.account_id = a.id
          WHERE a.owner_type = 'platform' AND a.kind IN ('stripe_clearing', 'wise_clearing')
          GROUP BY a.kind`,
      );
      const sums = new Map(ledger.rows.map((r) => [r.kind, Number(r.sum_cents)]));
      const latest = await db.query<{
        provider: "stripe" | "wise";
        balance_cents: string;
        captured_at: Date;
      }>(
        `SELECT DISTINCT ON (provider) provider, balance_cents, captured_at
           FROM external_balance_snapshot
          ORDER BY provider, captured_at DESC`,
      );
      const latestByProvider = new Map(latest.rows.map((r) => [r.provider, r]));

      const providers: { provider: "stripe" | "wise"; kind: string }[] = [
        { provider: "stripe", kind: "stripe_clearing" },
        { provider: "wise", kind: "wise_clearing" },
      ];
      return {
        snapshots: snaps.rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          balanceCents: Number(r.balance_cents),
          currency: r.currency.trim(),
          source: r.source,
          note: r.note,
          capturedAt: r.captured_at,
        })),
        reconciliation: providers.map(({ provider, kind }) => {
          // 0 - x: negatif sıfır (-0) üretmez (superjson -0'ı ayrıca kodluyor).
          const expectedCents = 0 - (sums.get(kind) ?? 0);
          const snap = latestByProvider.get(provider) ?? null;
          const snapshotCents = snap ? Number(snap.balance_cents) : null;
          return {
            provider,
            ledgerExpectedCents: expectedCents,
            snapshotCents,
            snapshotAt: snap?.captured_at ?? null,
            diffCents: snapshotCents === null ? null : snapshotCents - expectedCents,
          };
        }),
      };
    });
  }),
});
