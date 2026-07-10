// Self-serve kayıt çekirdeği: organizasyon + okul + owner üyeliği + school_cash hesabı.
import { z } from "zod";
import { ensureAccount } from "@teachernow/ledger";
import { createOrganization, createSchool, upsertUserWithMembership } from "@teachernow/tenancy";
import { authedProcedure, router } from "../trpc";

export const onboardingRouter = router({
  createSchool: authedProcedure
    .input(
      z.object({
        name: z.string().trim().min(2).max(200),
        country: z.string().trim().length(2).toUpperCase().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.pool.withPlatform(async (db) => {
        const organizationId = await createOrganization(db, { name: input.name });
        const schoolId = await createSchool(db, {
          organizationId,
          name: input.name,
          ...(input.country ? { country: input.country } : {}),
        });
        const { userId } = await upsertUserWithMembership(db, {
          schoolId,
          email: ctx.actor.email,
          role: "owner",
        });
        await ensureAccount(db, { ownerType: "school", ownerId: schoolId, kind: "school_cash" });
        return { organizationId, schoolId, userId };
      });
    }),
});
