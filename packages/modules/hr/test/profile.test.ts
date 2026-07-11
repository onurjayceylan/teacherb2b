// Eğitmen profil doğrulamaları: payout_details yazımı + şema redleri, timezoneSchema,
// inviteTeacher'ın timezone kapısı ve scheduleInterview'un outbox bildirimi.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import {
  inviteTeacher,
  payoutDetailsSchema,
  scheduleInterview,
  setPayoutDetails,
  timezoneSchema,
} from "../src/index.js";

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

async function seedTeacher(email: string): Promise<string> {
  return tdb.pool.withPlatform((db) =>
    inviteTeacher(db, { fullName: "Profile Teacher", email, source: "site" }),
  );
}

async function readPayoutDetails(teacherId: string): Promise<unknown> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ payout_details: unknown }>(
      "SELECT payout_details FROM teacher WHERE id = $1",
      [teacherId],
    );
    return res.rows[0]!.payout_details;
  });
}

describe("payoutDetailsSchema", () => {
  it("wise_email: geçerli e-posta kabul, değerler trim'lenir", () => {
    const parsed = payoutDetailsSchema.parse({
      method: "wise_email",
      value: "  teacher@wise.example.com  ",
      accountHolder: "  Jane Doe  ",
    });
    expect(parsed).toEqual({
      method: "wise_email",
      value: "teacher@wise.example.com",
      accountHolder: "Jane Doe",
    });
  });

  it("iban: e-posta formatı aranmaz", () => {
    const parsed = payoutDetailsSchema.parse({
      method: "iban",
      value: "TR330006100519786457841326",
      accountHolder: "Jane Doe",
    });
    expect(parsed.method).toBe("iban");
  });

  it("wise_email + e-posta olmayan value reddedilir", () => {
    const res = payoutDetailsSchema.safeParse({
      method: "wise_email",
      value: "bu-eposta-degil",
      accountHolder: "Jane Doe",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]!.message).toMatch(/invalid email/i);
    }
  });

  it("kısa value (<5) ve kısa accountHolder (<2) reddedilir; bilinmeyen method reddedilir", () => {
    expect(
      payoutDetailsSchema.safeParse({ method: "iban", value: "TR1", accountHolder: "Jane" })
        .success,
    ).toBe(false);
    expect(
      payoutDetailsSchema.safeParse({
        method: "wise_email",
        value: "a@b.com.tr",
        accountHolder: "J",
      }).success,
    ).toBe(false);
    expect(
      payoutDetailsSchema.safeParse({
        method: "paypal",
        value: "a@b.com.tr",
        accountHolder: "Jane",
      }).success,
    ).toBe(false);
  });
});

describe("setPayoutDetails", () => {
  it("teacher.payout_details jsonb'ye yazar (trim uygulanmış hâliyle)", async () => {
    const teacherId = await seedTeacher("payout.details@example.com");
    await tdb.pool.withPlatform((db) =>
      setPayoutDetails(db, teacherId, {
        method: "wise_email",
        value: " pd.teacher@wise.example.com ",
        accountHolder: " Payout Teacher ",
      }),
    );
    expect(await readPayoutDetails(teacherId)).toEqual({
      method: "wise_email",
      value: "pd.teacher@wise.example.com",
      accountHolder: "Payout Teacher",
    });

    // Üzerine yazma: iban'a geçiş
    await tdb.pool.withPlatform((db) =>
      setPayoutDetails(db, teacherId, {
        method: "iban",
        value: "TR330006100519786457841326",
        accountHolder: "Payout Teacher",
      }),
    );
    expect(await readPayoutDetails(teacherId)).toMatchObject({ method: "iban" });
  });

  it("olmayan teacher için anlamlı hata", async () => {
    await expect(
      tdb.pool.withPlatform((db) =>
        setPayoutDetails(db, randomUUID(), {
          method: "iban",
          value: "TR330006100519786457841326",
          accountHolder: "Ghost Teacher",
        }),
      ),
    ).rejects.toThrow(/teacher bulunamadı/);
  });

  it("geçersiz detay şema hatasıyla içeri giremez (DB'ye yazılmaz)", async () => {
    const teacherId = await seedTeacher("payout.invalid@example.com");
    await expect(
      tdb.pool.withPlatform((db) =>
        setPayoutDetails(db, teacherId, {
          method: "wise_email",
          value: "eposta-degil",
          accountHolder: "X Y",
        }),
      ),
    ).rejects.toThrow();
    expect(await readPayoutDetails(teacherId)).toBeNull();
  });
});

describe("timezoneSchema", () => {
  it("geçerli IANA zone'ları kabul eder", () => {
    expect(timezoneSchema.safeParse("Europe/Istanbul").success).toBe(true);
    expect(timezoneSchema.safeParse("UTC").success).toBe(true);
    expect(timezoneSchema.safeParse("America/New_York").success).toBe(true);
  });

  it("geçersiz zone'u İngilizce mesajla reddeder", () => {
    for (const bad of ["Mars/Olympus", "not-a-tz", ""]) {
      const res = timezoneSchema.safeParse(bad);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.issues[0]!.message).toBe(
          "invalid IANA timezone (e.g. Europe/Istanbul)",
        );
      }
    }
  });

  it("inviteTeacher geçersiz timezone'u reddeder, geçerliyi yazar", async () => {
    await expect(
      tdb.pool.withPlatform((db) =>
        inviteTeacher(db, {
          fullName: "Bad TZ",
          email: "bad.tz@example.com",
          timezone: "Mars/Olympus",
          source: "site",
        }),
      ),
    ).rejects.toThrow(/invalid IANA timezone/);

    const teacherId = await tdb.pool.withPlatform((db) =>
      inviteTeacher(db, {
        fullName: "Good TZ",
        email: "good.tz@example.com",
        timezone: "America/Sao_Paulo",
        source: "site",
      }),
    );
    const tz = await tdb.pool.withPlatform(async (db) => {
      const res = await db.query<{ timezone: string }>(
        "SELECT timezone FROM teacher WHERE id = $1",
        [teacherId],
      );
      return res.rows[0]!.timezone;
    });
    expect(tz).toBe("America/Sao_Paulo");
  });
});

describe("scheduleInterview bildirimi", () => {
  it("görüşme kaydıyla AYNI transaction'da eğitmene teacher_interview_scheduled düşer", async () => {
    const teacherId = await seedTeacher("interview.notify@example.com");
    await tdb.pool.withPlatform((db) =>
      scheduleInterview(db, {
        teacherId,
        scheduledAt: "2026-08-01T09:00:00Z",
        meetingUrl: "https://meet.example.com/abc",
      }),
    );

    const rows = await tdb.pool.withPlatform(async (db) => {
      const res = await db.query<{
        recipient_email: string;
        status: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT recipient_email, status, payload
           FROM notification_outbox
          WHERE template = 'teacher_interview_scheduled'
          ORDER BY created_at`,
      );
      return res.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient_email).toBe("interview.notify@example.com");
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.payload["scheduledAt"]).toBe("2026-08-01T09:00:00Z");
    expect(rows[0]!.payload["meetingUrl"]).toBe("https://meet.example.com/abc");
    // inviteTeacher varsayılanı: eğitmenin timezone'u payload'a taşınır (şablon biçimler)
    expect(rows[0]!.payload["teacherTimezone"]).toBe("Europe/Istanbul");
  });

  it("meetingUrl verilmezse payload'da yer almaz; olmayan teacher anlamlı hata", async () => {
    const teacherId = await seedTeacher("interview.nourl@example.com");
    await tdb.pool.withPlatform((db) =>
      scheduleInterview(db, { teacherId, scheduledAt: "2026-08-02T10:00:00Z" }),
    );
    const payload = await tdb.pool.withPlatform(async (db) => {
      const res = await db.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM notification_outbox
          WHERE template = 'teacher_interview_scheduled' AND recipient_email = $1`,
        ["interview.nourl@example.com"],
      );
      return res.rows[0]!.payload;
    });
    expect(payload["meetingUrl"]).toBeUndefined();

    await expect(
      tdb.pool.withPlatform((db) =>
        scheduleInterview(db, { teacherId: randomUUID(), scheduledAt: "2026-08-02T10:00:00Z" }),
      ),
    ).rejects.toThrow(/teacher bulunamadı/);
  });
});
