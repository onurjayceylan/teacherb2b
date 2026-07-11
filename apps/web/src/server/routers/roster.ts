// Roster (okul-scoped): sınıflar + isimli öğrenci listesi (çocuk-PII v3 — yalnız ad-soyad).
// Tüm erişim ctx.withSchoolDb üzerinden: RLS app.school_ids ile aktif okula sınırlar.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Db } from "@teachernow/db";
import { router, schoolProcedure } from "../trpc";

const classNameSchema = z.string().trim().min(1).max(120);

/** Aktif sınıfı ada göre bulur; yoksa yaratır (get-or-create). */
async function getOrCreateClassGroup(db: Db, schoolId: string, name: string): Promise<string> {
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM class_group WHERE school_id = $1 AND name = $2 AND active",
    [schoolId, name],
  );
  const found = existing.rows[0];
  if (found) return found.id;
  const created = await db.query<{ id: string }>(
    "INSERT INTO class_group (school_id, name) VALUES ($1, $2) RETURNING id",
    [schoolId, name],
  );
  const row = created.rows[0];
  if (!row) throw new Error("class_group: INSERT satır dönmedi");
  return row.id;
}

export const rosterRouter = router({
  listClassGroups: schoolProcedure.query(async ({ ctx }) => {
    return ctx.withSchoolDb(async (db) => {
      const res = await db.query<{ id: string; name: string; level: string | null }>(
        "SELECT id, name, level FROM class_group WHERE active ORDER BY name",
      );
      return res.rows;
    });
  }),

  createClassGroup: schoolProcedure
    .input(
      z.object({
        name: classNameSchema,
        level: z.string().trim().min(1).max(60).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.withSchoolDb(async (db) => {
        const res = await db.query<{ id: string }>(
          `INSERT INTO class_group (school_id, name, level)
           VALUES ($1, $2, $3)
           ON CONFLICT (school_id, name) WHERE active DO NOTHING
           RETURNING id`,
          [ctx.activeSchoolId, input.name, input.level ?? null],
        );
        const row = res.rows[0];
        if (!row) throw new Error(`"${input.name}" adlı aktif sınıf zaten var`);
        return { id: row.id };
      });
    }),

  // Toplu öğrenci import'u: className'e göre sınıf get-or-create + öğrenci ekleme.
  // Veri minimizasyonu: yalnız ad-soyad + sınıf adı alınır; başka alan KABUL EDİLMEZ.
  importStudents: schoolProcedure
    .input(
      z.object({
        rows: z
          .array(z.object({ fullName: z.string().trim().min(2).max(200), className: classNameSchema }))
          .min(1)
          .max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.withSchoolDb(async (db) => {
        const classIds = new Map<string, string>();
        for (const row of input.rows) {
          if (!classIds.has(row.className)) {
            classIds.set(row.className, await getOrCreateClassGroup(db, ctx.activeSchoolId, row.className));
          }
        }
        let created = 0;
        for (const row of input.rows) {
          await db.query(
            "INSERT INTO student (school_id, class_group_id, full_name) VALUES ($1, $2, $3)",
            [ctx.activeSchoolId, classIds.get(row.className), row.fullName],
          );
          created += 1;
        }
        return { created, classGroups: classIds.size };
      });
    }),

  // Sınıfa göre gruplu sayım + isim listesi (aktif öğrenciler).
  listStudents: schoolProcedure.query(async ({ ctx }) => {
    return ctx.withSchoolDb(async (db) => {
      const res = await db.query<{
        class_group_id: string;
        class_name: string;
        student_id: string | null;
        full_name: string | null;
      }>(
        `SELECT cg.id AS class_group_id, cg.name AS class_name, s.id AS student_id, s.full_name
           FROM class_group cg
           LEFT JOIN student s ON s.class_group_id = cg.id AND s.status = 'active'
          WHERE cg.active
          ORDER BY cg.name, s.full_name`,
      );
      const groups = new Map<
        string,
        { classGroupId: string; className: string; count: number; students: { id: string; fullName: string }[] }
      >();
      for (const row of res.rows) {
        let group = groups.get(row.class_group_id);
        if (!group) {
          group = { classGroupId: row.class_group_id, className: row.class_name, count: 0, students: [] };
          groups.set(row.class_group_id, group);
        }
        if (row.student_id && row.full_name) {
          group.count += 1;
          group.students.push({ id: row.student_id, fullName: row.full_name });
        }
      }
      return [...groups.values()];
    });
  }),

  // Devam raporu (denetim P1): öğrenci başına katıldı / toplam İŞARETLİ ders + oran.
  // "Tamamlanmış ders" = ended|settled oturum (ders gerçekleşti); yoklaması hiç
  // işaretlenmemiş dersler orana katılmaz — ayrı sayaçla ("yoklama girilmemiş N ders") döner.
  // Tüm okuma okul bağlamında: RLS okul-scoped, tam ad okulun KENDİ öğrencisidir.
  attendanceReport: schoolProcedure
    .input(z.object({ classGroupId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.withSchoolDb(async (db) => {
        const cg = await db.query<{ id: string }>(
          "SELECT id FROM class_group WHERE id = $1",
          [input.classGroupId],
        );
        if (!cg.rows[0]) {
          throw new TRPCError({ code: "NOT_FOUND", message: "sınıf bulunamadı" });
        }

        const sessions = await db.query<{ id: string; marked: boolean }>(
          `SELECT cs.id,
                  EXISTS (SELECT 1 FROM session_attendance a WHERE a.session_id = cs.id) AS marked
             FROM class_session cs
            WHERE cs.class_group_id = $1 AND cs.status IN ('ended', 'settled')`,
          [input.classGroupId],
        );
        const markedIds = sessions.rows.filter((r) => r.marked).map((r) => r.id);
        const unmarkedLessons = sessions.rows.length - markedIds.length;

        const students = await db.query<{ id: string; full_name: string }>(
          `SELECT id, full_name FROM student
            WHERE class_group_id = $1 AND status = 'active'
            ORDER BY full_name`,
          [input.classGroupId],
        );

        const attended = new Map<string, number>();
        if (markedIds.length > 0) {
          const att = await db.query<{ student_id: string; n: string }>(
            `SELECT student_id, count(*) AS n
               FROM session_attendance
              WHERE session_id = ANY($1::uuid[]) AND present
              GROUP BY student_id`,
            [markedIds],
          );
          for (const r of att.rows) attended.set(r.student_id, Number(r.n));
        }

        return {
          completedLessons: sessions.rows.length,
          markedLessons: markedIds.length,
          unmarkedLessons,
          students: students.rows.map((s) => {
            const n = attended.get(s.id) ?? 0;
            return {
              studentId: s.id,
              fullName: s.full_name,
              attended: n,
              // Oran yalnız işaretli dersler üzerinden; hiç işaretli ders yoksa null.
              rate: markedIds.length > 0 ? n / markedIds.length : null,
            };
          }),
        };
      });
    }),
});
