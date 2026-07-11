// Eğitmen paneli token'ları: login'siz kalıcı imzalı link (davet deseninin devamı).
// Ham token yalnız URL'de yaşar; DB'de SHA-256 hex hash'i durur — sızıntıda kullanılamaz.
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@teachernow/db";

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface CreatePortalTokenInput {
  teacherId: string;
}

/** Yeni panel token'ı üretir; eskileri revoke ETMEZ (gerekirse revokePortalTokens). */
export async function createPortalToken(
  db: Db,
  input: CreatePortalTokenInput,
): Promise<{ token: string }> {
  const token = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO teacher_portal_token (teacher_id, token_hash) VALUES ($1, $2)",
    [input.teacherId, sha256Hex(token)],
  );
  return { token };
}

export interface PortalTeacher {
  teacherId: string;
  fullName: string;
  timezone: string;
}

/** Token'dan eğitmeni çözer; eşleşme yoksa null (çağırana detay sızdırılmaz). */
export async function getTeacherByPortalToken(
  db: Db,
  token: string,
): Promise<PortalTeacher | null> {
  const res = await db.query<{ teacher_id: string; full_name: string; timezone: string }>(
    `SELECT t.id AS teacher_id, t.full_name, t.timezone
       FROM teacher_portal_token pt
       JOIN teacher t ON t.id = pt.teacher_id
      WHERE pt.token_hash = $1 AND pt.revoked_at IS NULL`,
    [sha256Hex(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { teacherId: row.teacher_id, fullName: row.full_name, timezone: row.timezone };
}

/** Eğitmenin canlı tüm panel token'larını iptal eder; iptal edilen satır sayısını döner. */
export async function revokePortalTokens(db: Db, teacherId: string): Promise<number> {
  const res = await db.query(
    "UPDATE teacher_portal_token SET revoked_at = now() WHERE teacher_id = $1 AND revoked_at IS NULL",
    [teacherId],
  );
  return res.rowCount ?? 0;
}
