// Test altyapısı: her test dosyası kendi taze veritabanını alır (paralel süitler çakışmaz).
import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "./migrate.js";
import { makePool, type ActorPool } from "./pool.js";

export interface TestDb {
  url: string;
  pool: ActorPool;
  drop(): Promise<void>;
}

function adminUrl(): string {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL gerekli (testler taze DB yaratır)");
  return url;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `teachernow_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const dbUrl = url.toString();
  await migrate(dbUrl);
  const pool = makePool(dbUrl);

  return {
    url: dbUrl,
    pool,
    drop: async () => {
      await pool.end();
      const admin2 = new pg.Client({ connectionString: adminUrl() });
      await admin2.connect();
      await admin2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin2.end();
    },
  };
}
