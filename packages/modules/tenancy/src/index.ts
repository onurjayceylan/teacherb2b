// @teachernow/tenancy — organizasyon/okul/üyelik yaşam döngüsü.
// Tüm fonksiyonlar platform bağlamında (ActorPool.withPlatform içindeki PoolClient) çağrılır.
import type { PoolClient } from "pg";

export type OrganizationKind = "school_owner" | "distributor";
export type SchoolUserRole = "owner" | "admin" | "finance" | "coordinator";

export interface CreateOrganizationParams {
  name: string;
  kind?: OrganizationKind;
}

export interface CreateSchoolParams {
  organizationId: string;
  name: string;
  country?: string;
  timezone?: string;
}

export interface UpsertUserWithMembershipParams {
  schoolId: string;
  email: string;
  name?: string;
  role: SchoolUserRole;
}

export interface UpsertUserWithMembershipResult {
  userId: string;
  schoolUserId: string;
}

export async function createOrganization(
  db: PoolClient,
  params: CreateOrganizationParams,
): Promise<string> {
  const res = await db.query<{ id: string }>(
    "INSERT INTO organization (name, kind) VALUES ($1, COALESCE($2, 'school_owner')) RETURNING id",
    [params.name, params.kind ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error("createOrganization: insert sonuç döndürmedi");
  return row.id;
}

export async function createSchool(db: PoolClient, params: CreateSchoolParams): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO school (organization_id, name, country, timezone)
     VALUES ($1, $2, COALESCE($3, 'TR'), COALESCE($4, 'Europe/Istanbul'))
     RETURNING id`,
    [params.organizationId, params.name, params.country ?? null, params.timezone ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new Error("createSchool: insert sonuç döndürmedi");
  return row.id;
}

export async function upsertUserWithMembership(
  db: PoolClient,
  params: UpsertUserWithMembershipParams,
): Promise<UpsertUserWithMembershipResult> {
  // Var olan kullanıcının adı/durumu ezilmez: DO NOTHING + mevcut satırı oku.
  const inserted = await db.query<{ id: string }>(
    "INSERT INTO app_user (email, name) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id",
    [params.email, params.name ?? null],
  );
  let userId = inserted.rows[0]?.id;
  if (!userId) {
    const existing = await db.query<{ id: string }>("SELECT id FROM app_user WHERE email = $1", [
      params.email,
    ]);
    userId = existing.rows[0]?.id;
    if (!userId) throw new Error("upsertUserWithMembership: kullanıcı ne eklendi ne bulundu");
  }

  const membership = await db.query<{ id: string }>(
    `INSERT INTO school_user (school_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (school_id, user_id) DO NOTHING RETURNING id`,
    [params.schoolId, userId, params.role],
  );
  let schoolUserId = membership.rows[0]?.id;
  if (!schoolUserId) {
    const existing = await db.query<{ id: string }>(
      "SELECT id FROM school_user WHERE school_id = $1 AND user_id = $2",
      [params.schoolId, userId],
    );
    schoolUserId = existing.rows[0]?.id;
    if (!schoolUserId) throw new Error("upsertUserWithMembership: üyelik ne eklendi ne bulundu");
  }

  return { userId, schoolUserId };
}

export async function disableUser(db: PoolClient, params: { userId: string }): Promise<void> {
  // token_version artışı = mevcut tüm JWT'ler fail-closed düşer (tazeleme reddedilir).
  const res = await db.query(
    `UPDATE app_user
     SET status = 'disabled', disabled_at = now(), token_version = token_version + 1, updated_at = now()
     WHERE id = $1`,
    [params.userId],
  );
  if (res.rowCount !== 1) throw new Error(`disableUser: kullanıcı bulunamadı: ${params.userId}`);
}
