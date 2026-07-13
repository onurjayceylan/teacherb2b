// Salt-okur sorgular: reconciler + admin UI (listOpen) ve eğitmen paneli
// (getTeacherPayouts). Para/durum yazmazlar.
import type { ActorPool, Db } from "@teachernow/db";

export interface OpenPayoutRow {
  id: string;
  batchId: string;
  teacherId: string;
  amountCents: number;
  currency: string;
  status: "pending" | "submitted";
  providerIdempotencyKey: string;
  submittedAt: Date | null;
  createdAt: Date;
}

/** Sonuçlanmamış (pending/submitted) payout'lar — reconciler ve operasyon ekranı için. */
export async function listOpen(pool: ActorPool): Promise<OpenPayoutRow[]> {
  return pool.withPlatform(async (db) => {
    const res = await db.query<{
      id: string;
      batch_id: string;
      teacher_id: string;
      amount_cents: string;
      currency: string;
      status: "pending" | "submitted";
      provider_idempotency_key: string;
      submitted_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, batch_id, teacher_id, amount_cents, currency, status,
              provider_idempotency_key, submitted_at, created_at
         FROM payout
        WHERE status IN ('pending', 'submitted')
        ORDER BY created_at, id`,
    );
    return res.rows.map((r) => ({
      id: r.id,
      batchId: r.batch_id,
      teacherId: r.teacher_id,
      amountCents: Number(r.amount_cents), // pg bigint → string
      currency: r.currency.trim(),
      status: r.status,
      providerIdempotencyKey: r.provider_idempotency_key,
      submittedAt: r.submitted_at,
      createdAt: r.created_at,
    }));
  });
}

export interface TeacherPayoutRow {
  id: string;
  batchId: string;
  amountCents: number;
  currency: string;
  status: string;
  failureReason: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface TeacherMissingPayoutDetailsRow {
  teacherId: string;
  name: string;
  email: string;
}

/**
 * Payout hesap bilgisi (teacher.payout_details) girilmemiş AKTİF eğitmenler —
 * batch export öncesi operasyon kontrol listesi (CSV'de kolonları boş çıkanlar).
 */
export async function teachersMissingPayoutDetails(
  db: Db,
): Promise<Array<{ teacherId: string; name: string; email: string }>> {
  const res = await db.query<{ id: string; full_name: string; email: string }>(
    `SELECT id, full_name, email
       FROM teacher
      WHERE status = 'active' AND payout_details IS NULL
      ORDER BY full_name, id`,
  );
  return res.rows.map((r) => ({ teacherId: r.id, name: r.full_name, email: r.email }));
}

export interface OverpaidTeacherRow {
  teacherId: string;
  name: string;
  email: string;
  /** eğitmenin platforma borcu = fazla ödenen tutar (negatif bakiyenin POZİTİF karşılığı). */
  owedCents: number;
}

/**
 * teacher_payable bakiyesi NEGATİF eğitmenler (denetim tur 3 [P2]): bir itiraz-iadesi payout
 * gönderildikten/ödendikten sonra çözülürse eğitmen dondurulmuş (iade-öncesi) tutarı tam alır →
 * alacağı eksiye düşer (teacher_payable min_zero DEĞİL). Bu bir NETTING borcudur, ledger
 * invariant'ı bunu yakalamaz (trial balance korunur) ve createBatch balance>0 süzdüğü için
 * eğitmen hiçbir payout ekranında görünmez. Burada admin'e yüzeye çıkarılır — sessiz kalmaz.
 */
export async function listOverpaidTeachers(db: Db): Promise<OverpaidTeacherRow[]> {
  const res = await db.query<{
    id: string;
    full_name: string;
    email: string;
    balance_cents: string;
  }>(
    `SELECT t.id, t.full_name, t.email, a.balance_cents
       FROM ledger_account a
       JOIN teacher t ON t.id = a.owner_id
      WHERE a.owner_type = 'teacher' AND a.kind = 'teacher_payable' AND a.balance_cents < 0
      ORDER BY a.balance_cents ASC`,
  );
  return res.rows.map((r) => ({
    teacherId: r.id,
    name: r.full_name,
    email: r.email,
    owedCents: -Number(r.balance_cents), // negatif bakiye → pozitif borç
  }));
}

/** Eğitmenin son payout'ları (portal paneli). */
export async function getTeacherPayouts(
  pool: ActorPool,
  teacherId: string,
  limit = 20,
): Promise<TeacherPayoutRow[]> {
  return pool.withPlatform(async (db) => {
    const res = await db.query<{
      id: string;
      batch_id: string;
      amount_cents: string;
      currency: string;
      status: string;
      failure_reason: string | null;
      paid_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, batch_id, amount_cents, currency, status, failure_reason, paid_at, created_at
         FROM payout
        WHERE teacher_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [teacherId, limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      batchId: r.batch_id,
      amountCents: Number(r.amount_cents),
      currency: r.currency.trim(),
      status: r.status,
      failureReason: r.failure_reason,
      paidAt: r.paid_at,
      createdAt: r.created_at,
    }));
  });
}
