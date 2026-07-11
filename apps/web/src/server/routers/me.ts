// me: aktör bilgisi + üyesi olunan okullar + aktif okul (UI'ın açılış sorgusu).
import { z } from "zod";
import type { Db } from "@teachernow/db";
import { authedProcedure, resolveActiveSchoolId, router } from "../trpc";

/** /baslangic sihirbazının funnel adımları (kuzey yıldızı: kayıt→ilk reçete <15 dk). */
export const FUNNEL_STEPS = [
  "school_created",
  "wallet_funded",
  "roster_imported",
  "first_plan",
  "wizard_done",
] as const;

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

  // Funnel ölçümü: sihirbaz adımı tamamlanınca audit_log'a kayıt düşer (append-only iz).
  // authedProcedure bilinçli — 'school_created' adımında okul yeni oluştuğu için
  // schoolProcedure'ün "üyelik yoksa FORBIDDEN" kapısına takılmamalı. Okul bağlamı varsa
  // INSERT okul rolüyle (grant: INSERT ON audit_log TO role_school), yoksa platform
  // bağlamıyla school_id NULL yazılır (ölçüm kaybolmasın diye güvenlik ağı).
  trackFunnel: authedProcedure
    .input(z.object({ step: z.enum(FUNNEL_STEPS) }))
    .mutation(async ({ ctx, input }) => {
      const schoolId = resolveActiveSchoolId(ctx.actor, ctx.preferredSchoolId) ?? null;
      const insert = async (db: Db): Promise<void> => {
        await db.query(
          `INSERT INTO audit_log (actor_kind, actor_id, school_id, action, entity_type, after)
           VALUES ('school_user', $1, $2, $3, 'onboarding_funnel', $4::jsonb)`,
          [ctx.actor.userId, schoolId, `funnel_${input.step}`, JSON.stringify({ step: input.step })],
        );
      };
      if (schoolId) await ctx.pool.withSchool([schoolId], insert);
      else await ctx.pool.withPlatform(insert);
      return { step: input.step, schoolId };
    }),
});
