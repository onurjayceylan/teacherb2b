// Cüzdan: aktif okulun school_cash bakiyesi (cache kolonu — tek yazım kapısı ledger'da).
import { ensureAccount, getCachedBalance } from "@teachernow/ledger";
import { router, schoolProcedure } from "../trpc";

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
});
