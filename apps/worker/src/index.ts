// Worker girişi: pg-boss saatte bir invariant sentinel'i, günde bir HR hatırlatma
// taramasını koşturur. HER job koşum sonunda worker_heartbeat'e damga basar
// (P0 görünmezlik bulgusu) — healthz/prob tazeliği bu tablodan denetler.
import PgBoss from "pg-boss";
import { makePool } from "@teachernow/db";
import { runBackfillSweep } from "./backfill-jobs.js";
import { runDispatchMaterializer, runOfferTimeoutSweeper } from "./dispatch-jobs.js";
import { runExternalReconciler } from "./external-reconciler.js";
import { recordHeartbeat } from "./heartbeat.js";
import { runHrReminders } from "./hr-reminders.js";
import { runLowBalanceCheck } from "./low-balance.js";
import { defaultResendSender, sendPendingNotifications } from "./notification-dispatcher.js";
import { runPayoutReconciler } from "./payout-reconciler.js";
import { runInvariantSentinel } from "./sentinel.js";

const SENTINEL_QUEUE = "invariant-sentinel";
const HR_REMINDERS_QUEUE = "hr-reminders";
const DISPATCH_MATERIALIZER_QUEUE = "dispatch-materializer";
const OFFER_TIMEOUT_QUEUE = "offer-timeout-sweeper";
const BACKFILL_SWEEPER_QUEUE = "backfill-sweeper";
const PAYOUT_RECONCILER_QUEUE = "payout-reconciler";
const LOW_BALANCE_QUEUE = "low-balance-check";
const NOTIFICATION_DISPATCHER_QUEUE = "notification-dispatcher";
const EXTERNAL_RECONCILER_QUEUE = "external-reconciler";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL ortam değişkeni gerekli");

  const pool = makePool(databaseUrl);
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "queue" });
  boss.on("error", (err) => console.error("pg-boss hata:", err));

  await boss.start();
  await boss.createQueue(SENTINEL_QUEUE);
  await boss.schedule(SENTINEL_QUEUE, "0 * * * *");
  await boss.work(SENTINEL_QUEUE, async () => {
    const result = await runInvariantSentinel(pool);
    if (result.engagedKillSwitch) {
      console.error(
        `sentinel: ${result.violations.length} ihlal bulundu, payments_frozen devreye alındı`,
      );
    }
    await recordHeartbeat(pool, SENTINEL_QUEUE, {
      critical: result.critical.length,
      warnings: result.warnings.length,
      engagedKillSwitch: result.engagedKillSwitch,
    });
  });

  await boss.createQueue(HR_REMINDERS_QUEUE);
  await boss.schedule(HR_REMINDERS_QUEUE, "0 6 * * *");
  await boss.work(HR_REMINDERS_QUEUE, async () => {
    const result = await runHrReminders(pool);
    if (result.reminded > 0) {
      console.log(`hr-reminders: ${result.reminded} eğitmen için hatırlatma kaydı yazıldı`);
    }
    await recordHeartbeat(pool, HR_REMINDERS_QUEUE, result);
  });

  // Gece 02:00'de plan materializasyonu: slot + hold + ilk eğitmen teklifi
  await boss.createQueue(DISPATCH_MATERIALIZER_QUEUE);
  await boss.schedule(DISPATCH_MATERIALIZER_QUEUE, "0 2 * * *");
  await boss.work(DISPATCH_MATERIALIZER_QUEUE, async () => {
    const result = await runDispatchMaterializer(pool);
    console.log(
      `dispatch-materializer: created=${result.created} blocked=${result.blocked} skipped=${result.skipped}`,
    );
    await recordHeartbeat(pool, DISPATCH_MATERIALIZER_QUEUE, result);
  });

  // 5 dakikada bir: süresi dolan teklifleri expire et, sıradaki adaya geç
  await boss.createQueue(OFFER_TIMEOUT_QUEUE);
  await boss.schedule(OFFER_TIMEOUT_QUEUE, "*/5 * * * *");
  await boss.work(OFFER_TIMEOUT_QUEUE, async () => {
    const result = await runOfferTimeoutSweeper(pool);
    if (result.expired > 0) {
      console.log(
        `offer-timeout-sweeper: expired=${result.expired} reoffered=${result.reoffered}`,
      );
    }
    await recordHeartbeat(pool, OFFER_TIMEOUT_QUEUE, result);
  });

  // 10 dakikada bir: eğitmensiz slotlara backfill (re-offer) + SLA eskalasyonu
  await boss.createQueue(BACKFILL_SWEEPER_QUEUE);
  await boss.schedule(BACKFILL_SWEEPER_QUEUE, "*/10 * * * *");
  await boss.work(BACKFILL_SWEEPER_QUEUE, async () => {
    const result = await runBackfillSweep(pool);
    if (result.offered + result.reoffered + result.escalated > 0) {
      console.log(
        `backfill-sweeper: offered=${result.offered} reoffered=${result.reoffered} escalated=${result.escalated}`,
      );
    }
    await recordHeartbeat(pool, BACKFILL_SWEEPER_QUEUE, result);
  });

  // 15 dakikada bir: 1 saatten uzun 'submitted' bekleyen payout'lar için alarm
  await boss.createQueue(PAYOUT_RECONCILER_QUEUE);
  await boss.schedule(PAYOUT_RECONCILER_QUEUE, "*/15 * * * *");
  await boss.work(PAYOUT_RECONCILER_QUEUE, async () => {
    const result = await runPayoutReconciler(pool);
    if (result.stuck.length > 0) {
      console.warn(`payout-reconciler: ${result.stuck.length} payout 'submitted'da takılı`);
    }
    await recordHeartbeat(pool, PAYOUT_RECONCILER_QUEUE, { stuck: result.stuck.length });
  });

  // Her sabah 07:00'de: bakiyesi 7 günlük taahhüdün altındaki / bloke slotlu okullara uyarı
  await boss.createQueue(LOW_BALANCE_QUEUE);
  await boss.schedule(LOW_BALANCE_QUEUE, "0 7 * * *");
  await boss.work(LOW_BALANCE_QUEUE, async () => {
    const result = await runLowBalanceCheck(pool);
    if (result.warned > 0) {
      console.log(`low-balance-check: ${result.warned} okul için düşük bakiye uyarısı yazıldı`);
    }
    await recordHeartbeat(pool, LOW_BALANCE_QUEUE, result);
  });

  // 2 dakikada bir: outbox'taki pending e-postaları gönder (RESEND_API_KEY yoksa biriktirir)
  await boss.createQueue(NOTIFICATION_DISPATCHER_QUEUE);
  await boss.schedule(NOTIFICATION_DISPATCHER_QUEUE, "*/2 * * * *");
  await boss.work(NOTIFICATION_DISPATCHER_QUEUE, async () => {
    const apiKey = process.env.RESEND_API_KEY;
    const result = await sendPendingNotifications(
      pool,
      apiKey ? { sender: defaultResendSender(apiKey) } : {},
    );
    if (result.sent + result.failed + result.expired > 0) {
      console.log(
        `notification-dispatcher: sent=${result.sent} failed=${result.failed} expired=${result.expired}`,
      );
    }
    await recordHeartbeat(pool, NOTIFICATION_DISPATCHER_QUEUE, result);
  });

  // Her sabah 07:30'da: dış mutabakat — Stripe/Wise gerçek bakiyesi vs ledger clearing.
  // STRIPE_SECRET_KEY / manuel Wise snapshot'ı yoksa ilgili taraf sessizce atlanır.
  await boss.createQueue(EXTERNAL_RECONCILER_QUEUE);
  await boss.schedule(EXTERNAL_RECONCILER_QUEUE, "30 7 * * *");
  await boss.work(EXTERNAL_RECONCILER_QUEUE, async () => {
    const result = await runExternalReconciler(pool);
    if (result.stripe.alarmed || result.wise.alarmed) {
      console.warn(
        `external-reconciler: bakiye farkı — stripe=${result.stripe.diffCents ?? "atlandı"} ` +
          `wise=${result.wise.diffCents ?? "atlandı"} (cent)`,
      );
    }
    await recordHeartbeat(pool, EXTERNAL_RECONCILER_QUEUE, result);
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return; // çifte sinyalde stop'u tekrar çağırma
    stopping = true;
    console.log(`worker: ${signal} alındı, kapanıyor`);
    await boss.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log("worker: hazır (invariant-sentinel saatlik, hr-reminders günlük zamanlandı)");
}

main().catch((err) => {
  console.error("worker başlatılamadı:", err);
  process.exit(1);
});
