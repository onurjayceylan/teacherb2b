// Cüzdan: aktif okulun school_cash bakiyesi (cache kolonu — tek yazım kapısı ledger'da).
import { z } from "zod";
import { ensureAccount, getCachedBalance } from "@teachernow/ledger";
import { router, schoolProcedure } from "../trpc";

const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "tarih YYYY-AA-GG biçiminde olmalı");

/**
 * Ekstre satırının tip etiketi hesap türü + tutar işaretinden TÜRETİLİR:
 * okul bağlamı ledger_transaction'a (type kolonuna) erişemez — join bilinçli olarak yok.
 */
export function statementLabel(kind: string, amountCents: number): string {
  if (kind === "wallet_hold") return "Rezerv";
  return amountCents >= 0 ? "Yükleme/İade" : "Ders/Kesinti";
}

export const walletRouter = router({
  balance: schoolProcedure.query(async ({ ctx }) => {
    return ctx.withSchoolDb(async (db) => {
      const accountId = await ensureAccount(db, {
        ownerType: "school",
        ownerId: ctx.activeSchoolId,
        kind: "school_cash",
      });
      const balanceCents = await getCachedBalance(db, accountId);
      return { schoolId: ctx.activeSchoolId, accountId, balanceCents, currency: "USD" };
    });
  }),

  // Runway göstergesi: önümüzdeki 28 günün scheduled slot taahhüdü (tutarları zaten
  // hold'da) + serbest bakiye → haftalık ortalamayla kaç haftalık taahhüt karşılanır.
  // Tamamı okul bağlamında: price_cents okul grant'inde var, maliyet kolonu yok.
  runway: schoolProcedure.query(async ({ ctx }) => {
    return ctx.withSchoolDb(async (db) => {
      const accountId = await ensureAccount(db, {
        ownerType: "school",
        ownerId: ctx.activeSchoolId,
        kind: "school_cash",
      });
      const balanceCents = await getCachedBalance(db, accountId);
      const res = await db.query<{ total: string }>(
        `SELECT COALESCE(sum(price_cents), 0) AS total
           FROM booking_slot
          WHERE status = 'scheduled'
            AND starts_at >= now() AND starts_at < now() + interval '28 days'`,
      );
      const committedCents = Number(res.rows[0]?.total ?? 0);
      const weeklyAvgCents = committedCents / 4;
      // Haftalık taahhüt yoksa gösterge anlamsız — UI hiç göstermez (weeks=null).
      const weeks =
        weeklyAvgCents > 0
          ? Math.round(((balanceCents + committedCents) / weeklyAvgCents) * 10) / 10
          : null;
      return { committedCents, weeklyAvgCents: Math.round(weeklyAvgCents), weeks };
    });
  }),

  // Okul ekstresi: TAMAMI okul bağlamında. RLS ikinci hat — ledger_entry yalnız okulun
  // school_id'li satırlarını, ledger_account yalnız okulun kendi hesaplarını döndürür.
  // ledger_transaction okul rolüne KAPALI (type kolonu sızmaz); satır etiketi
  // hesap türü (school_cash / wallet_hold) + tutar işaretinden türetilir.
  statement: schoolProcedure
    .input(
      z
        .object({ from: dateSchema, to: dateSchema })
        .refine((v) => v.to >= v.from, { message: "bitiş başlangıçtan önce olamaz" }),
    )
    .query(async ({ ctx, input }) => {
      return ctx.withSchoolDb(async (db) => {
        // Açılış bakiyesi: dönem başından önceki school_cash hareketlerinin toplamı
        // (akan bakiye nakit hesabını izler; rezerv hareketleri ayrı sütunda gösterilir).
        const opening = await db.query<{ total: string }>(
          `SELECT COALESCE(sum(e.amount_cents), 0) AS total
             FROM ledger_entry e
             JOIN ledger_account a ON a.id = e.account_id
            WHERE a.kind = 'school_cash' AND a.owner_id = $1
              AND e.created_at < $2::date`,
          [ctx.activeSchoolId, input.from],
        );
        const openingBalanceCents = Number(opening.rows[0]?.total ?? 0);

        const res = await db.query<{
          id: string;
          txn_id: string;
          amount_cents: string;
          currency: string;
          created_at: Date;
          kind: string;
        }>(
          `SELECT e.id, e.txn_id, e.amount_cents, e.currency, e.created_at, a.kind
             FROM ledger_entry e
             JOIN ledger_account a ON a.id = e.account_id
            WHERE a.kind IN ('school_cash', 'wallet_hold') AND a.owner_id = $1
              AND e.created_at >= $2::date
              AND e.created_at < ($3::date + interval '1 day')
            ORDER BY e.created_at, e.id`,
          [ctx.activeSchoolId, input.from, input.to],
        );

        let running = openingBalanceCents;
        let inflowCents = 0; // yüklemeler + iadeler (school_cash +)
        let outflowCents = 0; // ders düşümleri / kesintiler (school_cash -)
        let reserveNetCents = 0; // rezerv (wallet_hold) net değişimi
        const rows = res.rows.map((r) => {
          const amountCents = Number(r.amount_cents);
          const isCash = r.kind === "school_cash";
          if (isCash) {
            running += amountCents;
            if (amountCents >= 0) inflowCents += amountCents;
            else outflowCents += -amountCents;
          } else {
            reserveNetCents += amountCents;
          }
          return {
            id: r.id,
            txnId: r.txn_id,
            createdAt: r.created_at,
            kind: r.kind,
            label: statementLabel(r.kind, amountCents),
            amountCents,
            currency: r.currency.trim(),
            // Akan bakiye yalnız nakit hesabını izler; rezerv satırında değişmeden gösterilir.
            balanceCents: running,
          };
        });

        return {
          from: input.from,
          to: input.to,
          openingBalanceCents,
          closingBalanceCents: running,
          totals: { inflowCents, outflowCents, reserveNetCents },
          rows,
        };
      });
    }),
});
