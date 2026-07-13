// Oturum yaşam döngüsü: created→started→ended (settle ayrı dosyada — para oradadır).
// Tüm fonksiyonlar aktif bir platform transaction'ındaki PoolClient bekler; durum
// geçişlerinin whitelist'i DB trigger'ında — buradaki UPDATE'ler whitelist dışına çıkamaz.
// session_event append-only: ödeme trigger'ının tek kaynağı olarak her adım iz bırakır.
import type { Db } from "@teachernow/db";

export type SessionEventKind = "join" | "leave" | "check_in" | "check_out" | "heartbeat" | "note";
export type SessionEventRole = "teacher" | "class" | "system";

export interface EnsureSessionResult {
  sessionId: string;
  created: boolean;
}

/**
 * Slot için oturumu açar (idempotent): slot 'scheduled' ve CONFIRMED atamalı olmalı.
 * UNIQUE(slot_id) + ON CONFLICT DO NOTHING → eşzamanlı iki çağrı aynı oturumu paylaşır.
 */
export async function ensureSessionForSlot(db: Db, slotId: string): Promise<EnsureSessionResult> {
  // Slot FOR UPDATE: oturum oluşturma/senkronu, drop/iptal (slot kilidi) ve startSession ile
  // AYNI booking_slot kilidinde serileşir → yarış (drop sırasında oturum doğması) kapanır.
  const slotRes = await db.query<{
    id: string;
    school_id: string;
    class_group_id: string;
    status: string;
  }>("SELECT id, school_id, class_group_id, status FROM booking_slot WHERE id = $1 FOR UPDATE", [
    slotId,
  ]);
  const slot = slotRes.rows[0];
  if (!slot) throw new Error(`ensureSessionForSlot: slot bulunamadı: ${slotId}`);
  if (slot.status !== "scheduled") {
    throw new Error(`ensureSessionForSlot: slot 'scheduled' değil (${slot.status})`);
  }

  const assignmentRes = await db.query<{ teacher_id: string }>(
    "SELECT teacher_id FROM assignment WHERE slot_id = $1 AND status = 'confirmed'",
    [slotId],
  );
  const teacherId = assignmentRes.rows[0]?.teacher_id;
  if (!teacherId) {
    throw new Error(`ensureSessionForSlot: slotta confirmed atama yok (slot=${slotId})`);
  }

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO class_session (slot_id, school_id, teacher_id, class_group_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slot_id) DO NOTHING
     RETURNING id`,
    [slotId, slot.school_id, teacherId, slot.class_group_id],
  );
  const createdRow = inserted.rows[0];
  if (createdRow) return { sessionId: createdRow.id, created: true };

  // Mevcut oturum: teklif-tekrarı (drop→re-offer) confirmed eğitmeni DEĞİŞTİRMİŞ olabilir ama
  // oturum eski eğitmende kalır (ON CONFLICT DO NOTHING güncellemez) → settle YANLIŞ eğitmene
  // öderdi. Henüz başlamamış ('created') oturumun eğitmenini güncel confirmed atamaya senkronla;
  // başlamış/bitmiş oturuma DOKUNMA (o zaten guard'larla korunuyor).
  const existing = await db.query<{ id: string; teacher_id: string; status: string }>(
    "SELECT id, teacher_id, status FROM class_session WHERE slot_id = $1",
    [slotId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error(`ensureSessionForSlot: oturum bulunamadı (slot=${slotId})`);
  if (row.status === "created" && row.teacher_id !== teacherId) {
    await db.query("UPDATE class_session SET teacher_id = $2, updated_at = now() WHERE id = $1", [
      row.id,
      teacherId,
    ]);
  }
  return { sessionId: row.id, created: false };
}

export interface RecordEventInput {
  sessionId: string;
  kind: SessionEventKind;
  role: SessionEventRole;
  meta?: Record<string, unknown>;
}

/** Append-only olay logu — occurred_at DB'de damgalanır. */
export async function recordEvent(db: Db, input: RecordEventInput): Promise<void> {
  await db.query(
    "INSERT INTO session_event (session_id, kind, role, meta) VALUES ($1, $2, $3, $4::jsonb)",
    [input.sessionId, input.kind, input.role, input.meta ? JSON.stringify(input.meta) : null],
  );
}

export interface StartSessionResult {
  alreadyStarted: boolean;
}

/** Ders slot başlangıcından en fazla bu kadar ÖNCE başlatılabilir. */
const START_EARLY_GRACE_MS = 15 * 60_000;
/** Slot bitişinden bu kadar SONRA start artık kabul edilmez (destek devreye girer). */
const START_LATE_LIMIT_MS = 2 * 60 * 60_000;

/**
 * created→started + started_at + check_in olayı.
 * Zaman penceresi (para-güven bulgusu): slot.starts_at - 15 dk'dan önce ya da
 * slot.ends_at + 2 saatten sonra start REDDEDİLİR — settle guard'larının ilk savunma hattı.
 * İdempotent: zaten started ise no-op ({alreadyStarted:true}); ended/settled ise hata.
 * `now` testler için enjekte edilebilir; verilmezse duvar saati.
 */
export async function startSession(
  db: Db,
  sessionId: string,
  opts: { now?: Date } = {},
): Promise<StartSessionResult> {
  // FOR UPDATE OF bs (session değil SLOT kilidi): drop/iptal (getSlotForUpdate) ve
  // ensureSessionForSlot ile AYNI booking_slot kilidinde serileşir. Böylece "drop reads
  // session='created' → başka tx start eder" yarışı kapanır: start slot kilidini bekler,
  // drop commit edince slot 'scheduled' olmadığı için start reddedilir (ve tersi).
  const res = await db.query<{
    status: string;
    slot_status: string;
    starts_at: Date;
    ends_at: Date;
  }>(
    `SELECT cs.status, bs.status AS slot_status, bs.starts_at, bs.ends_at
       FROM class_session cs
       JOIN booking_slot bs ON bs.id = cs.slot_id
      WHERE cs.id = $1
      FOR UPDATE OF bs`,
    [sessionId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`startSession: oturum bulunamadı: ${sessionId}`);
  // Slot iptal/tamamlanmışsa (ör. eğitmen dersi bıraktı → cancelled_teacher) ders
  // başlatılamaz: aksi hâlde iptal edilmiş slota bağlı orphan 'started' oturum doğardı.
  // Idempotent 'already started' cevabından ÖNCE kontrol et — iptal olmuş slotta
  // yanlışlıkla alreadyStarted dönmeyelim.
  if (row.slot_status !== "scheduled") {
    throw new Error(`startSession: ders artık aktif değil (slot: ${row.slot_status})`);
  }
  if (row.status === "started") return { alreadyStarted: true };
  if (row.status !== "created") {
    throw new Error(`startSession: yalnız 'created' oturum başlatılabilir (${row.status})`);
  }

  const now = opts.now ?? new Date();
  if (now.getTime() < row.starts_at.getTime() - START_EARLY_GRACE_MS) {
    const minutesLeft = Math.ceil((row.starts_at.getTime() - now.getTime()) / 60_000);
    throw new Error(
      `startSession: ders henüz başlatılamaz — başlangıca ${minutesLeft} dk var (en erken 15 dk önce)`,
    );
  }
  if (now.getTime() > row.ends_at.getTime() + START_LATE_LIMIT_MS) {
    throw new Error("startSession: ders penceresi geçti — destek ile iletişime geçin");
  }

  await db.query(
    "UPDATE class_session SET status = 'started', started_at = $2, updated_at = now() WHERE id = $1",
    [sessionId, now],
  );
  await recordEvent(db, { sessionId, kind: "check_in", role: "teacher" });
  return { alreadyStarted: false };
}

export interface AttendanceEntry {
  studentId: string;
  present: boolean;
}

/** İsimli yoklama: UNIQUE(session_id, student_id) üstünde upsert — düzeltme serbest. */
export async function markAttendance(
  db: Db,
  sessionId: string,
  entries: AttendanceEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.query(
    `INSERT INTO session_attendance (session_id, student_id, present)
     SELECT $1, u.student_id, u.present
       FROM unnest($2::uuid[], $3::boolean[]) AS u(student_id, present)
     ON CONFLICT (session_id, student_id)
       DO UPDATE SET present = EXCLUDED.present, marked_at = now()`,
    [sessionId, entries.map((e) => e.studentId), entries.map((e) => e.present)],
  );
}

export interface EndSessionResult {
  dosageMin: number;
}

/**
 * started→ended: ended_at + dosage_min=round((ended-started)/dk) + check_out olayı.
 * `now` testler/geç bildirimler için enjekte edilebilir; verilmezse duvar saati.
 */
export async function endSession(
  db: Db,
  sessionId: string,
  opts: { now?: Date } = {},
): Promise<EndSessionResult> {
  const res = await db.query<{ status: string; started_at: Date | null }>(
    "SELECT status, started_at FROM class_session WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`endSession: oturum bulunamadı: ${sessionId}`);
  if (row.status !== "started") {
    throw new Error(`endSession: yalnız 'started' oturum bitirilebilir (${row.status})`);
  }
  if (!row.started_at) throw new Error(`endSession: started_at boş (session=${sessionId})`);

  const endedAt = opts.now ?? new Date();
  const dosageMin = Math.round((endedAt.getTime() - row.started_at.getTime()) / 60_000);
  if (dosageMin < 0) throw new Error("endSession: bitiş başlangıçtan önce olamaz");

  await db.query(
    `UPDATE class_session
        SET status = 'ended', ended_at = $2, dosage_min = $3, updated_at = now()
      WHERE id = $1`,
    [sessionId, endedAt, dosageMin],
  );
  await recordEvent(db, {
    sessionId,
    kind: "check_out",
    role: "teacher",
    meta: { dosage_min: dosageMin },
  });
  return { dosageMin };
}
