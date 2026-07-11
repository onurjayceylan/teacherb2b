// Worker girişi: pg-boss saatte bir invariant sentinel'i, günde bir HR hatırlatma
// taramasını koşturur.
import PgBoss from "pg-boss";
import { makePool } from "@teachernow/db";
import { runBackfillSweep } from "./backfill-jobs.js";
import { runDispatchMaterializer, runOfferTimeoutSweeper } from "./dispatch-jobs.js";
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
  });

  await boss.createQueue(HR_REMINDERS_QUEUE);
  await boss.schedule(HR_REMINDERS_QUEUE, "0 6 * * *");
  await boss.work(HR_REMINDERS_QUEUE, async () => {
    const result = await runHrReminders(pool);
    if (result.reminded > 0) {
      console.log(`hr-reminders: ${result.reminded} eğitmen için hatırlatma kaydı yazıldı`);
    }
  });

  // Gece 02:00'de plan materializasyonu: slot + hold + ilk eğitmen teklifi
  await boss.createQueue(DISPATCH_MATERIALIZER_QUEUE);
  await boss.schedule(DISPATCH_MATERIALIZER_QUEUE, "0 2 * * *");
  await boss.work(DISPATCH_MATERIALIZER_QUEUE, async () => {
    const result = await runDispatchMaterializer(pool);
    console.log(
      `dispatch-materializer: created=${result.created} blocked=${result.blocked} skipped=${result.skipped}`,
    );
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
  });

  // 15 dakikada bir: 1 saatten uzun 'submitted' bekleyen payout'lar için alarm
  await boss.createQueue(PAYOUT_RECONCILER_QUEUE);
  await boss.schedule(PAYOUT_RECONCILER_QUEUE, "*/15 * * * *");
  await boss.work(PAYOUT_RECONCILER_QUEUE, async () => {
    const result = await runPayoutReconciler(pool);
    if (result.stuck.length > 0) {
      console.warn(`payout-reconciler: ${result.stuck.length} payout 'submitted'da takılı`);
    }
  });

  // Her sabah 07:00'de: bakiyesi 7 günlük taahhüdün altındaki / bloke slotlu okullara uyarı
  await boss.createQueue(LOW_BALANCE_QUEUE);
  await boss.schedule(LOW_BALANCE_QUEUE, "0 7 * * *");
  await boss.work(LOW_BALANCE_QUEUE, async () => {
    const result = await runLowBalanceCheck(pool);
    if (result.warned > 0) {
      console.log(`low-balance-check: ${result.warned} okul için düşük bakiye uyarısı yazıldı`);
    }
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
