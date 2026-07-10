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
});
