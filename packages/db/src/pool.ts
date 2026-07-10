// Bağlantı + aktör bağlamı. Tenant sorguları TEK kapıdan geçer:
// withSchool() SET LOCAL ROLE role_school + app.school_ids kurar → RLS ikinci savunma hattı.
// Ham pool'u export ETMİYORUZ; her erişim bir aktör bağlamı seçmek zorunda.
import pg from "pg";

export type Db = pg.PoolClient;

export interface ActorPool {
  /** Platform aktörü (worker, admin, webhook ingest) olarak transaction. */
  withPlatform<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /** Okul aktörü olarak transaction; RLS app.school_ids ile sınırlar. */
  withSchool<T>(schoolIds: string[], fn: (db: Db) => Promise<T>): Promise<T>;
  /** Yalnız migration/test altyapısı için: rol değiştirmeden transaction. */
  withOwner<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

async function inTx<T>(pool: pg.Pool, setup: string[], fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const stmt of setup) await client.query(stmt);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makePool(databaseUrl: string): ActorPool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return {
    withPlatform: (fn) => inTx(pool, [`SET LOCAL ROLE role_platform`], fn),
    withSchool: (schoolIds, fn) => {
      if (schoolIds.length === 0) throw new Error("withSchool: en az bir school_id gerekli");
      for (const id of schoolIds) {
        if (!UUID_RE.test(id)) throw new Error(`withSchool: geçersiz uuid: ${id}`);
      }
      return inTx(
        pool,
        [
          `SET LOCAL ROLE role_school`,
          // uuid'ler yukarıda doğrulandı; GUC değeri literal olarak kuruluyor
          `SELECT set_config('app.school_ids', '${schoolIds.join(",")}', true)`,
        ],
        fn,
      );
    },
    withOwner: (fn) => inTx(pool, [], fn),
    end: () => pool.end(),
  };
}
