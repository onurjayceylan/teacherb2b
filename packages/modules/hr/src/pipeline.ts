// Eğitmen pipeline'ı: davet, toplu import (hrmasterz), durum ilerletme ve liste.
// Durum makinesi DB trigger'ında (0005) — burada yalnız UPDATE atılır, hata olduğu gibi fırlar.
import type { Db } from "@teachernow/db";
import { DOCUMENT_KINDS, seedMissingDocuments } from "./documents.js";
import { timezoneSchema } from "./profile.js";

export type TeacherSource = "site" | "ilan" | "hrmasterz";
export type TeacherStatus =
  | "invited"
  | "profile"
  | "docs_pending"
  | "interview"
  | "active"
  | "rejected"
  | "suspended";

export interface InviteTeacherInput {
  fullName: string;
  email: string;
  phone?: string;
  country?: string;
  timezone?: string;
  source: TeacherSource;
  invitedBy?: string;
}

/** PG unique_violation (23505) mu? Ham sürücü hatasını dışarı sızdırmamak için ayırt edilir. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

/** Tekil davet: teacher 'invited' olarak açılır, 5 evrak kind'ı 'missing' seed edilir. */
export async function inviteTeacher(db: Db, input: InviteTeacherInput): Promise<string> {
  // Timezone eğitmenin teklif/müsaitlik matematiğinin temelidir — bozuk değer içeri giremez.
  if (input.timezone !== undefined) {
    const tz = timezoneSchema.safeParse(input.timezone);
    if (!tz.success) {
      throw new Error(`inviteTeacher: ${tz.error.issues[0]?.message ?? "invalid timezone"}`);
    }
  }
  let res;
  try {
    res = await db.query<{ id: string }>(
      `INSERT INTO teacher (full_name, email, phone, country, timezone, source, invited_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'Europe/Istanbul'), $6, $7)
       RETURNING id`,
      [
        input.fullName,
        input.email,
        input.phone ?? null,
        input.country ?? null,
        input.timezone ?? null,
        input.source,
        input.invitedBy ?? null,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error(`bu e-posta ile kayıtlı eğitmen zaten var: ${input.email}`);
    }
    throw err;
  }
  const row = res.rows[0];
  if (!row) throw new Error("inviteTeacher: teacher INSERT satır dönmedi");
  await seedMissingDocuments(db, [row.id]);
  return row.id;
}

export interface ImportTeacherRow {
  fullName: string;
  email: string;
  country?: string;
  source?: TeacherSource;
}

export interface ImportTeachersOptions {
  /** Import edilenler hemen derse çıkabilsin mi? Varsayılan true (hibrit karar). */
  dispatchReady?: boolean;
}

export interface ImportTeachersResult {
  created: number;
  skipped: number;
}

/**
 * Toplu import (hrmasterz yolu): email çakışanlar sessizce atlanır (skipped).
 * Yaratılanlar invited→active geçirilir (trigger whitelist'inde import yolu),
 * dispatch_ready açılır; payout_ready 5 'missing' evrak sayesinde doğal olarak false kalır
 * (hard-gate: evrak seti tamamlanmadan ödeme yok).
 */
export async function importTeachers(
  db: Db,
  rows: ImportTeacherRow[],
  opts?: ImportTeachersOptions,
): Promise<ImportTeachersResult> {
  if (rows.length === 0) return { created: 0, skipped: 0 };

  let res;
  try {
    res = await db.query<{ id: string }>(
      `INSERT INTO teacher (full_name, email, country, source, dispatch_ready)
       SELECT i.full_name, i.email, i.country, i.source, $5
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
              AS i(full_name, email, country, source)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [
        rows.map((r) => r.fullName),
        rows.map((r) => r.email),
        rows.map((r) => r.country ?? null),
        rows.map((r) => r.source ?? "hrmasterz"),
        opts?.dispatchReady ?? true,
      ],
    );
  } catch (err) {
    // ON CONFLICT (email) mükerrerleri sessizce atlar; başka bir unique kısıtına
    // takılırsa PG detayını sızdırmadan anlamlı mesaj döneriz.
    if (isUniqueViolation(err)) {
      throw new Error("bu e-posta ile kayıtlı eğitmen zaten var: import satırlarını kontrol edin");
    }
    throw err;
  }
  const createdIds = res.rows.map((r) => r.id);

  if (createdIds.length > 0) {
    // invited→active: whitelist'teki toplu-import geçişi (trigger doğrular).
    await db.query(
      `UPDATE teacher SET status = 'active', updated_at = now() WHERE id = ANY($1::uuid[])`,
      [createdIds],
    );
    await seedMissingDocuments(db, createdIds);
  }

  return { created: createdIds.length, skipped: rows.length - createdIds.length };
}

export interface AdvanceStatusInput {
  teacherId: string;
  to: TeacherStatus;
}

/** Durumu ilerletir; geçersiz geçişte DB trigger'ının exception'ı olduğu gibi fırlar. */
export async function advanceStatus(db: Db, input: AdvanceStatusInput): Promise<void> {
  const res = await db.query(
    `UPDATE teacher SET status = $2, updated_at = now() WHERE id = $1`,
    [input.teacherId, input.to],
  );
  if (res.rowCount === 0) {
    throw new Error(`advanceStatus: teacher bulunamadı: ${input.teacherId}`);
  }
}

export interface PipelineTeacher {
  id: string;
  fullName: string;
  email: string;
  source: TeacherSource;
  status: TeacherStatus;
  dispatchReady: boolean;
  payoutReady: boolean;
  createdAt: Date;
}

export interface ListPipelineInput {
  status?: TeacherStatus;
}

/** Pipeline görünümü: temel kolonlar, istenirse tek duruma filtreli. */
export async function listPipeline(
  db: Db,
  input: ListPipelineInput = {},
): Promise<PipelineTeacher[]> {
  const res = await db.query<{
    id: string;
    full_name: string;
    email: string;
    source: TeacherSource;
    status: TeacherStatus;
    dispatch_ready: boolean;
    payout_ready: boolean;
    created_at: Date;
  }>(
    `SELECT id, full_name, email, source, status, dispatch_ready, payout_ready, created_at
       FROM teacher
      WHERE $1::text IS NULL OR status = $1
      ORDER BY created_at, id`,
    [input.status ?? null],
  );
  return res.rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    source: r.source,
    status: r.status,
    dispatchReady: r.dispatch_ready,
    payoutReady: r.payout_ready,
    createdAt: r.created_at,
  }));
}

export { DOCUMENT_KINDS };
