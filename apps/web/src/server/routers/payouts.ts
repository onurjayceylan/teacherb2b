// Payout operasyonları (yalnız platform): Wise-manuel akış — batch oluştur → CSV indir →
// insan Wise'a yükler → "yükledim" beyanı (markSubmitted) → Wise sonuç CSV'si import edilir.
// Para YALNIZ 'paid' importunda ledger'a işler; iş kuralları @teachernow/payouts modülünde,
// burada yalnız giriş doğrulama + CSV parse + yetki + bağlam seçimi vardır.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  createBatch,
  exportBatchCsv,
  getTeacherPayouts,
  importResults,
  listOpen,
  markBatchSubmitted,
  type ImportResultRow,
} from "@teachernow/payouts";
import { sweepBackfill } from "@teachernow/dispatch";
import { platformProcedure, router } from "../trpc";

const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "tarih YYYY-AA-GG biçiminde olmalı");

/**
 * Tek CSV satırını alanlara böler: çift tırnaklı alanlar ("a,b" / "" kaçışı) desteklenir,
 * ayraç parametreyle gelir (virgül ya da noktalı virgül).
 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

/**
 * Wise sonuç CSV'sini esnek parse eder: başlık satırı zorunlu
 * (idempotency_key, external_ref, status, failure_reason — sıra serbest),
 * ayraç virgül YA DA noktalı virgül olabilir, boş satırlar atlanır.
 * Bozuk satır sessizce geçilmez — anlaşılır hata fırlatılır (yanlış dosya importu erken düşsün).
 */
export function parseResultsCsv(csvText: string): ImportResultRow[] {
  const lines = csvText
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Error("CSV boş — en az başlık satırı ve bir sonuç satırı gerekli");
  }

  const headerLine = lines[0]!;
  // Ayraç tespiti: başlıkta noktalı virgül varsa ';', yoksa ','.
  const delimiter = headerLine.includes(";") ? ";" : ",";
  const header = splitCsvLine(headerLine, delimiter).map((h) => h.toLowerCase());
  const col = {
    idempotencyKey: header.indexOf("idempotency_key"),
    externalRef: header.indexOf("external_ref"),
    status: header.indexOf("status"),
    failureReason: header.indexOf("failure_reason"),
  };
  if (col.idempotencyKey < 0 || col.externalRef < 0 || col.status < 0) {
    throw new Error(
      "CSV başlığı eksik — idempotency_key, external_ref ve status kolonları zorunlu",
    );
  }

  const rows: ImportResultRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitCsvLine(lines[i]!, delimiter);
    const idempotencyKey = fields[col.idempotencyKey] ?? "";
    const externalRef = fields[col.externalRef] ?? "";
    const status = (fields[col.status] ?? "").toLowerCase();
    const failureReason = col.failureReason >= 0 ? (fields[col.failureReason] ?? "") : "";
    if (!idempotencyKey) {
      throw new Error(`CSV satır ${i + 1}: idempotency_key boş`);
    }
    if (status !== "paid" && status !== "failed") {
      throw new Error(`CSV satır ${i + 1}: status 'paid' ya da 'failed' olmalı ('${status}')`);
    }
    rows.push({
      idempotencyKey,
      externalRef,
      status,
      ...(failureReason ? { failureReason } : {}),
    });
  }
  if (rows.length === 0) {
    throw new Error("CSV'de sonuç satırı yok — yalnız başlık var");
  }
  return rows;
}

/** Modül hatasını kullanıcıya anlaşılır BAD_REQUEST olarak döndürür. */
function asBadRequest(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  return new TRPCError({
    code: "BAD_REQUEST",
    message: err instanceof Error ? err.message : String(err),
  });
}

export const payoutsRouter = router({
  // Dönem batch'i: settled + payout'a girmemiş alacakları eğitmen başına tek payout'ta toplar.
  // Hard-gate: payout_ready olmayan eğitmenler TUTULUR — ada çevrilip uyarı listesinde döner.
  createBatch: platformProcedure
    .input(
      z
        .object({ periodStart: dateSchema, periodEnd: dateSchema })
        .refine((v) => v.periodEnd >= v.periodStart, {
          message: "dönem sonu başlangıçtan önce olamaz",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      let res;
      try {
        res = await createBatch(ctx.pool, {
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          createdBy: ctx.actor.userId,
        });
      } catch (err) {
        throw asBadRequest(err);
      }
      // Tutulan eğitmenlerin adları (uyarı listesi) — yalnız ad, platform bağlamında.
      const heldIds = res.heldTeachers.map((t) => t.teacherId);
      const names =
        heldIds.length === 0
          ? new Map<string, string>()
          : await ctx.pool.withPlatform(async (db) => {
              const rows = await db.query<{ id: string; full_name: string }>(
                "SELECT id, full_name FROM teacher WHERE id = ANY($1::uuid[])",
                [heldIds],
              );
              return new Map(rows.rows.map((r) => [r.id, r.full_name]));
            });
      return {
        batchId: res.batchId,
        payoutCount: res.payouts,
        totalCents: res.totalCents,
        heldTeachers: res.heldTeachers.map((t) => ({
          teacherId: t.teacherId,
          fullName: names.get(t.teacherId) ?? t.teacherId,
          payableCents: t.amountCents,
        })),
      };
    }),

  // Batch listesi: payout sayıları (durum kırılımıyla) + toplam tutar + batch durumu.
  listBatches: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        id: string;
        period_start: string;
        period_end: string;
        status: string;
        created_at: Date;
        payout_count: string;
        total_cents: string;
        paid_count: string;
        failed_count: string;
        open_count: string;
      }>(
        `SELECT b.id, b.period_start::text AS period_start, b.period_end::text AS period_end,
                b.status, b.created_at,
                count(p.id) AS payout_count,
                COALESCE(sum(p.amount_cents), 0) AS total_cents,
                count(p.id) FILTER (WHERE p.status = 'paid') AS paid_count,
                count(p.id) FILTER (WHERE p.status = 'failed') AS failed_count,
                count(p.id) FILTER (WHERE p.status IN ('pending', 'submitted')) AS open_count
           FROM payout_batch b
           LEFT JOIN payout p ON p.batch_id = b.id
          GROUP BY b.id
          ORDER BY b.created_at DESC`,
      );
      return res.rows.map((r) => ({
        id: r.id,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        status: r.status,
        createdAt: r.created_at,
        payoutCount: Number(r.payout_count),
        totalCents: Number(r.total_cents),
        paidCount: Number(r.paid_count),
        failedCount: Number(r.failed_count),
        openCount: Number(r.open_count),
      }));
    });
  }),

  // Wise'a elle yüklenecek dosya: UI textarea'da gösterir + data-URL ile indirtir.
  exportCsv: platformProcedure
    .input(z.object({ batchId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      try {
        const csv = await exportBatchCsv(ctx.pool, input.batchId);
        return { csv };
      } catch (err) {
        throw asBadRequest(err);
      }
    }),

  // İnsan beyanı: "dosyayı Wise'a yükledim" — payout'lar submitted olur, para OYNAMAZ.
  markSubmitted: platformProcedure
    .input(z.object({ batchId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const res = await markBatchSubmitted(ctx.pool, input.batchId);
        return { batchId: input.batchId, submitted: res.submitted };
      } catch (err) {
        throw asBadRequest(err);
      }
    }),

  // Wise sonuç dosyası: CSV burada parse edilir, modül satırları idempotent uygular.
  // Para YALNIZ 'paid' satırında oynar; tekrarlanan import warnings üretir, çift ödeme imkânsız.
  importResults: platformProcedure
    .input(
      z.object({
        batchId: z.string().uuid(),
        csvText: z.string().min(1).max(1_000_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let rows: ImportResultRow[];
      try {
        rows = parseResultsCsv(input.csvText);
      } catch (err) {
        throw asBadRequest(err);
      }
      try {
        const res = await importResults(ctx.pool, input.batchId, rows);
        return { paid: res.paid, failed: res.failed, warnings: res.warnings };
      } catch (err) {
        throw asBadRequest(err);
      }
    }),

  // Açık payout'lar (pending/submitted) — modül sorgusu + eğitmen adı zenginleştirmesi.
  listOpen: platformProcedure.query(async ({ ctx }) => {
    const open = await listOpen(ctx.pool);
    const ids = [...new Set(open.map((p) => p.teacherId))];
    const names =
      ids.length === 0
        ? new Map<string, string>()
        : await ctx.pool.withPlatform(async (db) => {
            const rows = await db.query<{ id: string; full_name: string }>(
              "SELECT id, full_name FROM teacher WHERE id = ANY($1::uuid[])",
              [ids],
            );
            return new Map(rows.rows.map((r) => [r.id, r.full_name]));
          });
    return open.map((p) => ({ ...p, teacherName: names.get(p.teacherId) ?? p.teacherId }));
  }),

  // Operasyon tablosu: son payout'lar (TÜM durumlar) — failed sebepleri + Wise ref dahil.
  listRecent: platformProcedure.query(async ({ ctx }) => {
    return ctx.pool.withPlatform(async (db) => {
      const res = await db.query<{
        id: string;
        batch_id: string;
        teacher_name: string;
        amount_cents: string;
        currency: string;
        status: string;
        failure_reason: string | null;
        external_ref: string | null;
        created_at: Date;
        paid_at: Date | null;
      }>(
        `SELECT p.id, p.batch_id, t.full_name AS teacher_name, p.amount_cents, p.currency,
                p.status, p.failure_reason, p.external_ref, p.created_at, p.paid_at
           FROM payout p
           JOIN teacher t ON t.id = p.teacher_id
          ORDER BY p.created_at DESC, p.id
          LIMIT 200`,
      );
      return res.rows.map((r) => ({
        id: r.id,
        batchId: r.batch_id,
        teacherName: r.teacher_name,
        amountCents: Number(r.amount_cents),
        currency: r.currency.trim(),
        status: r.status,
        failureReason: r.failure_reason,
        externalRef: r.external_ref,
        createdAt: r.created_at,
        paidAt: r.paid_at,
      }));
    });
  }),

  // Backfill süpürücüsü (S5): eğitmen düşmüş slotlara yeniden teklif; SLA aşımında
  // slot escalated + okul ücreti iade edilir. Normalde zamanlanmış iş; burası admin tetiği.
  runBackfillSweep: platformProcedure.mutation(async ({ ctx }) => {
    const res = await sweepBackfill(ctx.pool, {});
    return { offered: res.offered, reoffered: res.reoffered, escalated: res.escalated };
  }),
});
