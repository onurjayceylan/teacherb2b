// Ders katılım kapısı (public GET): imzalı join token'ı doğrular, session'ı garanti eder,
// join olayını append-only session_event'e yazar ve role göre odaya 302 yönlendirir.
// Geçersiz/expired token → 404 sayfası yerine basit JSON 404 (link e-postada/kopyada yaşar;
// tarayıcı dışı istemciler de anlaşılır yanıt alır).
import { ensureSessionForSlot, recordEvent, verifyJoinToken } from "@teachernow/sessions";
import { getPool } from "../../../lib/pool";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    return Response.json({ error: "sunucu yapılandırması eksik" }, { status: 500 });
  }

  const payload = verifyJoinToken(token, secret);
  if (!payload) {
    return Response.json(
      { error: "ders bağlantısı geçersiz ya da süresi dolmuş" },
      { status: 404 },
    );
  }

  try {
    await getPool().withPlatform(async (db) => {
      // İdempotent: session varsa mevcut id döner. Ders bitip settle edildiyse slot
      // 'completed' olur — ensure reddedebilir; mevcut session'a düşeriz (tekrar ziyaret).
      let sessionId: string;
      try {
        const ensured = await ensureSessionForSlot(db, payload.slotId);
        sessionId = ensured.sessionId;
      } catch (err) {
        const existing = await db.query<{ id: string }>(
          "SELECT id FROM class_session WHERE slot_id = $1",
          [payload.slotId],
        );
        const row = existing.rows[0];
        if (!row) throw err;
        sessionId = row.id;
      }
      await recordEvent(db, { sessionId, kind: "join", role: payload.role });
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "ders oturumu açılamadı" },
      { status: 409 },
    );
  }

  const target = payload.role === "teacher" ? `/ders/${token}` : `/sinif-dersi/${token}`;
  return Response.redirect(new URL(target, req.url), 302);
}
