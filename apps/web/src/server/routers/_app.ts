// Kök router: tüm alt router'ları birleştirir. AppRouter tipi istemcide type-only kullanılır.
import { router } from "../trpc";
import { adminRouter } from "./admin";
import { meRouter } from "./me";
import { onboardingRouter } from "./onboarding";
import { topupRouter } from "./topup";
import { walletRouter } from "./wallet";

export const appRouter = router({
  me: meRouter,
  onboarding: onboardingRouter,
  wallet: walletRouter,
  topup: topupRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
