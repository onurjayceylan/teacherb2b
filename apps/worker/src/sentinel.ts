// Invariant sentinel — severity ayrımı (06 T3-⑥ kararı: hold-aging ALARM'dır, freeze değil):
//   CRITICAL: ledger_invariant_violations() satırları → payments_frozen kill-switch + audit
//             (fail-closed; yalnız defter tutarsızlığı parayı durdurur).
//   WARNING : operasyonel takılmalar (webhook_stuck, hold_aging, stuck_session,
//             email_pipeline_stalled) →
//             freeze YOK; her biri audit_log'a 'sentinel_warning' yazar. Aynı entity için
//             son 24 saatte aynı warning yazılmışsa tekrar YAZILMAZ (alarm spam koruması);
//             dönüş değerinde yine raporlanır (mevcut durumun fotoğrafı).
import type { ActorPool, Db } from "@teachernow/db";

export interface SentinelViolation {
  checkName: string;
  detail: string;
}

export interface SentinelWarning extends SentinelViolation {
  entityType: string;
  entityId: string;
}

export interface SentinelResult {
  critical: SentinelViolation[];
  warnings: SentinelWarning[];
  /** Geriye dönük alan: critical'ın takma adı (eski çağıranlar violations okur). */
  violations: SentinelViolation[];
  engagedKillSwitch: boolean;
}

async function collectCritical(db: Db): Promise<SentinelViolation[]> {
  const ledger = await db.query<{ check_name: string; detail: string }>(
    "SELECT check_name, detail FROM ledger_invariant_violations()",
  );
  return ledger.rows.map((r) => ({ checkName: r.check_name, detail: r.detail }));
}

async function collectWarnings(db: Db): Promise<SentinelWarning[]> {
  // (a) 1 saatten uzun süredir 'received' bekleyen webhook = işleme hattı tıkalı.
  const stuckWebhooks = await db.query<{
    id: string;
    provider: string;
    event_id: string;
    received_at: string;
  }>(
    `SELECT id, provider, event_id, received_at::text AS received_at
       FROM webhook_event
      WHERE status = 'received' AND received_at < now() - interval '1 hour'
      ORDER BY received_at`,
  );

  // (b) Dersi 24 saatten uzun süre önce bitmiş ama hâlâ 'scheduled' (hold'u açık) slot:
  // settle/iptal akışı işlememiş — para hold'da sıkışmış demektir.
  const agingHolds = await db.query<{ id: string; school_id: string; ends_at: string }>(
    `SELECT id, school_id, ends_at::text AS ends_at
       FROM booking_slot
      WHERE status = 'scheduled' AND ends_at < now() - interval '24 hours'
      ORDER BY ends_at`,
  );

  // (c) 6 saatten uzun süredir 'started' kalmış oturum: check_out/end akışı takılmış.
  const stuckSessions = await db.query<{ id: string; school_id: string; started_at: string }>(
    `SELECT id, school_id, started_at::text AS started_at
       FROM class_session
      WHERE status = 'started' AND started_at < now() - interval '6 hours'
      ORDER BY started_at`,
  );

  // (d) P0-C: e-posta teslim hattı tıkalı — en eski pending 2 saati aştıysa TEK uyarı
  // (satır başına değil; entity = en eski pending kayıt, dedupe onun üstünden işler).
  const stalledOutbox = await db.query<{ id: string; pending: string; oldest_created_at: string }>(
    `SELECT o.id, agg.pending, agg.oldest_created_at::text AS oldest_created_at
       FROM (SELECT count(*) AS pending, min(created_at) AS oldest_created_at
               FROM notification_outbox WHERE status = 'pending') agg
       JOIN notification_outbox o
         ON o.status = 'pending' AND o.created_at = agg.oldest_created_at
      WHERE agg.pending > 0 AND agg.oldest_created_at < now() - interval '2 hours'
      ORDER BY o.id
      LIMIT 1`,
  );

  return [
    ...stuckWebhooks.rows.map((r) => ({
      checkName: "webhook_stuck",
      entityType: "webhook_event",
      entityId: r.id,
      detail: `provider=${r.provider} event_id=${r.event_id} received_at=${r.received_at}`,
    })),
    ...agingHolds.rows.map((r) => ({
      checkName: "hold_aging",
      entityType: "booking_slot",
      entityId: r.id,
      detail: `school=${r.school_id} ends_at=${r.ends_at}`,
    })),
    ...stuckSessions.rows.map((r) => ({
      checkName: "stuck_session",
      entityType: "class_session",
      entityId: r.id,
      detail: `school=${r.school_id} started_at=${r.started_at}`,
    })),
    ...stalledOutbox.rows.map((r) => ({
      checkName: "email_pipeline_stalled",
      entityType: "notification_outbox",
      entityId: r.id,
      detail: `pending=${r.pending} oldest_created_at=${r.oldest_created_at}`,
    })),
  ];
}

/** Warning'i audit'e yazar — aynı entity+check son 24 saatte yazılmışsa no-op. */
async function auditWarning(db: Db, w: SentinelWarning): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, after)
     SELECT 'system', 'sentinel_warning', $1, $2::uuid, $3::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_log
         WHERE action = 'sentinel_warning'
           AND entity_type = $1 AND entity_id = $2::uuid
           AND after->>'check' = $4
           AND occurred_at > now() - interval '24 hours')`,
    [w.entityType, w.entityId, JSON.stringify({ check: w.checkName, detail: w.detail }), w.checkName],
  );
}

export async function runInvariantSentinel(pool: ActorPool): Promise<SentinelResult> {
  return pool.withPlatform(async (db) => {
    const critical = await collectCritical(db);
    const warnings = await collectWarnings(db);

    for (const w of warnings) await auditWarning(db, w);

    if (critical.length === 0) {
      return { critical, warnings, violations: critical, engagedKillSwitch: false };
    }

    // detail kolonu için kısaltılmış özet; tam liste dönüş değerinde ve audit_log'da.
    const summary = critical
      .map((v) => `${v.checkName}: ${v.detail}`)
      .join("; ")
      .slice(0, 1000);

    const updated = await db.query(
      `UPDATE system_flag
          SET value = true, detail = $1, updated_at = now()
        WHERE key = 'payments_frozen'`,
      [`sentinel: ${summary}`],
    );
    if (updated.rowCount !== 1) {
      throw new Error("runInvariantSentinel: payments_frozen satırı bulunamadı");
    }

    await db.query(
      `INSERT INTO audit_log (actor_kind, action, entity_type, after)
       VALUES ('system', 'kill_switch_engaged', 'system_flag', $1::jsonb)`,
      [JSON.stringify({ key: "payments_frozen", violations: critical })],
    );

    // İnsan alarmı: kill-switch outbox'a 'platform_alert' düşürür. ALERT_EMAIL yoksa
    // placeholder alıcıyla yine yazılır — dispatcher göndermese de admin listesinde görünür.
    const alertRecipient = process.env.ALERT_EMAIL ?? "alerts@yerel";
    await db.query(
      `INSERT INTO notification_outbox (recipient_email, template, payload)
       VALUES ($1, 'platform_alert', $2::jsonb)`,
      [alertRecipient, JSON.stringify({ checks: critical.map((v) => v.checkName), detail: summary })],
    );

    return { critical, warnings, violations: critical, engagedKillSwitch: true };
  });
}
