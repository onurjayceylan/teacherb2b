// Ortak slot satırı tipi ve yükleyiciler. bigint kolonlar pg'den string gelir — Number'a
// yalnız hesap anında, floor matematiğiyle çevrilir (cent tutarları 2^53 altında güvenli).
import type { Db } from "@teachernow/db";

export interface SlotRow {
  id: string;
  school_id: string;
  plan_id: string;
  class_group_id: string;
  pool_id: string;
  /** okul-lokal ders tarihi (::text ile çekilir) */
  occurrence_key: string;
  starts_at: Date;
  ends_at: Date;
  /** pg bigint → string */
  price_cents: string;
  teacher_pay_cents: string;
  status: string;
  hold_txn_id: string | null;
  hold_released_txn_id: string | null;
}

const SLOT_COLUMNS = `id, school_id, plan_id, class_group_id, pool_id,
  occurrence_key::text AS occurrence_key, starts_at, ends_at,
  price_cents, teacher_pay_cents, status, hold_txn_id, hold_released_txn_id`;

export async function getSlot(db: Db, slotId: string): Promise<SlotRow | null> {
  const res = await db.query<SlotRow>(
    `SELECT ${SLOT_COLUMNS} FROM booking_slot WHERE id = $1`,
    [slotId],
  );
  return res.rows[0] ?? null;
}

/** İptal/no-show akışları için satır kilidiyle yükler (eşzamanlı çift işlem yarışını keser). */
export async function getSlotForUpdate(db: Db, slotId: string): Promise<SlotRow | null> {
  const res = await db.query<SlotRow>(
    `SELECT ${SLOT_COLUMNS} FROM booking_slot WHERE id = $1 FOR UPDATE`,
    [slotId],
  );
  return res.rows[0] ?? null;
}
