// Dispatch worker işleri: gece plan materializasyonu (slot + hold + ilk teklif) ve
// beş dakikalık teklif zaman aşımı süpürücüsü (expired → sıradaki adaya re-offer).
// İş mantığının tamamı @teachernow/dispatch'te — burası yalnız ince sarmalayıcı.
import type { ActorPool } from "@teachernow/db";
import {
  expireStaleOffers,
  materializePlans,
  type ExpireResult,
  type MaterializeResult,
} from "@teachernow/dispatch";

export function runDispatchMaterializer(pool: ActorPool): Promise<MaterializeResult> {
  return materializePlans(pool);
}

export function runOfferTimeoutSweeper(pool: ActorPool): Promise<ExpireResult> {
  return expireStaleOffers(pool);
}
