// Davet token'ları: login'siz onboarding'in yetki kapısı. Ham token yalnız URL'de
// yaşar; DB'de SHA-256 hex hash'i durur (0006 — sızıntıda kullanılamaz).
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@teachernow/db";
import type { DocumentKind, DocumentStatus } from "./documents.js";
import type { TeacherStatus } from "./pipeline.js";

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface CreateInviteTokenInput {
  teacherId: string;
  /** Geçerlilik süresi (gün). Varsayılan 14. */
  ttlDays?: number;
  createdBy?: string;
}

/**
 * Yeni davet token'ı üretir; eskileri REVOKE ETMEZ (aynı eğitmen için birden çok
 * geçerli token olabilir — basit tutuldu, gerekirse revokeInviteTokens çağrılır).
 */
export async function createInviteToken(
  db: Db,
  input: CreateInviteTokenInput,
): Promise<{ token: string }> {
  const token = randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO teacher_invite (teacher_id, token_hash, expires_at, created_by)
     VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [input.teacherId, sha256Hex(token), input.ttlDays ?? 14, input.createdBy ?? null],
  );
  return { token };
}

export interface InviteTokenDocument {
  kind: DocumentKind;
  status: DocumentStatus;
}

export interface InviteTokenTeacher {
  teacherId: string;
  fullName: string;
  status: TeacherStatus;
  country: string | null;
  timezone: string;
  phone: string | null;
  documents: InviteTokenDocument[];
}

/**
 * Token'dan eğitmeni çözer: hash eşleşmesi + expires_at > now() + revoke edilmemiş.
 * İlk kullanımda first_used_at damgalanır (yalnız NULL ise — sonraki kullanımlar dokunmaz).
 * Eşleşme yoksa null (kim olduğu belli olmayan çağırana detay sızdırılmaz).
 */
export async function getTeacherByInviteToken(
  db: Db,
  token: string,
): Promise<InviteTokenTeacher | null> {
  const invite = await db.query<{ teacher_id: string }>(
    `UPDATE teacher_invite
        SET first_used_at = COALESCE(first_used_at, now())
      WHERE token_hash = $1 AND expires_at > now() AND revoked_at IS NULL
      RETURNING teacher_id`,
    [sha256Hex(token)],
  );
  const teacherId = invite.rows[0]?.teacher_id;
  if (!teacherId) return null;

  const teacher = await db.query<{
    full_name: string;
    status: TeacherStatus;
    country: string | null;
    timezone: string;
    phone: string | null;
  }>(`SELECT full_name, status, country, timezone, phone FROM teacher WHERE id = $1`, [teacherId]);
  const t = teacher.rows[0];
  if (!t) return null;

  const docs = await db.query<InviteTokenDocument>(
    `SELECT kind, status FROM teacher_document WHERE teacher_id = $1 ORDER BY kind`,
    [teacherId],
  );

  return {
    teacherId,
    fullName: t.full_name,
    status: t.status,
    country: t.country,
    timezone: t.timezone,
    phone: t.phone,
    documents: docs.rows.map((d) => ({ kind: d.kind, status: d.status })),
  };
}

/** Eğitmenin revoke edilmemiş tüm token'larını iptal eder; iptal edilen satır sayısını döner. */
export async function revokeInviteTokens(db: Db, teacherId: string): Promise<number> {
  const res = await db.query(
    `UPDATE teacher_invite SET revoked_at = now()
      WHERE teacher_id = $1 AND revoked_at IS NULL`,
    [teacherId],
  );
  return res.rowCount ?? 0;
}
