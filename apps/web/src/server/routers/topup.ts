// Top-up akışları: banka havalesi (referans kodu) + Stripe Checkout (kart).
import Stripe from "stripe";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { attachStripeRefs, createBankTopup, createCardTopup } from "@teachernow/billing";
import { router, schoolProcedure } from "../trpc";

export interface BankAccountView {
  id: string;
  label: string;
  rail: "eft_tr" | "swift_usd";
  currency: string;
  holder: string;
  iban: string;
  bankName: string;
  swiftBic: string | null;
}

export const topupRouter = router({
  // Okul rolüyle SELECT: RLS yalnız aktif satırları, grant yalnız talimat kolonlarını verir.
  listBankAccounts: schoolProcedure.query(async ({ ctx }) => {
    return ctx.withSchoolDb(async (db) => {
      const res = await db.query<{
        id: string;
        label: string;
        rail: "eft_tr" | "swift_usd";
        currency: string;
        holder: string;
        iban: string;
        bank_name: string;
        swift_bic: string | null;
      }>(
        `SELECT id, label, rail, currency, holder, iban, bank_name, swift_bic
           FROM bank_account
          ORDER BY label`,
      );
      return res.rows.map(
        (r): BankAccountView => ({
          id: r.id,
          label: r.label,
          rail: r.rail,
          currency: r.currency.trim(),
          holder: r.holder,
          iban: r.iban,
          bankName: r.bank_name,
          swiftBic: r.swift_bic,
        }),
      );
    });
  }),

  createBank: schoolProcedure
    .input(
      z.object({
        amountCents: z.number().int().positive().max(100_000_000),
        bankAccountId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.withSchoolDb(async (db) =>
        createBankTopup(db, {
          schoolId: ctx.activeSchoolId,
          amountCents: input.amountCents,
          ...(input.bankAccountId ? { bankAccountId: input.bankAccountId } : {}),
          createdBy: ctx.actor.userId,
        }),
      );
    }),

  createCardCheckout: schoolProcedure
    .input(z.object({ amountCents: z.number().int().min(100).max(100_000_000) }))
    .mutation(async ({ ctx, input }) => {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "stripe yapılandırılmadı" });
      }
      const stripe = new Stripe(stripeKey);
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3010";

      const topupId = await ctx.withSchoolDb(async (db) =>
        createCardTopup(db, {
          schoolId: ctx.activeSchoolId,
          amountCents: input.amountCents,
          createdBy: ctx.actor.userId,
        }),
      );

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: input.amountCents,
              product_data: { name: "Teachernow bakiye yükleme" },
            },
          },
        ],
        success_url: `${baseUrl}/okul?kart=basarili`,
        cancel_url: `${baseUrl}/okul?kart=iptal`,
        metadata: { topup_id: topupId },
      });

      // payment_intent Checkout'ta ödeme anında oluşur; şimdilik yalnız checkout id bağlanır,
      // webhook payment_intent.succeeded eşleşmesi processStripeEvent tarafında yapılır.
      await ctx.withSchoolDb(async (db) => attachStripeRefs(db, { topupId, checkoutId: session.id }));

      if (!session.url) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "stripe checkout url dönmedi" });
      }
      return { topupId, url: session.url };
    }),
});
