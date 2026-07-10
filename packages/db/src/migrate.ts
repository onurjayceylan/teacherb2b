// Migration runner: dosyaları sırayla, her biri kendi transaction'ında uygular.
// Disiplin (01-mimari §8): şema değişikliği ÖNCE burada (DB'de) doğrulanır, TS şemasına sonra girer.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
// Aynı anda iki migrate koşamaz (release-phase + lokal çakışması):
const ADVISORY_LOCK_KEY = 727_001;

export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const done = new Set(
      (await client.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name as string),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} başarısız: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL gerekli");
  migrate(url).then((applied) => {
    console.log(applied.length ? `uygulandı: ${applied.join(", ")}` : "güncel — yeni migration yok");
  });
}
