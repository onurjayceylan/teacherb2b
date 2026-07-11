// worker_heartbeat: job başına tek satır — ilk çağrı INSERT, sonrakiler UPSERT.
// healthz/prob bu tabloyla worker'ın yaşadığını doğrular (P0 görünmezlik bulgusu).
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { recordHeartbeat } from "../src/heartbeat.js";

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

interface HeartbeatRow {
  job: string;
  last_run_at: Date;
  last_result: unknown;
}

async function readHeartbeats(): Promise<HeartbeatRow[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<HeartbeatRow>(
      "SELECT job, last_run_at, last_result FROM worker_heartbeat ORDER BY job",
    );
    return res.rows;
  });
}

test("ilk çağrı INSERT: last_run_at damgalı, last_result koşum özeti", async () => {
  await recordHeartbeat(tdb.pool, "invariant-sentinel", {
    critical: 0,
    warnings: 2,
    engagedKillSwitch: false,
  });

  const rows = await readHeartbeats();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.job).toBe("invariant-sentinel");
  expect(rows[0]!.last_result).toEqual({ critical: 0, warnings: 2, engagedKillSwitch: false });
  expect(Math.abs(rows[0]!.last_run_at.getTime() - Date.now())).toBeLessThan(60_000);
});

test("ikinci çağrı UPSERT: satır sayısı artmaz, last_run_at ilerler, last_result yenilenir", async () => {
  const before = (await readHeartbeats())[0]!;

  // now() transaction başlangıcını damgalar — ayrı tx'ler arasında ilerlediğini görmek
  // için kısa bekleme yeterli.
  await new Promise((resolve) => setTimeout(resolve, 25));
  await recordHeartbeat(tdb.pool, "invariant-sentinel", {
    critical: 1,
    warnings: 0,
    engagedKillSwitch: true,
  });

  const rows = await readHeartbeats();
  expect(rows).toHaveLength(1); // UPSERT — ikinci satır açılmadı
  expect(rows[0]!.last_result).toEqual({ critical: 1, warnings: 0, engagedKillSwitch: true });
  expect(rows[0]!.last_run_at.getTime()).toBeGreaterThan(before.last_run_at.getTime());
});

test("farklı job'lar ayrı satır; result verilmezse last_result NULL", async () => {
  await recordHeartbeat(tdb.pool, "notification-dispatcher");

  const rows = await readHeartbeats();
  expect(rows.map((r) => r.job)).toEqual(["invariant-sentinel", "notification-dispatcher"]);
  expect(rows[1]!.last_result).toBeNull();
});
