import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import { runHrReminders } from "../src/hr-reminders.js";

let tdb: TestDb;
let teacherId: string;

const DOC_KINDS = [
  "contract",
  "id_verification",
  "country_clearance",
  "tax_form",
  "payout_method",
];

/** Eğitmen + 5 'missing' evrak açar (worker @teachernow/hr'a bağımlı değil — ham SQL). */
async function seedTeacher(email: string): Promise<string> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO teacher (full_name, email, source) VALUES ($1, $2, 'site') RETURNING id`,
      ["Reminder Teacher", email],
    );
    const id = res.rows[0]!.id;
    await db.query(
      `INSERT INTO teacher_document (teacher_id, kind)
       SELECT $1, kind FROM unnest($2::text[]) AS k(kind)`,
      [id, DOC_KINDS],
    );
    return id;
  });
}

/** Evrak yaşını geriye çeker: 3+ gündür eksik senaryosu (yalnız test altyapısı — withOwner). */
async function ageDocuments(id: string): Promise<void> {
  await tdb.pool.withOwner((db) =>
    db.query(
      `UPDATE teacher_document
          SET created_at = now() - interval '4 days',
              updated_at = now() - interval '4 days'
        WHERE teacher_id = $1`,
      [id],
    ),
  );
}

beforeAll(async () => {
  tdb = await createTestDb();
  teacherId = await seedTeacher("reminder.teacher@example.com");
  await ageDocuments(teacherId);
});

afterAll(async () => {
  await tdb.drop();
});

test("4 gündür eksik evrak → reminded 1 + audit satırı (eksik kind listesiyle)", async () => {
  const result = await runHrReminders(tdb.pool);
  expect(result).toEqual({ reminded: 1 });

  const audit = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ actor_kind: string; after: { missing_kinds: string[] } }>(
      `SELECT actor_kind, after FROM audit_log
        WHERE action = 'hr_reminder_due' AND entity_type = 'teacher' AND entity_id = $1`,
      [teacherId],
    );
    return res.rows;
  });
  expect(audit).toHaveLength(1);
  expect(audit[0]!.actor_kind).toBe("agent");
  expect(audit[0]!.after.missing_kinds.sort()).toEqual([...DOC_KINDS].sort());
});

test("ikinci koşu → reminded 0 (aynı eğitmene 24 saat içinde tekrar yazılmaz)", async () => {
  const result = await runHrReminders(tdb.pool);
  expect(result).toEqual({ reminded: 0 });

  const count = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'hr_reminder_due' AND entity_id = $1`,
      [teacherId],
    );
    return res.rows[0]!.n;
  });
  expect(count).toBe("1"); // pg bigint → string
});

test("evrakları verified olan eğitmene hatırlatma yazılmaz → reminded 0", async () => {
  // Bağımsız eğitmen: 24s korumasından etkilenmesin diye ayrı kayıt
  const verifiedTeacherId = await seedTeacher("verified.teacher@example.com");
  await tdb.pool.withPlatform((db) =>
    db.query(`UPDATE teacher_document SET status = 'verified' WHERE teacher_id = $1`, [
      verifiedTeacherId,
    ]),
  );
  await ageDocuments(verifiedTeacherId);

  const result = await runHrReminders(tdb.pool);
  expect(result).toEqual({ reminded: 0 });

  const count = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'hr_reminder_due' AND entity_id = $1`,
      [verifiedTeacherId],
    );
    return res.rows[0]!.n;
  });
  expect(count).toBe("0");
});

test("rejected/suspended eğitmen taramaya girmez", async () => {
  const rejectedTeacherId = await seedTeacher("rejected.teacher@example.com");
  await ageDocuments(rejectedTeacherId);
  // invited→rejected trigger whitelist'inde geçerli bir geçiştir
  await tdb.pool.withPlatform((db) =>
    db.query(`UPDATE teacher SET status = 'rejected', updated_at = now() WHERE id = $1`, [
      rejectedTeacherId,
    ]),
  );

  const result = await runHrReminders(tdb.pool);
  expect(result).toEqual({ reminded: 0 });
});
