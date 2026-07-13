// Payout batch yaşam döngüsünün insan-öncesi yarısı: batch açma (createBatch),
// Wise CSV üretimi (exportBatchCsv) ve insanın "Wise'a yükledim" beyanı
// (markBatchSubmitted). Bu üç adımın HİÇBİRİ para işlemez — ledger'a dokunmak
// yalnız importResults'ın (Wise sonuç dosyası) işidir.
import type { ActorPool } from "@teachernow/db";

export interface CreateBatchInput {
  /** YYYY-MM-DD (dahil) */
  periodStart: string;
  /** YYYY-MM-DD (dahil) */
  periodEnd: string;
  createdBy?: string;
}

export interface HeldTeacher {
  teacherId: string;
  /** eğitmenin o anki teacher_payable bakiyesi */
  amountCents: number;
}

export interface CreateBatchResult {
  /** ≥1 payout açıldıysa batch id; ödenecek kimse yoksa null (boş batch OLUŞTURULMAZ). */
  batchId: string | null;
  /** açılan payout satırı sayısı */
  payouts: number;
  totalCents: number;
  /** bakiyesi > 0 ama payout_ready=false (5-evrak hard-gate) eğitmenler — görünürlük için */
  heldTeachers: HeldTeacher[];
}

/**
 * TEK platform transaction'ında payout batch'i açar:
 *  - payout_ready=true VE teacher_payable bakiyesi > 0 eğitmenler için payout satırı;
 *    tutar = o anki payable bakiyesi (dispute clawback'i bakiyede zaten netlenmiştir).
 *  - Açık (pending/submitted) payout'u olan eğitmen ATLANIR — aynı alacağı iki batch'in
 *    birden ödemesi (çift ödeme) yapısal olarak engellenir.
 *  - payout_line'lar: dönem içinde settle edilmiş ve daha önce hiçbir CANLI
 *    (cancelled/failed olmayan) payout_line'a girmemiş session'lar.
 *  - payout_ready=false ama bakiyesi > 0 eğitmenler heldTeachers'ta raporlanır.
 */
export async function createBatch(
  pool: ActorPool,
  input: CreateBatchInput,
): Promise<CreateBatchResult> {
  return pool.withPlatform(async (db) => {
    // Pozitif payable bakiyesi olan tüm eğitmenler (hard-gate ayrımı uygulamada yapılır).
    // Aday listesi batch INSERT'inden ÖNCE alınır → ödenecek kimse yoksa boş batch açılmaz.
    const candidates = await db.query<{
      teacher_id: string;
      payout_ready: boolean;
      balance_cents: string;
      has_open_payout: boolean;
    }>(
      `SELECT t.id AS teacher_id, t.payout_ready, a.balance_cents,
              EXISTS (SELECT 1 FROM payout p
                       WHERE p.teacher_id = t.id
                         AND p.status IN ('pending', 'submitted')) AS has_open_payout
         FROM teacher t
         JOIN ledger_account a
           ON a.owner_type = 'teacher' AND a.owner_id = t.id AND a.kind = 'teacher_payable'
        WHERE a.balance_cents > 0
        ORDER BY t.created_at`,
    );

    const heldTeachers: HeldTeacher[] = [];
    // Ödenebilir adaylar: payout_ready + açık payout'u olmayan. Bunlardan en az biri
    // yoksa batch OLUŞTURULMAZ (tutulan eğitmenler yine görünürlük için raporlanır).
    const payable = candidates.rows.filter((c) => {
      if (!c.payout_ready) {
        heldTeachers.push({ teacherId: c.teacher_id, amountCents: Number(c.balance_cents) });
        return false;
      }
      return !c.has_open_payout; // açık payout varken yeni satır = çift ödeme riski
    });

    if (payable.length === 0) {
      return { batchId: null, payouts: 0, totalCents: 0, heldTeachers };
    }

    const batchRes = await db.query<{ id: string }>(
      `INSERT INTO payout_batch (period_start, period_end, created_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [input.periodStart, input.periodEnd, input.createdBy ?? null],
    );
    const batchId = batchRes.rows[0]!.id;

    let payouts = 0;
    let totalCents = 0;

    for (const c of payable) {
      const amount = Number(c.balance_cents); // pg bigint → string

      const payoutRes = await db.query<{ id: string }>(
        `INSERT INTO payout (batch_id, teacher_id, amount_cents, provider_idempotency_key)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [batchId, c.teacher_id, amount, `payout:${c.teacher_id}:${batchId}`],
      );
      const payoutId = payoutRes.rows[0]!.id;

      // Dönem içi settled ve henüz canlı bir payout'a bağlanmamış session'lar bu payout'a
      // bağlanır (satır tutarı = slot'un eğitmen payı). Failed/cancelled payout'un
      // satırları "canlı değil" sayılır → sonraki batch aynı session'ları yeniden toplar.
      // İtiraz-iade edilmiş (resolved_refund) session'lar HARİÇ: settle'ları ters kayıtla geri
      // alınmıştır (bakiyeden düşmüştür) → payout satırı olarak sayılırlarsa iade edilen ders
      // "ödenmiş" görünürdü. (Not: bu yalnız iade edilen dersin satıra girmesini engeller; hiçbir
      // invariant satır-tutar özdeşliğini garanti ETMEZ — negatif-bakiye netting'inde sonraki
      // dönemde sum(payout_line) payout tutarını yine aşabilir; bkz. listOverpaidTeachers.)
      await db.query(
        `INSERT INTO payout_line (payout_id, session_id, amount_cents)
         SELECT $1, s.id, sl.teacher_pay_cents
           FROM class_session s
           JOIN booking_slot sl ON sl.id = s.slot_id
          WHERE s.teacher_id = $2
            AND s.status = 'settled'
            AND s.ended_at >= $3::date
            AND s.ended_at < $4::date + 1
            AND NOT EXISTS (
              SELECT 1 FROM session_dispute d
               WHERE d.session_id = s.id AND d.status = 'resolved_refund')
            AND NOT EXISTS (
              SELECT 1 FROM payout_line pl
                JOIN payout p ON p.id = pl.payout_id
               WHERE pl.session_id = s.id
                 AND p.status NOT IN ('cancelled', 'failed'))
          ORDER BY s.ended_at`,
        [payoutId, c.teacher_id, input.periodStart, input.periodEnd],
      );

      payouts += 1;
      totalCents += amount;
    }

    return { batchId, payouts, totalCents, heldTeachers };
  });
}

/** CSV alanı: virgül/tırnak/yeni satır içeriyorsa çift tırnakla sarılır (RFC 4180). */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// payout_method/payout_value/account_holder teacher.payout_details'ten gelir (0013);
// bilgi girilmemişse kolonlar boş kalır — eksikler teachersMissingPayoutDetails'te görünür.
const CSV_HEADER =
  "provider_idempotency_key,teacher_full_name,teacher_email,amount,currency," +
  "payout_method,payout_value,account_holder";

/**
 * Batch'in pending payout'larını Wise'a elle yüklenecek CSV'ye döker ve batch'i
 * draft→exported çeker. Yeniden export serbesttir (dosya kaybolduysa) — durum
 * exported'da kalır. CSV bir LOG değildir; e-posta alanı bilinçli olarak içindedir.
 */
export async function exportBatchCsv(pool: ActorPool, batchId: string): Promise<string> {
  return pool.withPlatform(async (db) => {
    const batch = await db.query<{ status: string }>(
      "SELECT status FROM payout_batch WHERE id = $1 FOR UPDATE",
      [batchId],
    );
    const status = batch.rows[0]?.status;
    if (!status) throw new Error(`exportBatchCsv: batch bulunamadı: ${batchId}`);
    if (status === "closed") {
      throw new Error(`exportBatchCsv: kapanmış batch export edilemez (${batchId})`);
    }

    const rows = await db.query<{
      provider_idempotency_key: string;
      full_name: string;
      email: string;
      amount_cents: string;
      currency: string;
      payout_method: string;
      payout_value: string;
      account_holder: string;
    }>(
      `SELECT p.provider_idempotency_key, t.full_name, t.email, p.amount_cents, p.currency,
              COALESCE(t.payout_details->>'method', '')        AS payout_method,
              COALESCE(t.payout_details->>'value', '')         AS payout_value,
              COALESCE(t.payout_details->>'accountHolder', '') AS account_holder
         FROM payout p
         JOIN teacher t ON t.id = p.teacher_id
        WHERE p.batch_id = $1 AND p.status = 'pending'
        ORDER BY p.created_at, p.id`,
      [batchId],
    );

    if (status === "draft") {
      await db.query(
        `UPDATE payout_batch SET status = 'exported', updated_at = now()
          WHERE id = $1 AND status = 'draft'`,
        [batchId],
      );
    }

    const lines = rows.rows.map((r) =>
      [
        csvField(r.provider_idempotency_key),
        csvField(r.full_name),
        csvField(r.email),
        (Number(r.amount_cents) / 100).toFixed(2),
        r.currency.trim(),
        csvField(r.payout_method),
        csvField(r.payout_value),
        csvField(r.account_holder),
      ].join(","),
    );
    return [CSV_HEADER, ...lines].join("\n") + "\n";
  });
}

export interface MarkBatchSubmittedResult {
  submitted: number;
}

/**
 * İnsanın "CSV'yi Wise'a yükledim" beyanı: batch'in pending payout'ları CAS'la
 * submitted + submitted_at olur. Para İŞLEMEZ — paid yalnız sonuç dosyasından gelir.
 */
export async function markBatchSubmitted(
  pool: ActorPool,
  batchId: string,
): Promise<MarkBatchSubmittedResult> {
  return pool.withPlatform(async (db) => {
    const updated = await db.query(
      `UPDATE payout
          SET status = 'submitted', submitted_at = now(), updated_at = now()
        WHERE batch_id = $1 AND status = 'pending'`,
      [batchId],
    );
    return { submitted: updated.rowCount ?? 0 };
  });
}
