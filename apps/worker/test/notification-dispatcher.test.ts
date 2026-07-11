// Outbox dispatcher: (1) sender yoksa pending'e dokunulmaz (skipped); (2) sender varsa
// gönderim → sent + sent_at + token'lı link; (3) 7 günden eski pending → expired;
// (4) sender hatası → attempt++ + last_error, 5. denemede failed.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import {
  sendPendingNotifications,
  type EmailMessage,
} from "../src/notification-dispatcher.js";

let tdb: TestDb;

beforeAll(async () => {
  process.env.BASE_URL = "https://app.test";
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

interface OutboxState {
  status: string;
  attempt: number;
  last_error: string | null;
  sent_at: Date | null;
}

async function enqueue(input: {
  recipient: string;
  template: string;
  payload: Record<string, unknown>;
  ageDays?: number;
}): Promise<string> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO notification_outbox (recipient_email, template, payload, created_at)
       VALUES ($1, $2, $3::jsonb, now() - make_interval(days => $4))
       RETURNING id`,
      [input.recipient, input.template, JSON.stringify(input.payload), input.ageDays ?? 0],
    );
    return res.rows[0]!.id;
  });
}

async function stateOf(id: string): Promise<OutboxState> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<OutboxState>(
      "SELECT status, attempt, last_error, sent_at FROM notification_outbox WHERE id = $1",
      [id],
    );
    return res.rows[0]!;
  });
}

/** Test-arası sızıntıyı önlemek için satırı kuyruğun dışına çeker. */
async function drain(id: string): Promise<void> {
  await tdb.pool.withPlatform((db) =>
    db.query(
      "UPDATE notification_outbox SET status = 'sent', sent_at = now() WHERE id = $1",
      [id],
    ),
  );
}

test("(1) sender yoksa pending'e dokunulmaz → {skipped}", async () => {
  const id = await enqueue({
    recipient: "skip@example.com",
    template: "teacher_portal",
    payload: { token: "portal-tok", fullName: "Skip Teacher" },
  });

  const result = await sendPendingNotifications(tdb.pool, {});
  expect(result).toEqual({ sent: 0, failed: 0, expired: 0, skipped: 1 });

  const state = await stateOf(id);
  expect(state.status).toBe("pending");
  expect(state.attempt).toBe(0);
  expect(state.sent_at).toBeNull();
  await drain(id);
});

test("(2) sahte sender: kayıt sent + sent_at dolu; subject/html'de token'lı teklif linki", async () => {
  const startsAt = new Date(Date.now() + 3 * 24 * 3_600_000);
  const id = await enqueue({
    recipient: "offer@example.com",
    template: "teacher_offer",
    payload: {
      token: "offer-tok-123",
      slotStartsAt: startsAt.toISOString(),
      durationMin: 60,
      teacherTimezone: "Europe/Istanbul",
      poolName: "Native ESL",
      schoolName: "Test Okul",
    },
  });

  const sentMessages: EmailMessage[] = [];
  const result = await sendPendingNotifications(tdb.pool, {
    sender: async (msg) => {
      sentMessages.push(msg);
    },
  });
  expect(result).toEqual({ sent: 1, failed: 0, expired: 0, skipped: 0 });

  expect(sentMessages).toHaveLength(1);
  const msg = sentMessages[0]!;
  expect(msg.to).toBe("offer@example.com");
  expect(msg.subject).toContain("Yeni ders teklifi");
  expect(msg.html).toContain("https://app.test/egitmen/teklif/offer-tok-123");
  expect(msg.html).toContain("60 dk");

  const state = await stateOf(id);
  expect(state.status).toBe("sent");
  expect(state.sent_at).not.toBeNull();
  expect(state.attempt).toBe(0);
});

test("(3) 8 günlük pending gönderilmez → expired (sender hiç çağrılmaz)", async () => {
  const id = await enqueue({
    recipient: "stale@example.com",
    template: "school_low_balance",
    payload: { schoolName: "Eski Okul", balanceCents: 100, committed7dCents: 4000 },
    ageDays: 8,
  });

  const sentMessages: EmailMessage[] = [];
  const result = await sendPendingNotifications(tdb.pool, {
    sender: async (msg) => {
      sentMessages.push(msg);
    },
  });
  expect(result).toEqual({ sent: 0, failed: 0, expired: 1, skipped: 0 });
  expect(sentMessages).toHaveLength(0);

  const state = await stateOf(id);
  expect(state.status).toBe("expired");
  expect(state.sent_at).toBeNull();
});

test("(4) sender hatası: attempt artar + last_error dolar; 5. denemede failed", async () => {
  const id = await enqueue({
    recipient: "fail@example.com",
    template: "teacher_invite",
    payload: { token: "invite-tok", fullName: "Fail Teacher" },
  });
  const failingSender = async (_msg: EmailMessage): Promise<void> => {
    throw new Error("smtp bozuk");
  };

  const first = await sendPendingNotifications(tdb.pool, { sender: failingSender });
  expect(first).toEqual({ sent: 0, failed: 0, expired: 0, skipped: 0 });
  let state = await stateOf(id);
  expect(state.status).toBe("pending");
  expect(state.attempt).toBe(1);
  expect(state.last_error).toContain("smtp bozuk");

  for (let i = 0; i < 3; i += 1) {
    await sendPendingNotifications(tdb.pool, { sender: failingSender });
  }
  state = await stateOf(id);
  expect(state.status).toBe("pending");
  expect(state.attempt).toBe(4);

  const fifth = await sendPendingNotifications(tdb.pool, { sender: failingSender });
  expect(fifth).toEqual({ sent: 0, failed: 1, expired: 0, skipped: 0 });
  state = await stateOf(id);
  expect(state.status).toBe("failed");
  expect(state.attempt).toBe(5);

  // failed kayıt sonraki koşularda tekrar denenmez
  const after = await sendPendingNotifications(tdb.pool, { sender: failingSender });
  expect(after).toEqual({ sent: 0, failed: 0, expired: 0, skipped: 0 });
  expect((await stateOf(id)).attempt).toBe(5);
});
