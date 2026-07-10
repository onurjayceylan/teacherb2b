import { afterAll, beforeAll, expect, test } from "vitest";
import PgBoss from "pg-boss";
import { createTestDb, type TestDb } from "@teachernow/db";

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

test("pg-boss smoke: start + createQueue + send + work tek işi işler", async () => {
  const boss = new PgBoss({ connectionString: tdb.url, schema: "queue" });
  try {
    await boss.start();
    await boss.createQueue("smoke");

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const received: unknown[] = [];

    await boss.work<{ n: number }>("smoke", async (jobs) => {
      for (const job of jobs) received.push(job.data);
      resolveDone();
    });
    const jobId = await boss.send("smoke", { n: 42 });
    expect(jobId).toBeTruthy();

    await done;
    expect(received).toEqual([{ n: 42 }]);
  } finally {
    await boss.stop();
  }
});
