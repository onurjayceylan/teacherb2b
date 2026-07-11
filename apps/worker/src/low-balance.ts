// Düşük bakiye uyarı taraması: her aktif okul için school_cash bakiyesi ile önümüzdeki
// 7 günün 'scheduled' slot taahhüdü karşılaştırılır; bakiye < taahhüt ise audit_log'a
// 'low_balance_warning' yazılır. Gelecekte başlayan 'blocked_insufficient_funds' slotu
// olan okul da (dispatch orada zaten durdu) aynı uyarıyı alır. E-posta/pano bu kayda
// bağlanacak — şimdilik kalıcı iz (kayıt = tek gerçek).
// Spam koruması (sentinel deseni): aynı okul için son 24 saatte kayıt varsa yenisi yazılmaz.
import type { ActorPool } from "@teachernow/db";

export interface LowBalanceResult {
  warned: number;
}

export async function runLowBalanceCheck(pool: ActorPool): Promise<LowBalanceResult> {
  return pool.withPlatform(async (db) => {
    const res = await db.query(
      `WITH snapshot AS (
         SELECT s.id AS school_id,
                COALESCE(cash.balance_cents, 0) AS balance_cents,
                COALESCE(committed.total_cents, 0) AS committed_cents,
                COALESCE(blocked.n, 0) AS blocked_count
           FROM school s
           LEFT JOIN LATERAL (
             SELECT SUM(a.balance_cents) AS balance_cents
               FROM ledger_account a
              WHERE a.owner_type = 'school' AND a.owner_id = s.id AND a.kind = 'school_cash'
           ) cash ON true
           LEFT JOIN LATERAL (
             SELECT SUM(b.price_cents) AS total_cents
               FROM booking_slot b
              WHERE b.school_id = s.id AND b.status = 'scheduled'
                AND b.starts_at >= now() AND b.starts_at < now() + interval '7 days'
           ) committed ON true
           LEFT JOIN LATERAL (
             SELECT count(*) AS n
               FROM booking_slot b
              WHERE b.school_id = s.id AND b.status = 'blocked_insufficient_funds'
                AND b.starts_at > now()
           ) blocked ON true
          WHERE s.status = 'active'
       ),
       due AS (
         SELECT school_id, balance_cents, committed_cents
           FROM snapshot
          WHERE (balance_cents < committed_cents OR blocked_count > 0)
            AND NOT EXISTS (
              SELECT 1
                FROM audit_log a
               WHERE a.action = 'low_balance_warning'
                 AND a.entity_type = 'school'
                 AND a.entity_id = snapshot.school_id
                 AND a.occurred_at > now() - interval '24 hours'
            )
       )
       INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, school_id, after)
       SELECT 'agent', 'low_balance_warning', 'school', due.school_id, due.school_id,
              jsonb_build_object(
                'balanceCents', due.balance_cents,
                'committed7dCents', due.committed_cents
              )
         FROM due`,
    );
    return { warned: res.rowCount ?? 0 };
  });
}
