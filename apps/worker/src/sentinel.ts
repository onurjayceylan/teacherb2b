// Invariant sentinel: defter tutarlılığını ve takılı webhook'ları tarar;
// ihlal görürse payments_frozen kill-switch'ini devreye alır (fail-closed).
import type { ActorPool, Db } from "@teachernow/db";

export interface SentinelViolation {
  checkName: string;
  detail: string;
}

export interface SentinelResult {
  violations: SentinelViolation[];
  engagedKillSwitch: boolean;
}

async function collectViolations(db: Db): Promise<SentinelViolation[]> {
  const ledger = await db.query<{ check_name: string; detail: string }>(
    "SELECT check_name, detail FROM ledger_invariant_violations()",
  );

  // 1 saatten uzun süredir 'received' durumunda bekleyen webhook = işleme hattı tıkalı.
  const stuck = await db.query<{ provider: string; event_id: string; received_at: string }>(
    `SELECT provider, event_id, received_at::text AS received_at
       FROM webhook_event
      WHERE status = 'received' AND received_at < now() - interval '1 hour'
      ORDER BY received_at`,
  );

  return [
    ...ledger.rows.map((r) => ({ checkName: r.check_name, detail: r.detail })),
    ...stuck.rows.map((r) => ({
      checkName: "webhook_stuck",
      detail: `provider=${r.provider} event_id=${r.event_id} received_at=${r.received_at}`,
    })),
  ];
}

export async function runInvariantSentinel(pool: ActorPool): Promise<SentinelResult> {
  return pool.withPlatform(async (db) => {
    const violations = await collectViolations(db);
    if (violations.length === 0) {
      return { violations, engagedKillSwitch: false };
    }

    // detail kolonu için kısaltılmış özet; tam liste dönüş değerinde ve audit_log'da.
    const summary = violations
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
      [JSON.stringify({ key: "payments_frozen", violations })],
    );

    return { violations, engagedKillSwitch: true };
  });
}
