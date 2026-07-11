// Eğitmen panel token'ı: üret → çöz → revoke → artık çözülmez. DB'de yalnız SHA-256 hash durur.
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { createPortalToken, getTeacherByPortalToken, revokePortalTokens } from "../src/index.js";
import { seedTeacher } from "./helpers.js";

let tdb: TestDb;
let teacherId: string;

beforeAll(async () => {
  tdb = await createTestDb();
  teacherId = await seedTeacher(tdb.pool, "portal.teacher@example.com");
});

afterAll(async () => {
  await tdb.drop();
});

test("token üret → eğitmeni çöz; ham token DB'ye yazılmaz", async () => {
  const { token } = await tdb.pool.withPlatform((db) => createPortalToken(db, { teacherId }));
  expect(token).toMatch(/^[0-9a-f]{64}$/); // randomBytes(32) hex

  const teacher = await tdb.pool.withPlatform((db) => getTeacherByPortalToken(db, token));
  expect(teacher).toEqual({
    teacherId,
    fullName: "Session Teacher",
    timezone: "Europe/Istanbul",
  });

  // DB'de ham token değil hash'i durur
  const stored = await tdb.pool.withPlatform((db) =>
    db.query<{ token_hash: string }>(
      "SELECT token_hash FROM teacher_portal_token WHERE teacher_id = $1",
      [teacherId],
    ),
  );
  expect(stored.rows[0]?.token_hash).not.toBe(token);

  // bilinmeyen token → null
  expect(
    await tdb.pool.withPlatform((db) => getTeacherByPortalToken(db, "0".repeat(64))),
  ).toBeNull();
});

test("revoke: eğitmenin tüm canlı token'ları düşer", async () => {
  const first = await tdb.pool.withPlatform((db) => createPortalToken(db, { teacherId }));
  const second = await tdb.pool.withPlatform((db) => createPortalToken(db, { teacherId }));

  // önceki testten kalan + bu ikisi = en az 3 canlı token
  const revoked = await tdb.pool.withPlatform((db) => revokePortalTokens(db, teacherId));
  expect(revoked).toBeGreaterThanOrEqual(3);

  expect(await tdb.pool.withPlatform((db) => getTeacherByPortalToken(db, first.token))).toBeNull();
  expect(
    await tdb.pool.withPlatform((db) => getTeacherByPortalToken(db, second.token)),
  ).toBeNull();

  // ikinci revoke no-op
  expect(await tdb.pool.withPlatform((db) => revokePortalTokens(db, teacherId))).toBe(0);
});
