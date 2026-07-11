// Backfill süpürücüsü sarmalayıcısı: eğitmensiz kalmış gelecekteki slotları yeniden
// teklife açar, SLA penceresine düşenleri escalate eder. İş mantığının tamamı
// @teachernow/dispatch'te — burası yalnız ince sarmalayıcı.
import type { ActorPool } from "@teachernow/db";
import { sweepBackfill, type SweepBackfillResult } from "@teachernow/dispatch";

export function runBackfillSweep(pool: ActorPool): Promise<SweepBackfillResult> {
  return sweepBackfill(pool);
}
