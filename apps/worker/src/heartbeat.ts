// Worker görünürlüğü (P0 bulgusu): her cron job'ı koşumunu worker_heartbeat'e damgalar.
// healthz (web) ve sentetik prob bu tabloyu okuyarak worker'ın YAŞADIĞINI doğrular —
// worker sessizce ölürse artık kimse fark etmiyor durumu kalmaz.
import type { ActorPool } from "@teachernow/db";

/**
 * job başına tek satır UPSERT: last_run_at ilerler, last_result son koşumun özetini taşır.
 * Özet KÜÇÜK tutulmalı (sayaçlar/bayraklar) — ham kayıt listeleri buraya yazılmaz.
 */
export async function recordHeartbeat(
  pool: ActorPool,
  job: string,
  result?: unknown,
): Promise<void> {
  await pool.withPlatform(async (db) => {
    await db.query(
      `INSERT INTO worker_heartbeat (job, last_run_at, last_result)
       VALUES ($1, now(), $2::jsonb)
       ON CONFLICT (job) DO UPDATE
         SET last_run_at = now(), last_result = EXCLUDED.last_result`,
      [job, result === undefined ? null : JSON.stringify(result)],
    );
  });
}
