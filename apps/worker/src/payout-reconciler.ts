// Payout mutabakat nöbetçisi: insan "Wise'a yükledim" dedikten (submitted) sonra 1 saatten
// uzun süre sonuç dosyası işlenmemişse operasyon takılmış demektir — sentinel'deki WARNING
// deseniyle audit_log'a 'sentinel_warning' yazılır (check 'payout_stuck'); freeze YOK, para
// akışına dokunulmaz. Aynı payout için son 24 saatte aynı warning yazılmışsa tekrar
// YAZILMAZ (alarm spam koruması); dönüş değerinde yine raporlanır.
import type { ActorPool } from "@teachernow/db";

export interface StuckPayout {
  payoutId: string;
  batchId: string;
  submittedAt: string;
}

export interface PayoutReconcilerResult {
  stuck: StuckPayout[];
}

export async function runPayoutReconciler(pool: ActorPool): Promise<PayoutReconcilerResult> {
  return pool.withPlatform(async (db) => {
    const res = await db.query<{
      id: string;
      batch_id: string;
      submitted_at: string;
    }>(
      `SELECT id, batch_id, submitted_at::text AS submitted_at
         FROM payout
        WHERE status = 'submitted' AND submitted_at < now() - interval '1 hour'
        ORDER BY submitted_at`,
    );

    for (const row of res.rows) {
      // 24 saat tekrar koruması — sentinel'in auditWarning deseni
      await db.query(
        `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, after)
         SELECT 'system', 'sentinel_warning', 'payout', $1::uuid, $2::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM audit_log
             WHERE action = 'sentinel_warning'
               AND entity_type = 'payout' AND entity_id = $1::uuid
               AND after->>'check' = 'payout_stuck'
               AND occurred_at > now() - interval '24 hours')`,
        [
          row.id,
          JSON.stringify({
            check: "payout_stuck",
            detail: `batch=${row.batch_id} submitted_at=${row.submitted_at}`,
          }),
        ],
      );
    }

    return {
      stuck: res.rows.map((r) => ({
        payoutId: r.id,
        batchId: r.batch_id,
        submittedAt: r.submitted_at,
      })),
    };
  });
}
