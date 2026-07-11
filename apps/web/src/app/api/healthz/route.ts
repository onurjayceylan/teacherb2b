// Sağlık ucu: DB ping + payments_frozen + worker tazeliği (worker_heartbeat).
// İzleme/uptime kontrolleri için. HTTP her zaman 200 döner (Render healthcheck web'i
// worker gecikti diye öldürmesin) — sorun yalnız gövdede ok:false olarak raporlanır;
// sentetik prob (tools/synthetic-probe.mjs) gövdeyi denetleyip alarm üretir.
// İlk deploy'da worker henüz hiç koşmamışken lastRunAt:"never" → workersOk:false
// BİLİNÇLİ davranıştır: worker'ın ayağa kalktığı ilk koşumla yeşile döner.
import { isPaymentsFrozen } from "@teachernow/ledger";
import { getPool } from "../../../lib/pool";

export const dynamic = "force-dynamic";

/** Job başına tazelik eşiği (ms): cron aralığı + makul gecikme payı. */
const WORKER_STALE_AFTER_MS: Record<string, number> = {
  "invariant-sentinel": 2 * 60 * 60_000, // saatlik cron → 2 saat
  "dispatch-materializer": 26 * 60 * 60_000, // günlük cron → 26 saat
  "offer-timeout-sweeper": 15 * 60_000, // 5 dk cron → 15 dk
  "notification-dispatcher": 10 * 60_000, // 2 dk cron → 10 dk
  "backfill-sweeper": 30 * 60_000, // 10 dk cron → 30 dk
  "external-reconciler": 26 * 60 * 60_000, // günlük cron (P1) → 26 saat
};

interface WorkerFreshness {
  lastRunAt: string; // ISO ya da hiç koşmadıysa "never"
  stale: boolean;
}

/** P0-C: e-posta teslim hattı görünürlüğü — "dispatcher yeşil ama hiç mail çıkmıyor"
 * durumu artık gövdede ayrı alan olarak raporlanır. */
interface EmailPipelineHealth {
  /** RESEND_API_KEY tanımlı mı (gönderici var mı) */
  configured: boolean;
  /** outbox'ta bekleyen (pending) kayıt sayısı */
  pending: number;
  /** en eski pending kaydın yaşı (dakika); pending yoksa null */
  oldestPendingMinutes: number | null;
  /** false: (anahtar yok VE bekleyen var) YA DA (anahtar var VE en eski pending > 60 dk) */
  ok: boolean;
}

export async function GET(): Promise<Response> {
  try {
    const { paymentsFrozen, heartbeats, outbox } = await getPool().withPlatform(async (db) => {
      await db.query("SELECT 1");
      const frozen = await isPaymentsFrozen(db);
      const hb = await db.query<{ job: string; last_run_at: Date }>(
        "SELECT job, last_run_at FROM worker_heartbeat WHERE job = ANY($1::text[])",
        [Object.keys(WORKER_STALE_AFTER_MS)],
      );
      const ob = await db.query<{ pending: string; oldest_created_at: Date | null }>(
        `SELECT count(*) AS pending, min(created_at) AS oldest_created_at
           FROM notification_outbox WHERE status = 'pending'`,
      );
      return { paymentsFrozen: frozen, heartbeats: hb.rows, outbox: ob.rows[0] ?? null };
    });

    const now = Date.now();
    const workers: Record<string, WorkerFreshness> = {};
    let workersOk = true;
    for (const [job, staleAfterMs] of Object.entries(WORKER_STALE_AFTER_MS)) {
      const row = heartbeats.find((h) => h.job === job);
      if (!row) {
        workers[job] = { lastRunAt: "never", stale: true };
        workersOk = false;
        continue;
      }
      const stale = now - row.last_run_at.getTime() > staleAfterMs;
      workers[job] = { lastRunAt: row.last_run_at.toISOString(), stale };
      if (stale) workersOk = false;
    }

    // P0-C: e-posta hattı durumu. configured=false + pending>0 = anahtar takılmadan
    // bildirimler birikiyor (kurucu link kuryesi); configured=true + oldest>60 dk =
    // gönderici var ama hat tıkalı (dispatcher hata dönüyor / koşmuyor olabilir).
    const emailConfigured = Boolean(process.env.RESEND_API_KEY);
    const pendingCount = Number(outbox?.pending ?? 0);
    const oldestPendingMinutes =
      pendingCount > 0 && outbox?.oldest_created_at
        ? Math.floor((now - outbox.oldest_created_at.getTime()) / 60_000)
        : null;
    const emailPipeline: EmailPipelineHealth = {
      configured: emailConfigured,
      pending: pendingCount,
      oldestPendingMinutes,
      ok: !(
        (!emailConfigured && pendingCount > 0) ||
        (emailConfigured && (oldestPendingMinutes ?? 0) > 60)
      ),
    };

    return Response.json({
      // db zaten up (aksi catch'e düşer); emailPipeline.ok üst-düzey ok'a DA girer
      ok: !paymentsFrozen && workersOk && emailPipeline.ok,
      db: "up",
      paymentsFrozen,
      workers,
      workersOk,
      emailPipeline,
    });
  } catch {
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
}
