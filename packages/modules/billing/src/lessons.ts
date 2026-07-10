// Wizard-of-Oz manuel ders ücreti: okul kasasından satış düşer, eğitmen alacağı
// ve platform marjı ledger disipliniyle (SUM=0, min_zero) tek transaction'da yazılır.
// Not: role_platform'un manual_lesson_charge üzerinde UPDATE yetkisi yok (0005 grant'leri
// SELECT+INSERT); bu yüzden id istemci tarafında üretilir, ledger txn ÖNCE atılır ve satır
// txn_id ile birlikte TEK INSERT'te yazılır — sonradan UPDATE gerekmez.
import { randomUUID } from "node:crypto";
import type { Db } from "@teachernow/db";
import { ensureAccount, postTxn, type LedgerEntryInput } from "./ledger.js";

export interface ChargeManualLessonInput {
  schoolId: string;
  teacherId: string;
  classGroupId?: string;
  /** YYYY-MM-DD */
  lessonDate: string;
  minutes: number;
  chargeCents: number;
  teacherPayCents: number;
  note?: string;
  createdBy?: string;
}

export interface ChargeManualLessonResult {
  id: string;
  txnId: string;
}

/**
 * Platform bağlamında, çağıranın transaction'ı içinde çalışır (withPlatform).
 * Yetersiz okul bakiyesi min_zero CHECK ile postTxn'de patlar; teacherPay > charge
 * ise satırın CHECK'i INSERT'te patlar — her iki durumda da transaction bütünüyle
 * geri sarılır, ne ledger kaydı ne ders satırı kalır.
 */
export async function chargeManualLesson(
  db: Db,
  input: ChargeManualLessonInput,
): Promise<ChargeManualLessonResult> {
  const id = randomUUID();

  const schoolCashId = await ensureAccount(db, "school", input.schoolId, "school_cash");
  const teacherPayableId = await ensureAccount(db, "teacher", input.teacherId, "teacher_payable");
  const platformRevenueId = await ensureAccount(db, "platform", null, "platform_revenue");

  const marginCents = input.chargeCents - input.teacherPayCents;
  // Sıfır tutarlı bacak ledger_entry CHECK'ine takılır (amount_cents <> 0) — atlanır;
  // toplam yine 0: -charge + teacherPay + (charge - teacherPay).
  const entries: LedgerEntryInput[] = [
    { accountId: schoolCashId, amountCents: -input.chargeCents },
    { accountId: teacherPayableId, amountCents: input.teacherPayCents },
    { accountId: platformRevenueId, amountCents: marginCents },
  ].filter((e) => Number(e.amountCents) !== 0);

  const { txnId } = await postTxn(db, {
    key: `woz:lesson:${id}`,
    type: "lesson_charge",
    refType: "manual_lesson_charge",
    refId: id,
    entries,
  });

  await db.query(
    `INSERT INTO manual_lesson_charge
       (id, school_id, teacher_id, class_group_id, lesson_date, minutes,
        charge_cents, teacher_pay_cents, txn_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      input.schoolId,
      input.teacherId,
      input.classGroupId ?? null,
      input.lessonDate,
      input.minutes,
      input.chargeCents,
      input.teacherPayCents,
      txnId,
      input.note ?? null,
      input.createdBy ?? null,
    ],
  );

  return { id, txnId };
}
