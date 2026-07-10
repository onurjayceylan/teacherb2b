import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@teachernow/db";
import {
  advanceStatus,
  completeInterview,
  importTeachers,
  inviteTeacher,
  listPipeline,
  missingDocuments,
  scheduleInterview,
  upsertDocument,
  DOCUMENT_KINDS,
} from "../src/index.js";

let tdb: TestDb;
let nativeEslPoolId: string;

beforeAll(async () => {
  tdb = await createTestDb();
  nativeEslPoolId = await tdb.pool.withPlatform(async (db) => {
    const res = await db.query<{ id: string }>("SELECT id FROM pool WHERE key = 'native_esl'");
    return res.rows[0]!.id;
  });
});

afterAll(async () => {
  await tdb.drop();
});

interface TeacherRow {
  status: string;
  dispatch_ready: boolean;
  payout_ready: boolean;
  source: string;
}

async function readTeacher(teacherId: string): Promise<TeacherRow> {
  return tdb.pool.withPlatform(async (db) => {
    const res = await db.query<TeacherRow>(
      "SELECT status, dispatch_ready, payout_ready, source FROM teacher WHERE id = $1",
      [teacherId],
    );
    return res.rows[0]!;
  });
}

describe("site kanalı tam pipeline", () => {
  it("invite→profile→docs_pending→interview→accept: active + havuz üyeliği, payout kapalı", async () => {
    const teacherId = await tdb.pool.withPlatform((db) =>
      inviteTeacher(db, {
        fullName: "Ayse Yilmaz",
        email: "ayse.pipeline@example.com",
        phone: "+90 555 000 0001",
        country: "TR",
        source: "site",
      }),
    );

    // Davetle birlikte 5 evrak 'missing' açılmış olmalı
    const docs = await tdb.pool.withPlatform((db) => missingDocuments(db, teacherId));
    expect(docs).toHaveLength(5);
    expect(docs.map((d) => d.kind).sort()).toEqual([...DOCUMENT_KINDS].sort());
    expect(docs.every((d) => d.status === "missing")).toBe(true);

    await tdb.pool.withPlatform(async (db) => {
      await advanceStatus(db, { teacherId, to: "profile" });
      await advanceStatus(db, { teacherId, to: "docs_pending" });
      await advanceStatus(db, { teacherId, to: "interview" });
    });

    const interviewId = await tdb.pool.withPlatform((db) =>
      scheduleInterview(db, { teacherId, scheduledAt: "2026-07-15T10:00:00Z" }),
    );
    await tdb.pool.withPlatform((db) =>
      completeInterview(db, {
        interviewId,
        experienceScore: 5,
        energyScore: 4,
        decision: "accept",
        decidedPoolId: nativeEslPoolId,
        notes: "Enerjik, native — motor havuza uygun",
      }),
    );

    const teacher = await readTeacher(teacherId);
    expect(teacher.status).toBe("active");
    // Evrak seti hâlâ 'missing' → payout hard-gate kapalı kalmalı
    expect(teacher.payout_ready).toBe(false);

    await tdb.pool.withPlatform(async (db) => {
      const iv = await db.query<{ status: string; decision: string }>(
        "SELECT status, decision FROM hr_interview WHERE id = $1",
        [interviewId],
      );
      expect(iv.rows[0]).toEqual({ status: "done", decision: "accept" });

      const membership = await db.query<{ active: boolean }>(
        "SELECT active FROM teacher_pool WHERE teacher_id = $1 AND pool_id = $2",
        [teacherId, nativeEslPoolId],
      );
      expect(membership.rows).toHaveLength(1);
      expect(membership.rows[0]!.active).toBe(true);
    });

    const pipeline = await tdb.pool.withPlatform((db) => listPipeline(db, { status: "active" }));
    expect(pipeline.some((t) => t.id === teacherId)).toBe(true);
  });
});

describe("toplu import (hrmasterz)", () => {
  it("2 satır + 1 mükerrer email → created 2 skipped 1; active + dispatch açık, payout kapalı", async () => {
    const result = await tdb.pool.withPlatform((db) =>
      importTeachers(db, [
        { fullName: "John Carter", email: "john.import@example.com", country: "US" },
        { fullName: "Emma Stone", email: "emma.import@example.com", country: "GB" },
        // citext: aynı email'in farklı büyük/küçük hâli de mükerrer sayılır
        { fullName: "John Duplicate", email: "JOHN.IMPORT@example.com" },
      ]),
    );
    expect(result).toEqual({ created: 2, skipped: 1 });

    await tdb.pool.withPlatform(async (db) => {
      const rows = await db.query<{
        id: string;
        status: string;
        source: string;
        dispatch_ready: boolean;
        payout_ready: boolean;
      }>(
        `SELECT id, status, source, dispatch_ready, payout_ready
           FROM teacher WHERE email IN ('john.import@example.com', 'emma.import@example.com')`,
      );
      expect(rows.rows).toHaveLength(2);
      for (const t of rows.rows) {
        expect(t.status).toBe("active");
        expect(t.source).toBe("hrmasterz");
        expect(t.dispatch_ready).toBe(true);
        // Hard-gate: evrak seti verilmeden payout açılamaz
        expect(t.payout_ready).toBe(false);

        const docs = await missingDocuments(db, t.id);
        expect(docs).toHaveLength(5);
        expect(docs.every((d) => d.status === "missing")).toBe(true);
      }
    });
  });
});

describe("evrak seti ve payout hard-gate", () => {
  it("5 evrak verified → payout_ready true; biri expired → false ve kuyrukta görünür", async () => {
    const teacherId = await tdb.pool.withPlatform(async (db) => {
      await importTeachers(db, [
        { fullName: "Docs Teacher", email: "docs.teacher@example.com" },
      ]);
      const res = await db.query<{ id: string }>(
        "SELECT id FROM teacher WHERE email = 'docs.teacher@example.com'",
      );
      return res.rows[0]!.id;
    });

    await tdb.pool.withPlatform(async (db) => {
      for (const kind of DOCUMENT_KINDS) {
        await upsertDocument(db, {
          teacherId,
          kind,
          status: "verified",
          vendor: kind === "id_verification" ? "persona" : "manual",
          vendorRef: `ref-${kind}`,
        });
      }
    });
    expect((await readTeacher(teacherId)).payout_ready).toBe(true);
    expect(await tdb.pool.withPlatform((db) => missingDocuments(db, teacherId))).toEqual([]);

    // Tek evrak düşünce kapı kapanır ve exceptions kuyruğuna girer
    await tdb.pool.withPlatform((db) =>
      upsertDocument(db, {
        teacherId,
        kind: "country_clearance",
        status: "expired",
        note: "Süresi doldu — yenilenmeli",
      }),
    );
    expect((await readTeacher(teacherId)).payout_ready).toBe(false);

    const queue = await tdb.pool.withPlatform((db) => missingDocuments(db, teacherId));
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      teacherId,
      fullName: "Docs Teacher",
      kind: "country_clearance",
      status: "expired",
    });
  });
});

describe("durum makinesi", () => {
  it("geçersiz geçiş (active→interview) exception atar ve durum değişmez", async () => {
    const teacherId = await tdb.pool.withPlatform(async (db) => {
      await importTeachers(db, [
        { fullName: "Active Teacher", email: "active.teacher@example.com" },
      ]);
      const res = await db.query<{ id: string }>(
        "SELECT id FROM teacher WHERE email = 'active.teacher@example.com'",
      );
      return res.rows[0]!.id;
    });

    await expect(
      tdb.pool.withPlatform((db) => advanceStatus(db, { teacherId, to: "interview" })),
    ).rejects.toThrow(/geçersiz durum geçişi/);

    expect((await readTeacher(teacherId)).status).toBe("active");
  });
});

describe("reject yolu", () => {
  it("görüşme 'reject' kararı eğitmeni rejected'a taşır", async () => {
    const teacherId = await tdb.pool.withPlatform((db) =>
      inviteTeacher(db, {
        fullName: "Reject Candidate",
        email: "reject.candidate@example.com",
        source: "ilan",
      }),
    );
    await tdb.pool.withPlatform(async (db) => {
      await advanceStatus(db, { teacherId, to: "profile" });
      await advanceStatus(db, { teacherId, to: "docs_pending" });
      await advanceStatus(db, { teacherId, to: "interview" });
    });
    const interviewId = await tdb.pool.withPlatform((db) =>
      scheduleInterview(db, { teacherId, scheduledAt: "2026-07-16T09:00:00Z" }),
    );
    await tdb.pool.withPlatform((db) =>
      completeInterview(db, {
        interviewId,
        experienceScore: 2,
        energyScore: 1,
        decision: "reject",
        notes: "Deneyim yetersiz",
      }),
    );

    const teacher = await readTeacher(teacherId);
    expect(teacher.status).toBe("rejected");

    await tdb.pool.withPlatform(async (db) => {
      const iv = await db.query<{ status: string; decision: string }>(
        "SELECT status, decision FROM hr_interview WHERE id = $1",
        [interviewId],
      );
      expect(iv.rows[0]).toEqual({ status: "done", decision: "reject" });
      // Reddedilen havuza girmez
      const membership = await db.query(
        "SELECT 1 FROM teacher_pool WHERE teacher_id = $1",
        [teacherId],
      );
      expect(membership.rows).toEqual([]);
    });
  });
});
