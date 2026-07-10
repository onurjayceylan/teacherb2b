// tRPC v11 çekirdeği: context (better-auth oturumu → app_user aktörü) + prosedür katmanları.
// Fail-closed: aktör her istekte DB'den doğrulanır; status='disabled' → oturum reddedilir
// (cookie cache'e rağmen pasifleştirilen kullanıcı tRPC'de ANINDA, oturumda ≤5 dk'da düşer).
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { ActorPool, Db } from "@teachernow/db";
import { auth } from "../lib/auth";
import { getPool } from "../lib/pool";

export interface Actor {
  userId: string;
  email: string;
  schoolIds: string[];
  isPlatformAdmin: boolean;
}

export interface Context {
  actor: Actor | null;
  pool: ActorPool;
  /** tn_active_school cookie'sinden gelen tercih; üyelik doğrulaması schoolProcedure'da. */
  preferredSchoolId: string | null;
}

const ACTIVE_SCHOOL_COOKIE = "tn_active_school";

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Tercih edilen okul üyelikler içindeyse onu, değilse ilk üyeliği seçer. */
export function resolveActiveSchoolId(actor: Actor, preferred: string | null): string | undefined {
  if (preferred && actor.schoolIds.includes(preferred)) return preferred;
  return actor.schoolIds[0];
}

interface AppUserRow {
  id: string;
  status: string;
}

export async function createContext(req: Request): Promise<Context> {
  const pool = getPool();
  const preferredSchoolId = readCookie(req.headers.get("cookie"), ACTIVE_SCHOOL_COOKIE);
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return { actor: null, pool, preferredSchoolId };

  const email = session.user.email;
  const name = session.user.name ?? null;

  const actor = await pool.withPlatform(async (db): Promise<Actor | null> => {
    let row = (
      await db.query<AppUserRow>("SELECT id, status FROM app_user WHERE email = $1", [email])
    ).rows[0];
    if (!row) {
      // JIT güvenlik ağı: signup hook'u bir sebeple kaçtıysa burada tamamlanır.
      await db.query(
        "INSERT INTO app_user (email, name) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING",
        [email, name],
      );
      row = (
        await db.query<AppUserRow>("SELECT id, status FROM app_user WHERE email = $1", [email])
      ).rows[0];
    }
    // Pasifleştirilmiş kullanıcı aktör olamaz → authedProcedure UNAUTHORIZED üretir.
    if (!row || row.status === "disabled") return null;

    const memberships = await db.query<{ school_id: string }>(
      "SELECT school_id FROM school_user WHERE user_id = $1 ORDER BY created_at",
      [row.id],
    );
    const admin = await db.query("SELECT 1 FROM platform_admin WHERE user_id = $1", [row.id]);
    return {
      userId: row.id,
      email,
      schoolIds: memberships.rows.map((m) => m.school_id),
      isPlatformAdmin: (admin.rowCount ?? 0) > 0,
    };
  });

  return { actor, pool, preferredSchoolId };
}

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.actor) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "oturum gerekli" });
  }
  return next({ ctx: { ...ctx, actor: ctx.actor } });
});

export const schoolProcedure = authedProcedure.use(({ ctx, next }) => {
  const activeSchoolId = resolveActiveSchoolId(ctx.actor, ctx.preferredSchoolId);
  if (!activeSchoolId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "okul üyeliği yok — önce okul oluşturun" });
  }
  // Handler'lar ham pool'a değil, AKTİF okul bağlamına sarılmış db'ye erişir (RLS ikinci hat).
  // Bilinçli daraltma: cüzdan/top-up işlemleri seçili okulla sınırlı — yanlış okula işlem imkânsız.
  const withSchoolDb = <T>(fn: (db: Db) => Promise<T>): Promise<T> =>
    ctx.pool.withSchool([activeSchoolId], fn);
  return next({ ctx: { ...ctx, activeSchoolId, withSchoolDb } });
});

export const platformProcedure = authedProcedure.use(({ ctx, next }) => {
  if (!ctx.actor.isPlatformAdmin) {
    throw new TRPCError({ code: "FORBIDDEN", message: "platform yöneticisi yetkisi gerekli" });
  }
  return next({ ctx });
});
