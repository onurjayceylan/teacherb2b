// Login'siz eğitmen teklif akışı (public): teklif token'ı TEK yetki kapısıdır.
// DB'de yalnız SHA-256 hash durur; ham token URL'de taşınır. Eşleşmeyen/süresi geçmiş
// token NOT_FOUND üretir — geçersiz/expired/taken ayrımı dışarı sızdırılmaz.
// Gizlilik hattı: eğitmen KENDİ ücretini (slot.teacher_pay_cents) görür; okulun ödediği
// fiyat (price_cents) bu uçtan ASLA dönmez.
import { createHash } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { acceptOffer, declineOffer } from "@teachernow/dispatch";
import { publicProcedure, router } from "../trpc";

// Biçim doğrulaması kasten gevşek: bozuk token da NOT_FOUND üretmeli (BAD_REQUEST değil).
const tokenSchema = z.string().trim().min(1).max(200);

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** UTC anını verilen timezone'da okunur biçimler; geçersiz tz'de UTC'ye düşer. */
function formatInZone(at: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("tr-TR", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: tz,
    }).format(at);
  } catch {
    return `${at.toISOString()} (UTC)`;
  }
}

export const offerRouter = router({
  get: publicProcedure.input(z.object({ token: tokenSchema })).query(async ({ ctx, input }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        starts_at: Date;
        ends_at: Date;
        offer_expires_at: Date;
        teacher_pay_cents: string; // pg bigint → string
        school_name: string;
        class_name: string;
        pool_name: string;
        teacher_name: string;
        teacher_tz: string;
      }>(
        `SELECT a.starts_at, a.ends_at, a.offer_expires_at,
                s.teacher_pay_cents,
                sch.name AS school_name, cg.name AS class_name, pl.name AS pool_name,
                t.full_name AS teacher_name, t.timezone AS teacher_tz
           FROM assignment a
           JOIN booking_slot s ON s.id = a.slot_id
           JOIN school sch ON sch.id = s.school_id
           JOIN class_group cg ON cg.id = s.class_group_id
           JOIN pool pl ON pl.id = s.pool_id
           JOIN teacher t ON t.id = a.teacher_id
          WHERE a.offer_token_hash = $1 AND a.status = 'offered' AND a.offer_expires_at > now()`,
        [sha256Hex(input.token)],
      );
      const row = res.rows[0];
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "Teklif bulunamadı — süresi dolmuş, geri çekilmiş ya da ders başka bir eğitmene atanmış olabilir.",
        });
      }
      const durationMin = Math.round(
        (row.ends_at.getTime() - row.starts_at.getTime()) / 60_000,
      );
      return {
        schoolName: row.school_name,
        className: row.class_name,
        poolName: row.pool_name,
        teacherName: row.teacher_name,
        timezone: row.teacher_tz,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        // Zaman EĞİTMENİN timezone'unda formatlanır (teklif e-postası/karta hazır metin).
        startsAtLocal: formatInZone(row.starts_at, row.teacher_tz),
        expiresAt: row.offer_expires_at,
        durationMin,
        // Eğitmenin ders başı ücreti — okul fiyatı (price_cents) BİLİNÇLİ olarak yok.
        teacherPayCents: Number(row.teacher_pay_cents),
      };
    });
  }),

  accept: publicProcedure
    .input(z.object({ token: tokenSchema }))
    .mutation(async ({ ctx, input }) => acceptOffer(ctx.pool, input.token)),

  decline: publicProcedure
    .input(z.object({ token: tokenSchema }))
    .mutation(async ({ ctx, input }) => declineOffer(ctx.pool, input.token)),
});
