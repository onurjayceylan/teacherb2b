// API davranış testleri: upsert idempotency ve disableUser hata yolu.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { createOrganization, createSchool, disableUser, upsertUserWithMembership } from "../src/index.js";

let testDb: TestDb;
let schoolId: string;
let otherSchoolId: string;

beforeAll(async () => {
  testDb = await createTestDb();
  await testDb.pool.withPlatform(async (db) => {
    const orgId = await createOrganization(db, { name: "Api Org", kind: "distributor" });
    schoolId = await createSchool(db, {
      organizationId: orgId,
      name: "Api School",
      country: "US",
      timezone: "America/New_York",
    });
    otherSchoolId = await createSchool(db, { organizationId: orgId, name: "Api School 2" });
  });
});

afterAll(async () => {
  await testDb.drop();
});

describe("tenancy API", () => {
  it("createSchool country/timezone verilmezse varsayılanları kullanır", async () => {
    await testDb.pool.withPlatform(async (db) => {
      const res = await db.query<{ country: string; timezone: string; kind: string }>(
        `SELECT s.country, s.timezone, o.kind FROM school s
         JOIN organization o ON o.id = s.organization_id WHERE s.id = $1`,
        [otherSchoolId],
      );
      expect(res.rows[0]).toEqual({ country: "TR", timezone: "Europe/Istanbul", kind: "distributor" });
    });
  });

  it("upsertUserWithMembership aynı email için aynı user ve membership'i döndürür", async () => {
    await testDb.pool.withPlatform(async (db) => {
      const first = await upsertUserWithMembership(db, {
        schoolId,
        email: "teacher@example.com",
        name: "İlk Ad",
        role: "coordinator",
      });
      const second = await upsertUserWithMembership(db, {
        schoolId,
        email: "TEACHER@example.com", // citext: büyük/küçük harf aynı kullanıcı
        name: "Başka Ad",
        role: "finance",
      });
      expect(second.userId).toBe(first.userId);
      expect(second.schoolUserId).toBe(first.schoolUserId);

      // Mevcut kullanıcı ezilmedi: ad ve rol ilk hali korur (DO NOTHING).
      const user = await db.query<{ name: string | null }>(
        "SELECT name FROM app_user WHERE id = $1",
        [first.userId],
      );
      expect(user.rows[0]?.name).toBe("İlk Ad");
      const membership = await db.query<{ role: string }>(
        "SELECT role FROM school_user WHERE id = $1",
        [first.schoolUserId],
      );
      expect(membership.rows[0]?.role).toBe("coordinator");

      // Aynı kullanıcı ikinci okula da üye olabilir → farklı school_user satırı.
      const third = await upsertUserWithMembership(db, {
        schoolId: otherSchoolId,
        email: "teacher@example.com",
        role: "admin",
      });
      expect(third.userId).toBe(first.userId);
      expect(third.schoolUserId).not.toBe(first.schoolUserId);
    });
  });

  it("disableUser olmayan kullanıcı için anlamlı hata fırlatır", async () => {
    await expect(
      testDb.pool.withPlatform((db) =>
        disableUser(db, { userId: "00000000-0000-0000-0000-000000000000" }),
      ),
    ).rejects.toThrow(/kullanıcı bulunamadı/);
  });
});
