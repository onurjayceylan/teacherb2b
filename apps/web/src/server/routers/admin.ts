// Platform yönetimi: bekleyen havale top-up'ları, banka hesapları, payments_frozen anahtarı.
import { z } from "zod";
import { adminSettleBankTopup } from "@teachernow/billing";
import { isPaymentsFrozen, setPaymentsFrozen } from "@teachernow/ledger";
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
});
