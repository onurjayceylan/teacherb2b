// ActorPool tekil örneği — Next dev'de HMR modül state'ini sıfırlayabildiği için
// globalThis üzerinde saklanır; her istek aynı havuzu paylaşır.
import { makePool, type ActorPool } from "@teachernow/db";

const g = globalThis as typeof globalThis & { __teachernowPool?: ActorPool };

export function getPool(): ActorPool {
  if (!g.__teachernowPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL gerekli (kök .env, next.config.ts ile yüklenir)");
    g.__teachernowPool = makePool(url);
  }
  return g.__teachernowPool;
}
