// Self-servis panel linki (requestPortalLink): outbox + token hash'i, varlık
// sızdırmama (bilinmeyen e-posta da ok:true) ve 15 dakikalık rate-limit.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { inviteTeacher, requestPortalLink } from "../src/index.js";

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

function sha256Hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function seedTeacher(email: string, fullName = "Portal Teacher"): Promise<string> {
  return tdb.pool.withPlatform((db) => inviteTeacher(db, { fullName, email, source: "site" }));
}

async function outboxRows(
  recipient: string,
): Promise<{ status: string; payload: Record<string, unknown> }[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ status: string; payload: Record<string, unknown> }>(
      `SELECT status, payload FROM notification_outbox
        WHERE template = 'teacher_portal' AND recipient_email = $1
        ORDER BY created_at`,
      [recipient],
    );
    return res.rows;
  });
}

async function tokenHashes(teacherId: string): Promise<string[]> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ token_hash: string }>(
      `SELECT token_hash FROM teacher_portal_token WHERE teacher_id = $1 ORDER BY created_at, id`,
      [teacherId],
    );
    return res.rows.map((r) => r.token_hash);
  });
}

describe("requestPortalLink", () => {
  it("kayıtlı eğitmen: outbox kaydı düşer, DB'de ham token değil SHA-256 hash'i durur", async () => {
    const teacherId = await seedTeacher("portal.t@example.com", "Ayla Panel");

    // citext eşleşmesi: farklı harf düzeniyle istek de aynı eğitmeni bulur
    const result = await requestPortalLink(tdb.pool, "Portal.T@Example.COM");
    expect(result).toEqual({ ok: true });

    const rows = await outboxRows("portal.t@example.com");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    const token = String(rows[0]!.payload["token"]);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.payload["fullName"]).toBe("Ayla Panel");

    // Ham token DB'ye yazılmaz — yalnız SHA-256 hex hash'i durur
    const hashes = await tokenHashes(teacherId);
    expect(hashes).toEqual([sha256Hex(token)]);
    expect(hashes[0]).not.toBe(token);
  });

  it("bilinmeyen e-posta: yine ok:true döner, hiçbir şey yazılmaz (varlık sızdırma yok)", async () => {
    expect(await requestPortalLink(tdb.pool, "ghost@example.com")).toEqual({ ok: true });
    expect(await outboxRows("ghost@example.com")).toEqual([]);
  });

  it("rate-limit: 15 dk içinde ikinci istek yeni kayıt yazmaz; pencere geçince yazar", async () => {
    const teacherId = await seedTeacher("portal.rl@example.com");

    expect(await requestPortalLink(tdb.pool, "portal.rl@example.com")).toEqual({ ok: true });
    // İkinci istek pencere içinde: yine ok:true ama outbox'a da token tablosuna da yazmaz
    expect(await requestPortalLink(tdb.pool, "portal.rl@example.com")).toEqual({ ok: true });
    expect(await outboxRows("portal.rl@example.com")).toHaveLength(1);
    expect(await tokenHashes(teacherId)).toHaveLength(1);

    // Son kaydı 16 dk geriye çek → pencere kapandı, yeni istek yazar
    await tdb.pool.withOwner((db) =>
      db.query(
        `UPDATE notification_outbox SET created_at = now() - interval '16 minutes'
          WHERE template = 'teacher_portal' AND recipient_email = $1`,
        ["portal.rl@example.com"],
      ),
    );
    expect(await requestPortalLink(tdb.pool, "portal.rl@example.com")).toEqual({ ok: true });
    expect(await outboxRows("portal.rl@example.com")).toHaveLength(2);
    expect(await tokenHashes(teacherId)).toHaveLength(2);
  });
});
