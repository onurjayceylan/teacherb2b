// Backfill süpürücüsü sarmalayıcısı: (1) P0-B — bakiye yüklenmiş okulların bloke
// slotlarını yeniden fonlamayı dener (retryBlockedSlots), (2) eğitmensiz kalmış
// gelecekteki slotları yeniden teklife açar, SLA penceresine düşenleri escalate eder.
// İş mantığının tamamı @teachernow/dispatch'te — burası yalnız ince sarmalayıcı;
// heartbeat result'ı iki adımın sayaçlarını birlikte taşır.
import type { ActorPool } from "@teachernow/db";
import {
  retryBlockedSlots,
  sweepBackfill,
  type SweepBackfillResult,
} from "@teachernow/dispatch";

export interface BackfillJobResult extends SweepBackfillResult {
  /** retryBlockedSlots: hold açılıp scheduled'a dönen bloke slot sayısı */
  retried: number;
  /** retryBlockedSlots: bakiye yetmediği için bloke kalan slot sayısı */
  stillBlocked: number;
}

export async function runBackfillSweep(pool: ActorPool): Promise<BackfillJobResult> {
  // Önce bloke slot retry'ı: açılan slot aynı koşumun sweep'ine 'scheduled' olarak girer.
  const retry = await retryBlockedSlots(pool);
  const sweep = await sweepBackfill(pool);
  return { ...sweep, retried: retry.retried, stillBlocked: retry.stillBlocked };
}
