// Platform yönetimi: bekleyen havale top-up'ları, banka hesapları, payments_frozen anahtarı,
// dispatch operasyonları (eğitmen müsaitliği, materializer tetiği, pool fiyat kartı, re-offer).
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminSettleBankTopup } from "@teachernow/billing";
import { getSlotForUpdate, materializePlans, offerNext } from "@teachernow/dispatch";
import { isPaymentsFrozen, setPaymentsFrozen } from "@teachernow/ledger";
import { resolveDispute } from "@teachernow/sessions";
import { platformProcedure, router } from "../trpc";

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
        return { ok: true as const, teacherId: next.teacherId, token: next.token };
      });
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
