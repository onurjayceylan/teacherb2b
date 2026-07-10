// Ortak test tohumu: org + school + temel hesaplar (platform bağlamında çağır).
import type { Db } from "@teachernow/db";
import { ensureAccount } from "../src/index.js";

export async function seedSchool(db: Db): Promise<string> {
  const org = await db.query<{ id: string }>(
    "INSERT INTO organization (name) VALUES ('Test Org') RETURNING id",
  );
  const orgId = org.rows[0]?.id;
  if (!orgId) throw new Error("seedSchool: organization insert başarısız");
  const school = await db.query<{ id: string }>(
    "INSERT INTO school (organization_id, name) VALUES ($1, 'Test School') RETURNING id",
    [orgId],
  );
  const schoolId = school.rows[0]?.id;
  if (!schoolId) throw new Error("seedSchool: school insert başarısız");
  return schoolId;
}

export async function seedCashAndClearing(
  db: Db,
  schoolId: string,
): Promise<{ cash: string; clearing: string }> {
  const cash = await ensureAccount(db, { ownerType: "school", ownerId: schoolId, kind: "school_cash" });
  const clearing = await ensureAccount(db, { ownerType: "platform", ownerId: null, kind: "stripe_clearing" });
  return { cash, clearing };
}
