// Aktif okul seçimi: üyelik doğrulanır, tercih httpOnly cookie'ye yazılır.
// Cookie yalnız TERCİHTİR — yetki her istekte schoolProcedure'da üyelikle yeniden doğrulanır.
import { auth } from "../../../lib/auth";
import { getPool } from "../../../lib/pool";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return Response.json({ error: "oturum gerekli" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { schoolId?: string } | null;
  const schoolId = body?.schoolId;
  if (!schoolId || !UUID_RE.test(schoolId)) {
    return Response.json({ error: "geçersiz schoolId" }, { status: 400 });
  }

  const isMember = await getPool().withPlatform(async (db) => {
    const res = await db.query(
      `SELECT 1 FROM school_user su
        JOIN app_user u ON u.id = su.user_id
       WHERE u.email = $1 AND su.school_id = $2`,
      [session.user.email, schoolId],
    );
    return (res.rowCount ?? 0) > 0;
  });
  if (!isMember) return Response.json({ error: "bu okulun üyesi değilsiniz" }, { status: 403 });

  return new Response(JSON.stringify({ ok: true, activeSchoolId: schoolId }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `tn_active_school=${schoolId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    },
  });
}
