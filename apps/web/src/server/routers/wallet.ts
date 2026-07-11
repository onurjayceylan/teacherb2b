// Cüzdan: aktif okulun school_cash bakiyesi (cache kolonu — tek yazım kapısı ledger'da).
import { z } from "zod";
import { ensureAccount, getCachedBalance } from "@teachernow/ledger";
import { router, schoolProcedure } from "../trpc";

const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "tarih YYYY-AA-GG biçiminde olmalı");

/**
 * Ekstre satırının tip etiketi hesap türü + tutar işaretinden TÜRETİLİR:
 * okul bağlamı ledger_transaction'a (type kolonuna) erişemez — join bilinçli olarak yok.
 */
export function statementLabel(kind: string, amountCents: number): string {
  if (kind === "wallet_hold") return "Rezerv";
  return amountCents >= 0 ? "Yükleme/İade" : "Ders/Kesinti";
}

/** Ders bağlamı: "12 Tem 2026" — plan saat dilimiyle (okul yüzü tr-TR). */
function formatLessonDate(at: Date, tz: string | null): string {
  try {
    return new Intl.DateTimeFormat("tr-TR", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: tz ?? "Europe/Istanbul",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

interface TxnContext {
  type: string;
  className: string | null;
  lessonStartsAt: Date | null;
  schoolTz: string | null;
}

/**
 * Dostane satır açıklaması (denetim P2): ham txn type yerine Türkçe açıklama +
 * ders bağlamı ("Ders ücreti — 7A İngilizce, 12 Tem 2026"). Bilinmeyen tip eski
 * türetilmiş etikete düşer — ekstre asla boş açıklama basmaz.
 */
export function statementDescription(
  txn: TxnContext | undefined,
  kind: string,
  amountCents: number,
): string {
  if (!txn) return statementLabel(kind, amountCents);
  const lesson =
    txn.className && txn.lessonStartsAt
      ? ` — ${txn.className}, ${formatLessonDate(txn.lessonStartsAt, txn.schoolTz)}`
      : "";
  switch (txn.type) {
    case "topup":
      return "Bakiye yükleme";
    case "hold":
      return `Ders rezervi${lesson}`;
    case "hold_release":
      return `Rezerv iadesi${lesson}`;
    case "session_settle":
      return `Ders ücreti${lesson}`;
    case "late_cancel":
      return `Geç iptal (%50 iade)${lesson}`;
    case "lesson_charge":
      return "Ders ücreti (manuel kayıt)";
    case "dispute_refund":
      return `İtiraz iadesi${lesson}`;
    case "dispute_release":
      return `İtiraz düzeltmesi${lesson}`;
    default:
      return statementLabel(kind, amountCents);
  }
}

export const walletRouter = router({
  balance: schoolProcedure.query(async ({ ctx }) => {
    return ctx.withSchoolDb(async (db) => {
      const accountId = await ensureAccount(db, {
        ownerType: "school",
        ownerId: ctx.activeSchoolId,
        kind: "school_cash",
      });
      const balanceCents = await getCachedBalance(db, accountId);
      return { schoolId: ctx.activeSchoolId, accountId, balanceCents, currency: "USD" };
    });
  }),

  // Runway göstergesi: önümüzdeki 28 günün scheduled slot taahhüdü (tutarları zaten
  // hold'da) + serbest bakiye → haftalık ortalamayla kaç haftalık taahhüt karşılanır.
  // Tamamı okul bağlamında: price_cents okul grant'inde var, maliyet kolonu yok.
  runway: schoolProcedure.query(async ({ ctx }) => {
    return ctx.withSchoolDb(async (db) => {
      const accountId = await ensureAccount(db, {
        ownerType: "school",
        ownerId: ctx.activeSchoolId,
        kind: "school_cash",
      });
      const balanceCents = await getCachedBalance(db, accountId);
      const res = await db.query<{ total: string }>(
        `SELECT COALESCE(sum(price_cents), 0) AS total
           FROM booking_slot
          WHERE status = 'scheduled'
            AND starts_at >= now() AND starts_at < now() + interval '28 days'`,
      );
      const committedCents = Number(res.rows[0]?.total ?? 0);
      const weeklyAvgCents = committedCents / 4;
      // Haftalık taahhüt yoksa gösterge anlamsız — UI hiç göstermez (weeks=null).
      const weeks =
        weeklyAvgCents > 0
          ? Math.round(((balanceCents + committedCents) / weeklyAvgCents) * 10) / 10
          : null;
      return { committedCents, weeklyAvgCents: Math.round(weeklyAvgCents), weeks };
    });
  }),

  // Okul ekstresi: TAMAMI okul bağlamında. RLS ikinci hat — ledger_entry yalnız okulun
  // school_id'li satırlarını, ledger_account yalnız okulun kendi hesaplarını döndürür.
  // ledger_transaction okul rolüne KAPALI (type kolonu sızmaz); satır etiketi
  // hesap türü (school_cash / wallet_hold) + tutar işaretinden türetilir.
  statement: schoolProcedure
    .input(
      z
        .object({ from: dateSchema, to: dateSchema })
        .refine((v) => v.to >= v.from, { message: "bitiş başlangıçtan önce olamaz" }),
    )
    .query(async ({ ctx, input }) => {
      const { openingBalanceCents, entries } = await ctx.withSchoolDb(async (db) => {
        // Açılış bakiyesi: dönem başından önceki school_cash hareketlerinin toplamı
        // (akan bakiye nakit hesabını izler; rezerv hareketleri ayrı sütunda gösterilir).
        const opening = await db.query<{ total: string }>(
          `SELECT COALESCE(sum(e.amount_cents), 0) AS total
             FROM ledger_entry e
             JOIN ledger_account a ON a.id = e.account_id
            WHERE a.kind = 'school_cash' AND a.owner_id = $1
              AND e.created_at < $2::date`,
          [ctx.activeSchoolId, input.from],
        );

        const res = await db.query<{
          id: string;
          txn_id: string;
          amount_cents: string;
          currency: string;
          created_at: Date;
          kind: string;
        }>(
          `SELECT e.id, e.txn_id, e.amount_cents, e.currency, e.created_at, a.kind
             FROM ledger_entry e
             JOIN ledger_account a ON a.id = e.account_id
            WHERE a.kind IN ('school_cash', 'wallet_hold') AND a.owner_id = $1
              AND e.created_at >= $2::date
              AND e.created_at < ($3::date + interval '1 day')
            ORDER BY e.created_at, e.id`,
          [ctx.activeSchoolId, input.from, input.to],
        );
        return { openingBalanceCents: Number(opening.rows[0]?.total ?? 0), entries: res.rows };
      });

      // Dostane etiket bağlamı (denetim P2): txn type + ders (sınıf adı, tarih, plan tz)
      // platform bağlamında join'lenir — id listesi okulun RLS'li KENDİ entry'lerinden
      // geldiği için başka okulun işlemi buraya giremez. Maliyet alanı SELECT edilmez.
      const txnIds = [...new Set(entries.map((r) => r.txn_id))];
      const txnContext = new Map<
        string,
        { type: string; className: string | null; lessonStartsAt: Date | null; schoolTz: string | null }
      >();
      if (txnIds.length > 0) {
        const meta = await ctx.pool.withPlatform(async (db) => {
          const res = await db.query<{
            id: string;
            type: string;
            class_name: string | null;
            lesson_starts_at: Date | null;
            school_tz: string | null;
          }>(
            `SELECT lt.id, lt.type,
                    COALESCE(cg1.name, cg2.name) AS class_name,
                    COALESCE(bs1.starts_at, bs2.starts_at) AS lesson_starts_at,
                    COALESCE(dp1.school_tz, dp2.school_tz) AS school_tz
               FROM ledger_transaction lt
               LEFT JOIN booking_slot bs1 ON lt.ref_type = 'booking_slot' AND bs1.id = lt.ref_id
               LEFT JOIN dosage_plan dp1 ON dp1.id = bs1.plan_id
               LEFT JOIN class_group cg1 ON cg1.id = bs1.class_group_id
               LEFT JOIN class_session cs ON lt.ref_type = 'class_session' AND cs.id = lt.ref_id
               LEFT JOIN booking_slot bs2 ON bs2.id = cs.slot_id
               LEFT JOIN dosage_plan dp2 ON dp2.id = bs2.plan_id
               LEFT JOIN class_group cg2 ON cg2.id = bs2.class_group_id
              WHERE lt.id = ANY($1::uuid[])`,
            [txnIds],
          );
          return res.rows;
        });
        for (const m of meta) {
          txnContext.set(m.id, {
            type: m.type,
            className: m.class_name,
            lessonStartsAt: m.lesson_starts_at,
            schoolTz: m.school_tz,
          });
        }
      }

      let running = openingBalanceCents;
      let inflowCents = 0; // yüklemeler + iadeler (school_cash +)
      let outflowCents = 0; // ders düşümleri / kesintiler (school_cash -)
      let reserveNetCents = 0; // rezerv (wallet_hold) net değişimi
      const rows = entries.map((r) => {
        const amountCents = Number(r.amount_cents);
        const isCash = r.kind === "school_cash";
        if (isCash) {
          running += amountCents;
          if (amountCents >= 0) inflowCents += amountCents;
          else outflowCents += -amountCents;
        } else {
          reserveNetCents += amountCents;
        }
        return {
          id: r.id,
          txnId: r.txn_id,
          createdAt: r.created_at,
          kind: r.kind,
          label: statementLabel(r.kind, amountCents),
          // Dostane açıklama: "Ders ücreti — 7A, 12 Tem 2026" (ham type dönmez).
          description: statementDescription(txnContext.get(r.txn_id), r.kind, amountCents),
          amountCents,
          currency: r.currency.trim(),
          // Akan bakiye yalnız nakit hesabını izler; rezerv satırında değişmeden gösterilir.
          balanceCents: running,
        };
      });

      return {
        from: input.from,
        to: input.to,
        openingBalanceCents,
        closingBalanceCents: running,
        totals: { inflowCents, outflowCents, reserveNetCents },
        rows,
      };
    }),
});
