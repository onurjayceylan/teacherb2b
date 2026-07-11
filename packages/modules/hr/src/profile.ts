// Eğitmen profil doğrulamaları + payout hesap bilgisi (0013 teacher.payout_details).
// payout_details PII'dır: yalnız DB'ye yazılır, ASLA loglanmaz; payout CSV'sine
// payouts modülü taşır. Hata mesajları eğitmen-yüzlü olduğu için İngilizce.
import type { Db } from "@teachernow/db";
import { IANAZone } from "luxon";
import { z } from "zod";

/** Geçerli IANA timezone (luxon doğrular) — eğitmen profil/availability yazımlarının kapısı. */
export const timezoneSchema = z.string().refine((tz) => IANAZone.isValidZone(tz), {
  message: "invalid IANA timezone (e.g. Europe/Istanbul)",
});

/**
 * Wise-manuel payout akışının hesap bilgisi: Wise e-postası ya da IBAN.
 * value/accountHolder trim'lenir; wise_email yönteminde value e-posta formatında olmalı.
 */
export const payoutDetailsSchema = z
  .object({
    method: z.enum(["wise_email", "iban"]),
    value: z.string().trim().min(5).max(120),
    accountHolder: z.string().trim().min(2).max(120),
  })
  .superRefine((details, ctx) => {
    if (details.method === "wise_email" && !z.string().email().safeParse(details.value).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "invalid email address for wise_email payout method",
      });
    }
  });

export type PayoutDetails = z.infer<typeof payoutDetailsSchema>;

/**
 * teacher.payout_details jsonb'sini yazar (şemadan geçirip — trim burada uygulanır).
 * Eğitmen yoksa anlamlı hata; kısmi/yanlış veri şema hatasıyla daha içeri giremez.
 */
export async function setPayoutDetails(
  db: Db,
  teacherId: string,
  details: PayoutDetails,
): Promise<void> {
  const parsed = payoutDetailsSchema.parse(details);
  const res = await db.query(
    `UPDATE teacher SET payout_details = $2::jsonb, updated_at = now() WHERE id = $1`,
    [teacherId, JSON.stringify(parsed)],
  );
  if (res.rowCount === 0) {
    throw new Error(`setPayoutDetails: teacher bulunamadı: ${teacherId}`);
  }
}
