import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import {
  createInviteToken,
  getTeacherByInviteToken,
  inviteTeacher,
  revokeInviteTokens,
  DOCUMENT_KINDS,
} from "../src/index.js";

let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
});

afterAll(async () => {
  await tdb.drop();
});

async function newTeacher(email: string, fullName = "Invite Teacher"): Promise<string> {
  return tdb.pool.withPlatform((db) =>
    inviteTeacher(db, { fullName, email, phone: "+90 555 111 2233", country: "TR", source: "site" }),
  );
}

async function readFirstUsedAt(teacherId: string): Promise<string | null> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ first_used_at: string | null }>(
      "SELECT first_used_at::text AS first_used_at FROM teacher_invite WHERE teacher_id = $1",
      [teacherId],
    );
    return res.rows[0]!.first_used_at;
  });
}

describe("davet token'ları", () => {
  it("üret→bul: eğitmen özeti + 5 evrak döner; DB'de ham token değil hash durur", async () => {
    const teacherId = await newTeacher("invite.happy@example.com", "Ayla Aydin");
    const { token } = await tdb.pool.withPlatform((db) =>
      createInviteToken(db, { teacherId }),
    );
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const found = await tdb.pool.withPlatform((db) => getTeacherByInviteToken(db, token));
    expect(found).not.toBeNull();
    expect(found!).toMatchObject({
      teacherId,
      fullName: "Ayla Aydin",
      status: "invited",
      country: "TR",
      timezone: "Europe/Istanbul",
      phone: "+90 555 111 2233",
    });
    expect(found!.documents).toHaveLength(5);
    expect(found!.documents.map((d) => d.kind).sort()).toEqual([...DOCUMENT_KINDS].sort());
    expect(found!.documents.every((d) => d.status === "missing")).toBe(true);

    // Ham token DB'ye yazılmaz — yalnız SHA-256 hex hash'i durur
    const stored = await tdb.pool.withPlatform(async (db) => {
      const res = await db.query<{ token_hash: string }>(
        "SELECT token_hash FROM teacher_invite WHERE teacher_id = $1",
        [teacherId],
      );
      return res.rows[0]!.token_hash;
    });
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(token);
  });

  it("yanlış token null döner", async () => {
    const found = await tdb.pool.withPlatform((db) =>
      getTeacherByInviteToken(db, "0".repeat(64)),
    );
    expect(found).toBeNull();
  });

  it("süresi geçmiş token null döner", async () => {
    const teacherId = await newTeacher("invite.expired@example.com");
    const { token } = await tdb.pool.withPlatform((db) => createInviteToken(db, { teacherId }));

    await tdb.pool.withOwner((db) =>
      db.query(
        "UPDATE teacher_invite SET expires_at = now() - interval '1 minute' WHERE teacher_id = $1",
        [teacherId],
      ),
    );

    const found = await tdb.pool.withPlatform((db) => getTeacherByInviteToken(db, token));
    expect(found).toBeNull();
  });

  it("revoke sonrası tüm token'lar null döner; sayı doğru", async () => {
    const teacherId = await newTeacher("invite.revoked@example.com");
    const t1 = await tdb.pool.withPlatform((db) => createInviteToken(db, { teacherId }));
    const t2 = await tdb.pool.withPlatform((db) => createInviteToken(db, { teacherId }));
    // Yeni token üretmek eskisini revoke etmez — ikisi de geçerli
    expect(
      await tdb.pool.withPlatform((db) => getTeacherByInviteToken(db, t1.token)),
    ).not.toBeNull();
    expect(
      await tdb.pool.withPlatform((db) => getTeacherByInviteToken(db, t2.token)),
    ).not.toBeNull();

    const revoked = await tdb.pool.withPlatform((db) => revokeInviteTokens(db, teacherId));
    expect(revoked).toBe(2);

    expect(await tdb.pool.withPlatform((db) => getTeacherByInviteToken(db, t1.token))).toBeNull();
    expect(await tdb.pool.withPlatform((db) => getTeacherByInviteToken(db, t2.token))).toBeNull();

    // İkinci revoke: iptal edilecek açık token kalmadı
    expect(await tdb.pool.withPlatform((db) => revokeInviteTokens(db, teacherId))).toBe(0);
  });

  it("first_used_at yalnız ilk kullanımda damgalanır", async () => {
    const teacherId = await newTeacher("invite.firstuse@example.com");
    const { token } = await tdb.pool.withPlatform((db) => createInviteToken(db, { teacherId }));

    expect(await readFirstUsedAt(teacherId)).toBeNull();

    await tdb.pool.withPlatform((db) => getTeacherByInviteToken(db, token));
    const stamped = await readFirstUsedAt(teacherId);
    expect(stamped).not.toBeNull();

    // İkinci kullanım damgayı DEĞİŞTİRMEZ
    await tdb.pool.withPlatform((db) => getTeacherByInviteToken(db, token));
    expect(await readFirstUsedAt(teacherId)).toBe(stamped);
  });
});
