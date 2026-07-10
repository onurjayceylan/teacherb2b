// Kök router: tüm alt router'ları birleştirir. AppRouter tipi istemcide type-only kullanılır.
import { router } from "../trpc";
import { adminRouter } from "./admin";
import { hrRouter } from "./hr";
import { lessonsRouter } from "./lessons";
import { meRouter } from "./me";
import { onboardingRouter } from "./onboarding";
import { rosterRouter } from "./roster";
import { teacherOnboardingRouter } from "./teacher-onboarding";
import { topupRouter } from "./topup";
import { walletRouter } from "./wallet";

export const appRouter = router({
  me: meRouter,
  onboarding: onboardingRouter,
  wallet: walletRouter,
  topup: topupRouter,
  admin: adminRouter,
  hr: hrRouter,
  teacherOnboarding: teacherOnboardingRouter,
  roster: rosterRouter,
  lessons: lessonsRouter,
});

export type AppRouter = typeof appRouter;
