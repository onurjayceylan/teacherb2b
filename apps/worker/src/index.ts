// Worker girişi: pg-boss saatte bir invariant sentinel'i koşturur.
import PgBoss from "pg-boss";
import { makePool } from "@teachernow/db";
import { runInvariantSentinel } from "./sentinel.js";

const SENTINEL_QUEUE = "invariant-sentinel";

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

  console.log("worker: hazır (invariant-sentinel saatlik zamanlandı)");
}

main().catch((err) => {
  console.error("worker başlatılamadı:", err);
  process.exit(1);
});
