// me: aktör bilgisi + üyesi olunan okullar + aktif okul (UI'ın açılış sorgusu).
import { authedProcedure, resolveActiveSchoolId, router } from "../trpc";

export const meRouter = router({
  get: authedProcedure.query(async ({ ctx }) => {
    const schools =
      ctx.actor.schoolIds.length === 0
        ? []
        : await ctx.pool.withSchool(ctx.actor.schoolIds, async (db) => {
            const res = await db.query<{ id: string; name: string }>(
              "SELECT id, name FROM school ORDER BY created_at",
            );
            return res.rows;
          });
    return {
      userId: ctx.actor.userId,
      email: ctx.actor.email,
      isPlatformAdmin: ctx.actor.isPlatformAdmin,
      schools,
      activeSchoolId: resolveActiveSchoolId(ctx.actor, ctx.preferredSchoolId) ?? null,
      // UI kart top-up butonunu devre dışı bırakabilsin diye (sır sızdırmaz, yalnız var/yok).
      stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
    };
  }),
});
