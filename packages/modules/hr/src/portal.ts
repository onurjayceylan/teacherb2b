// Eğitmen paneli self-servis link yenileme: eğitmen linkini kaybettiğinde e-postasıyla
// yenisini ister. Token deseni davetle aynı (invites.ts / sessions portal deseni):
// ham token yalnız outbox payload'ında yaşar (dispatcher URL'ye gömer); DB'de SHA-256
// hex hash'i durur — sızıntıda kullanılamaz. recipient_email PII: yalnız DB'ye yazılır.
import { createHash, randomBytes } from "node:crypto";
import type { ActorPool } from "@teachernow/db";

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Aynı alıcıya bu pencere içinde ikinci 'teacher_portal' e-postası yazılmaz. */
const RATE_LIMIT_MINUTES = 15;

/**
 * Self-servis panel linki isteği. Dönüş HER durumda {ok:true}:
 * - e-posta kayıtlı değilse hiçbir şey yazılmaz (varlık sızdırma yok),
 * - son 15 dakikada aynı alıcıya 'teacher_portal' kaydı düştüyse yenisi yazılmaz (rate-limit),
 * - aksi halde yeni panel token'ı (hash DB'de) + outbox kaydı AYNI transaction'da açılır.
 * E-posta içeriği worker dispatcher'ın mevcut 'teacher_portal' şablonunda render edilir;
 * payload yalnız şablon değişkenlerini (token, fullName) taşır.
 */
export async function requestPortalLink(pool: ActorPool, email: string): Promise<{ ok: true }> {
  await pool.withPlatform(async (db) => {
    // teacher.email citext (0005) — eşitlik büyük/küçük harf duyarsız eşleşir.
    // FOR UPDATE: aynı eğitmen için eşzamanlı istekler serileşir → rate-limit delinmez.
    const teacher = await db.query<{ id: string; email: string; full_name: string }>(
      `SELECT id, email, full_name FROM teacher WHERE email = $1 FOR UPDATE`,
      [email],
    );
    const t = teacher.rows[0];
    if (!t) return; // bilinmeyen e-posta: sessiz no-op, dışarıya aynı cevap

    const recent = await db.query(
      `SELECT 1 FROM notification_outbox
        WHERE recipient_email = $1 AND template = 'teacher_portal'
          AND created_at > now() - make_interval(mins => $2)
        LIMIT 1`,
      [t.email, RATE_LIMIT_MINUTES],
    );
    if ((recent.rowCount ?? 0) > 0) return; // rate-limit: mevcut e-posta hâlâ taze

    const token = randomBytes(32).toString("hex");
    await db.query(`INSERT INTO teacher_portal_token (teacher_id, token_hash) VALUES ($1, $2)`, [
      t.id,
      sha256Hex(token),
    ]);
    await db.query(
      `INSERT INTO notification_outbox (channel, recipient_email, template, payload)
       VALUES ('email', $1, 'teacher_portal', $2::jsonb)`,
      [t.email, JSON.stringify({ token, fullName: t.full_name })],
    );
  });
  return { ok: true };
}
