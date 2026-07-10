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
}

interface AppUserRow {
  id: string;
  status: string;
}

export async function createContext(req: Request): Promise<Context> {
  const pool = getPool();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return { actor: null, pool };

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

  return { actor, pool };
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
  const activeSchoolId = ctx.actor.schoolIds[0];
  if (!activeSchoolId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "okul üyeliği yok — önce okul oluşturun" });
  }
  // Handler'lar ham pool'a değil, okul bağlamına sarılmış db'ye erişir (RLS ikinci hat).
  const withSchoolDb = <T>(fn: (db: Db) => Promise<T>): Promise<T> =>
    ctx.pool.withSchool(ctx.actor.schoolIds, fn);
  return next({ ctx: { ...ctx, activeSchoolId, withSchoolDb } });
});

export const platformProcedure = authedProcedure.use(({ ctx, next }) => {
  if (!ctx.actor.isPlatformAdmin) {
    throw new TRPCError({ code: "FORBIDDEN", message: "platform yöneticisi yetkisi gerekli" });
  }
  return next({ ctx });
});
