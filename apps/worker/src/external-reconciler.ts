// Dış mutabakat iskeleti (0014): sağlayıcının söylediği GERÇEK bakiye vs ledger'ın
// clearing hesabı. İşaret sözleşmesi: topup/payout kayıtlarında clearing hesabı,
// sağlayıcıda duran para kadar EKSİ bakiye taşır → beklenen sağlayıcı bakiyesi =
// -(clearing bacak toplamı). Fark ≠ 0 → audit_log'a 'sentinel_warning' (check
// 'external_balance_mismatch'); freeze YOK — para akışına dokunulmaz. Aynı provider
// için son 24 saatte aynı alarm yazılmışsa tekrar YAZILMAZ (sentinel dedupe deseni);
// dönüş değeri yine raporlar. Stripe: API'den (STRIPE_SECRET_KEY varsa) snapshot alınır,
// anahtar yoksa sessizce atlanır. Wise: API yok — kurucunun elle girdiği (source='manual')
// son 7 günlük snapshot kullanılır; yoksa atlanır.
import type { ActorPool, Db } from "@teachernow/db";

export interface ProviderReconcileResult {
  provider: "stripe" | "wise";
  /** anahtar/snapshot yok → karşılaştırma yapılmadı */
  skipped: boolean;
  snapshotBalanceCents?: number;
  /** beklenen sağlayıcı bakiyesi: -(clearing bacak toplamı) */
  ledgerBalanceCents?: number;
  diffCents?: number;
  /** fark ≠ 0 (audit'e yazım 24 saat dedupe'a tabidir — bkz. üst yorum) */
  alarmed: boolean;
}

export interface ExternalReconcilerResult {
  stripe: ProviderReconcileResult;
  wise: ProviderReconcileResult;
}

/** USD cent döndürür (available + pending). Test enjeksiyonu için ayrı tip. */
export type StripeBalanceFetcher = (secretKey: string) => Promise<number>;

export interface ExternalReconcilerOptions {
  /** verilmezse gerçek Stripe API'si çağrılır (yalnız STRIPE_SECRET_KEY varsa) */
  fetchStripeBalance?: StripeBalanceFetcher;
}

interface StripeBalanceAmount {
  amount: number;
  currency: string;
}

/**
 * Stripe /v1/balance — SDK'sız raw fetch (defaultResendSender deseni: 2xx değilse hata).
 * available + pending USD toplamı cent olarak döner.
 */
export async function fetchStripeBalanceUsd(secretKey: string): Promise<number> {
  const res = await fetch("https://api.stripe.com/v1/balance", {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`stripe balance: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    available?: StripeBalanceAmount[];
    pending?: StripeBalanceAmount[];
  };
  const sumUsd = (rows: StripeBalanceAmount[] | undefined): number =>
    (rows ?? [])
      .filter((r) => r.currency?.toLowerCase() === "usd")
      .reduce((acc, r) => acc + r.amount, 0);
  return sumUsd(body.available) + sumUsd(body.pending);
}

/** Clearing hesabı track_balance dışıdır — tek doğru kaynak bacak toplamı. */
async function clearingEntrySum(db: Db, kind: "stripe_clearing" | "wise_clearing"): Promise<number> {
  const res = await db.query<{ total: string }>(
    `SELECT COALESCE(SUM(e.amount_cents), 0) AS total
       FROM ledger_entry e
       JOIN ledger_account a ON a.id = e.account_id
      WHERE a.owner_type = 'platform' AND a.owner_id IS NULL AND a.kind = $1`,
    [kind],
  );
  return Number(res.rows[0]?.total ?? 0);
}

/** Fark alarmı — aynı provider için son 24 saatte yazılmışsa no-op (spam koruması). */
async function auditMismatch(
  db: Db,
  provider: "stripe" | "wise",
  snapshotId: string,
  detail: string,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, after)
     SELECT 'system', 'sentinel_warning', 'external_balance_snapshot', $1::uuid, $2::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_log
         WHERE action = 'sentinel_warning'
           AND after->>'check' = 'external_balance_mismatch'
           AND after->>'provider' = $3
           AND occurred_at > now() - interval '24 hours')`,
    [
      snapshotId,
      JSON.stringify({ check: "external_balance_mismatch", provider, detail }),
      provider,
    ],
  );
}

async function reconcileStripe(db: Db, balanceCents: number): Promise<ProviderReconcileResult> {
  const snap = await db.query<{ id: string }>(
    `INSERT INTO external_balance_snapshot (provider, balance_cents, currency, source)
     VALUES ('stripe', $1, 'USD', 'api')
     RETURNING id`,
    [balanceCents],
  );
  const snapshotId = snap.rows[0]!.id;

  const ledgerBalanceCents = -(await clearingEntrySum(db, "stripe_clearing"));
  const diffCents = balanceCents - ledgerBalanceCents;
  if (diffCents !== 0) {
    await auditMismatch(
      db,
      "stripe",
      snapshotId,
      `snapshot=${balanceCents} ledger=${ledgerBalanceCents} diff=${diffCents}`,
    );
  }
  return {
    provider: "stripe",
    skipped: false,
    snapshotBalanceCents: balanceCents,
    ledgerBalanceCents,
    diffCents,
    alarmed: diffCents !== 0,
  };
}

async function reconcileWise(db: Db): Promise<ProviderReconcileResult> {
  // Kurucunun son 7 gün içinde elle girdiği snapshot; yoksa karşılaştırma yapılmaz.
  const snap = await db.query<{ id: string; balance_cents: string }>(
    `SELECT id, balance_cents
       FROM external_balance_snapshot
      WHERE provider = 'wise' AND source = 'manual'
        AND captured_at > now() - interval '7 days'
      ORDER BY captured_at DESC
      LIMIT 1`,
  );
  const row = snap.rows[0];
  if (!row) return { provider: "wise", skipped: true, alarmed: false };

  const balanceCents = Number(row.balance_cents); // pg bigint → string
  const ledgerBalanceCents = -(await clearingEntrySum(db, "wise_clearing"));
  const diffCents = balanceCents - ledgerBalanceCents;
  if (diffCents !== 0) {
    await auditMismatch(
      db,
      "wise",
      row.id,
      `snapshot=${balanceCents} ledger=${ledgerBalanceCents} diff=${diffCents}`,
    );
  }
  return {
    provider: "wise",
    skipped: false,
    snapshotBalanceCents: balanceCents,
    ledgerBalanceCents,
    diffCents,
    alarmed: diffCents !== 0,
  };
}

export async function runExternalReconciler(
  pool: ActorPool,
  opts: ExternalReconcilerOptions = {},
): Promise<ExternalReconcilerResult> {
  // Stripe fetch'i transaction DIŞINDA yapılır (ağ çağrısı bağlantı/kilit tutmasın);
  // her provider kendi platform transaction'ında işlenir — biri diğerini düşürmez.
  const secretKey = process.env.STRIPE_SECRET_KEY;
  let stripe: ProviderReconcileResult;
  if (!secretKey) {
    // Anahtar yoksa sessizce atla — heartbeat'i çağıran (index.ts) yine basar.
    stripe = { provider: "stripe", skipped: true, alarmed: false };
  } else {
    const balanceCents = await (opts.fetchStripeBalance ?? fetchStripeBalanceUsd)(secretKey);
    stripe = await pool.withPlatform((db) => reconcileStripe(db, balanceCents));
  }
  const wise = await pool.withPlatform((db) => reconcileWise(db));
  return { stripe, wise };
}
