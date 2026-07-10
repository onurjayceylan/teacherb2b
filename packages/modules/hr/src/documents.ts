// Evrak seti: payout hard-gate'inin veri tabanı. payout_ready TÜRETİLİR —
// buradan asla elle yazılmaz; teacher_document değişince DB trigger'ı hesaplar.
import type { Db } from "@teachernow/db";

export const DOCUMENT_KINDS = [
  "contract",
  "id_verification",
  "country_clearance",
  "tax_form",
  "payout_method",
] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type DocumentStatus = "missing" | "submitted" | "verified" | "rejected" | "expired";

/** Yeni eğitmen(ler) için 5 evrak kind'ını 'missing' olarak açar (idempotent). */
export async function seedMissingDocuments(db: Db, teacherIds: string[]): Promise<void> {
  if (teacherIds.length === 0) return;
  await db.query(
    `INSERT INTO teacher_document (teacher_id, kind)
     SELECT t.id, k.kind
       FROM unnest($1::uuid[]) AS t(id)
      CROSS JOIN unnest($2::text[]) AS k(kind)
     ON CONFLICT (teacher_id, kind) DO NOTHING`,
    [teacherIds, [...DOCUMENT_KINDS]],
  );
}

export interface UpsertDocumentInput {
  teacherId: string;
  kind: DocumentKind;
  status: DocumentStatus;
  vendor?: string;
  vendorRef?: string;
  note?: string;
  /** YYYY-MM-DD */
  validUntil?: string;
}

/** Evrak durumunu yazar; mevcut vendor/ref/not bilgisi verilmediyse korunur. */
export async function upsertDocument(db: Db, input: UpsertDocumentInput): Promise<void> {
  await db.query(
    `INSERT INTO teacher_document (teacher_id, kind, status, vendor, vendor_ref, note, valid_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (teacher_id, kind) DO UPDATE SET
       status      = EXCLUDED.status,
       vendor      = COALESCE(EXCLUDED.vendor, teacher_document.vendor),
       vendor_ref  = COALESCE(EXCLUDED.vendor_ref, teacher_document.vendor_ref),
       note        = COALESCE(EXCLUDED.note, teacher_document.note),
       valid_until = COALESCE(EXCLUDED.valid_until, teacher_document.valid_until),
       updated_at  = now()`,
    [
      input.teacherId,
      input.kind,
      input.status,
      input.vendor ?? null,
      input.vendorRef ?? null,
      input.note ?? null,
      input.validUntil ?? null,
    ],
  );
}

export interface MissingDocumentRow {
  teacherId: string;
  fullName: string;
  kind: DocumentKind;
  status: DocumentStatus;
}

/** Exceptions kuyruğu: eksik/reddedilmiş/süresi geçmiş evraklar (istenirse tek eğitmen). */
export async function missingDocuments(
  db: Db,
  teacherId?: string,
): Promise<MissingDocumentRow[]> {
  const res = await db.query<{
    teacher_id: string;
    full_name: string;
    kind: DocumentKind;
    status: DocumentStatus;
  }>(
    `SELECT d.teacher_id, t.full_name, d.kind, d.status
       FROM teacher_document d
       JOIN teacher t ON t.id = d.teacher_id
      WHERE d.status IN ('missing', 'rejected', 'expired')
        AND ($1::uuid IS NULL OR d.teacher_id = $1)
      ORDER BY t.full_name, d.kind`,
    [teacherId ?? null],
  );
  return res.rows.map((r) => ({
    teacherId: r.teacher_id,
    fullName: r.full_name,
    kind: r.kind,
    status: r.status,
  }));
}
