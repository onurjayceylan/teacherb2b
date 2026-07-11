// Sentinel severity ayrımı: CRITICAL (ledger ihlali) freeze eder; WARNING'ler
// (webhook_stuck / hold_aging / stuck_session) yalnız audit'e alarm yazar — freeze YOK.
// Drift testi kasada kalıcı drift + kill-switch bırakır, o yüzden EN SONA konuldu.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { ensureAccount, postTxn } from "@teachernow/ledger";
import { runInvariantSentinel } from "../src/sentinel.js";

let tdb: TestDb;
let schoolId: string;
let classGroupId: string;
let cash: string;
let clearing: string;

beforeAll(async () => {
  tdb = await createTestDb();
  const seeded = await tdb.pool.withPlatform(async (db) => {
    const org = await db.query<{ id: string }>(
      "INSERT INTO organization (name) VALUES ('Sentinel Org') RETURNING id",
    );
    const orgId = org.rows[0]?.id;
    if (!orgId) throw new Error("organization insert başarısız");
    const school = await db.query<{ id: string }>(
      "INSERT INTO school (organization_id, name) VALUES ($1, 'Sentinel School') RETURNING id",
      [orgId],
    );
    const sid = school.rows[0]?.id;
    if (!sid) throw new Error("school insert başarısız");
    return {
      schoolId: sid,
      cash: await ensureAccount(db, { ownerType: "school", ownerId: sid, kind: "school_cash" }),
      clearing: await ensureAccount(db, { ownerType: "platform", ownerId: null, kind: "stripe_clearing" }),
    };
  });
  schoolId = seeded.schoolId;
  cash = seeded.cash;
  clearing = seeded.clearing;
  // class_group okulun verisi — okul bağlamında açılır (role_platform INSERT edemez)
  classGroupId = await tdb.pool.withSchool([schoolId], async (db) => {
    const res = await db.query<{ id: string }>(
      "INSERT INTO class_group (school_id, name) VALUES ($1, '7-B') RETURNING id",
      [schoolId],
    );
    return res.rows[0]!.id;
  });
});

afterAll(async () => {
  await tdb.drop();
});

async function paymentsFrozen(): Promise<boolean> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ value: boolean }>(
      "SELECT value FROM system_flag WHERE key = 'payments_frozen'",
    );
    return res.rows[0]?.value ?? false;
  });
}

/** İlgili check için yazılmış 'sentinel_warning' audit satırı sayısı. */
async function warningAuditCount(checkName: string): Promise<number> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_log WHERE action = 'sentinel_warning' AND after->>'check' = $1",
      [checkName],
    );
    return Number(res.rows[0]?.n ?? 0);
  });
}

/** Slot FK zinciri: pool + dosage_plan (bir kez), sonra istenen zaman aralığında slot. */
let planId: string | undefined;
async function seedSlot(occurrenceKey: string, startsAt: Date, endsAt: Date): Promise<string> {
  return tdb.pool.withPlatform(async (db) => {
    if (!planId) {
      const pool = await db.query<{ id: string }>(
        "INSERT INTO pool (key, name, sell_per_lesson_cents, pay_per_lesson_cents) VALUES ('sentinel_pool', 'sentinel_pool', 4000, 1600) RETURNING id",
      );
      const plan = await db.query<{ id: string }>(
        `INSERT INTO dosage_plan
           (school_id, class_group_id, pool_id, weekday, start_minute, duration_min,
            school_tz, price_cents, teacher_pay_cents, start_date, weeks)
         VALUES ($1, $2, $3, 0, 840, 60, 'UTC', 4000, 1600, '2026-01-05', 4)
         RETURNING id`,
        [schoolId, classGroupId, pool.rows[0]!.id],
      );
      planId = plan.rows[0]!.id;
    }
    const slot = await db.query<{ id: string }>(
      `INSERT INTO booking_slot
         (school_id, plan_id, class_group_id, pool_id, occurrence_key,
          starts_at, ends_at, price_cents, teacher_pay_cents)
       SELECT $1, $2, $3, pool_id, $4, $5, $6, 4000, 1600 FROM dosage_plan WHERE id = $2
       RETURNING id`,
      [schoolId, planId, classGroupId, occurrenceKey, startsAt, endsAt],
    );
    return slot.rows[0]!.id;
  });
}

test("temiz DB: critical/warning yok, kill-switch devreye girmez, flag false kalır", async () => {
  const result = await runInvariantSentinel(tdb.pool);
  expect(result.critical).toEqual([]);
  expect(result.warnings).toEqual([]);
  expect(result.engagedKillSwitch).toBe(false);
  expect(await paymentsFrozen()).toBe(false);
});

test("2 saattir 'received' bekleyen webhook: WARNING'dir — freeze ETMEZ, audit'e alarm yazar", async () => {
  await tdb.pool.withPlatform((db) =>
    db.query(
      `INSERT INTO webhook_event (provider, event_id, kind, received_at)
       VALUES ('stripe', 'evt_stuck_1', 'payment_intent.succeeded', now() - interval '2 hours')`,
    ),
  );

  const result = await runInvariantSentinel(tdb.pool);
  const stuck = result.warnings.filter((w) => w.checkName === "webhook_stuck");
  expect(stuck.length).toBe(1);
  expect(stuck[0]?.detail).toContain("evt_stuck_1");
  expect(stuck[0]?.entityType).toBe("webhook_event");

  // eski davranışın tersi: webhook takılması artık kill-switch NEDENİ DEĞİL
  expect(result.critical).toEqual([]);
  expect(result.engagedKillSwitch).toBe(false);
  expect(await paymentsFrozen()).toBe(false);
  expect(await warningAuditCount("webhook_stuck")).toBe(1);
});

test("hold_aging: dersi 24 saatten eski bitmiş scheduled slot WARNING olur, flag false kalır", async () => {
  const slotId = await seedSlot(
    "2026-01-05",
    new Date(Date.now() - 26 * 3_600_000),
    new Date(Date.now() - 25 * 3_600_000),
  );

  const result = await runInvariantSentinel(tdb.pool);
  const aging = result.warnings.filter((w) => w.checkName === "hold_aging");
  expect(aging.length).toBe(1);
  expect(aging[0]?.entityId).toBe(slotId);
  expect(aging[0]?.entityType).toBe("booking_slot");
  expect(result.engagedKillSwitch).toBe(false);
  expect(await paymentsFrozen()).toBe(false);
  expect(await warningAuditCount("hold_aging")).toBe(1);
});

test("stuck_session: 6 saatten uzun 'started' kalan oturum WARNING olur", async () => {
  // Bu slot hold_aging'e YAKALANMASIN diye ders bitişi yeni tutulur (30 dk önce).
  const slotId = await seedSlot(
    "2026-01-12",
    new Date(Date.now() - 90 * 60_000),
    new Date(Date.now() - 30 * 60_000),
  );
  const sessionId = await tdb.pool.withPlatform(async (db) => {
    const teacher = await db.query<{ id: string }>(
      `INSERT INTO teacher (full_name, email, source, timezone, status, dispatch_ready)
       VALUES ('Sentinel Teacher', 'sentinel.teacher@example.com', 'hrmasterz', 'UTC', 'active', true)
       RETURNING id`,
    );
    // durum whitelist trigger'ı yalnız UPDATE'te — INSERT anında 'started' kurulabilir
    const session = await db.query<{ id: string }>(
      `INSERT INTO class_session (slot_id, school_id, teacher_id, class_group_id, status, started_at)
       VALUES ($1, $2, $3, $4, 'started', now() - interval '7 hours')
       RETURNING id`,
      [slotId, schoolId, teacher.rows[0]!.id, classGroupId],
    );
    return session.rows[0]!.id;
  });

  const result = await runInvariantSentinel(tdb.pool);
  const stuck = result.warnings.filter((w) => w.checkName === "stuck_session");
  expect(stuck.length).toBe(1);
  expect(stuck[0]?.entityId).toBe(sessionId);
  expect(result.engagedKillSwitch).toBe(false);
  expect(await paymentsFrozen()).toBe(false);
  expect(await warningAuditCount("stuck_session")).toBe(1);
});

test("24 saat tekrar koruması: ikinci koşum warning'leri raporlar ama audit'e YENİDEN yazmaz", async () => {
  const result = await runInvariantSentinel(tdb.pool);
  // durum fotoğrafı hâlâ tam: üç warning de raporda
  expect(result.warnings.map((w) => w.checkName).sort()).toEqual([
    "hold_aging",
    "stuck_session",
    "webhook_stuck",
  ]);
  // ...ama alarm başına audit satırı hâlâ 1'er tane
  expect(await warningAuditCount("webhook_stuck")).toBe(1);
  expect(await warningAuditCount("hold_aging")).toBe(1);
  expect(await warningAuditCount("stuck_session")).toBe(1);
  expect(await paymentsFrozen()).toBe(false);
});

test("email_pipeline_stalled: 2 saatten eski pending outbox WARNING olur, freeze ETMEZ", async () => {
  // P0-C: e-posta hattı tıkalı (anahtar yok / Resend down) — 3 saat önce yazılmış pending.
  await tdb.pool.withPlatform((db) =>
    db.query(
      `INSERT INTO notification_outbox (recipient_email, template, payload, status, created_at)
       VALUES ('stalled@example.com', 'teacher_invite', '{}'::jsonb, 'pending', now() - interval '3 hours')`,
    ),
  );

  const result = await runInvariantSentinel(tdb.pool);
  const stalled = result.warnings.filter((w) => w.checkName === "email_pipeline_stalled");
  expect(stalled.length).toBe(1);
  expect(stalled[0]?.detail).toContain("pending=");
  expect(result.critical).toEqual([]);
  expect(result.engagedKillSwitch).toBe(false);
  expect(await paymentsFrozen()).toBe(false);
  expect(await warningAuditCount("email_pipeline_stalled")).toBe(1);
});

test("bakiye drift'i CRITICAL'dır: flag açılır, audit yazılır; post_ledger_txn artık patlar", async () => {
  // Kill-switch alarmının alıcısını sabitle (ALERT_EMAIL yolu da böylece test edilir).
  process.env.ALERT_EMAIL = "sentinel-alerts@test.example";
  // Cache'i kasten kaydır — rollere UPDATE grant'i yok, yalnız owner yapabilir.
  await tdb.pool.withOwner((db) =>
    db.query("UPDATE ledger_account SET balance_cents = 777 WHERE id = $1", [cash]),
  );

  const result = await runInvariantSentinel(tdb.pool);
  expect(result.engagedKillSwitch).toBe(true);
  const drift = result.critical.find((v) => v.checkName === "balance_cache_drift");
  expect(drift).toBeDefined();
  expect(drift?.detail).toContain(cash);
  // geriye dönük alan: violations = critical (warning'ler oraya SIZMAZ)
  expect(result.violations).toEqual(result.critical);

  expect(await paymentsFrozen()).toBe(true);

  const audit = await tdb.pool.withPlatform((db) =>
    db.query<{ actor_kind: string; entity_type: string }>(
      "SELECT actor_kind, entity_type FROM audit_log WHERE action = 'kill_switch_engaged'",
    ),
  );
  expect(audit.rows.length).toBe(1);
  expect(audit.rows[0]?.actor_kind).toBe("system");
  expect(audit.rows[0]?.entity_type).toBe("system_flag");

  // Kill-switch insan alarmı: outbox'a 'platform_alert' düştü (dispatcher göndermese
  // de admin listesinde görünür).
  const alerts = await tdb.pool.withPlatform((db) =>
    db.query<{
      recipient_email: string;
      status: string;
      payload: { checks: string[]; detail: string };
    }>(
      "SELECT recipient_email, status, payload FROM notification_outbox WHERE template = 'platform_alert'",
    ),
  );
  expect(alerts.rows.length).toBe(1);
  expect(alerts.rows[0]?.recipient_email).toBe("sentinel-alerts@test.example");
  expect(alerts.rows[0]?.status).toBe("pending");
  expect(alerts.rows[0]?.payload.checks).toContain("balance_cache_drift");
  expect(alerts.rows[0]?.payload.detail).toContain("balance_cache_drift");

  await expect(
    tdb.pool.withPlatform((db) =>
      postTxn(db, {
        idempotencyKey: "sentinel-frozen-1",
        type: "topup",
        entries: [
          { accountId: cash, amountCents: 1_000 },
          { accountId: clearing, amountCents: -1_000 },
        ],
      }),
    ),
  ).rejects.toThrow(/payments_frozen/);
});
