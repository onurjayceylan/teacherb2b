// Eşleştirme + teklif yaşam döngüsü.
// Çift-booking'i UYGULAMA DEĞİL VERİTABANI engeller: assignment üzerindeki EXCLUDE
// constraint'i (23P01) yarış anında bile çakışan canlı atamayı imkânsız kılar; kod
// yalnız hatayı yakalayıp sıradaki adaya geçer. Kabul/red CAS'la yapılır (rowcount 0
// = teklif çoktan sonuçlanmış).
import { createHash, randomBytes } from "node:crypto";
import type { ActorPool, Db } from "@teachernow/db";
import { utcToZoneMinutes } from "./time.js";
import { enqueueNotification } from "./notifications.js";
import { getSlot, type SlotRow } from "./slots.js";

export interface Candidate {
  teacherId: string;
  timezone: string;
  confirmedCount: number;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface AvailabilityRow {
  teacher_id: string;
  weekday: number;
  start_minute: number;
  end_minute: number;
  timezone: string;
}

/**
 * Slot için uygun eğitmenleri yük-dengeli sırada döndürür:
 * aktif + dispatch_ready + havuz üyesi + strike<3 + çakışan canlı atama yok +
 * müsaitlik penceresi slotu EĞİTMENİN kendi timezone'unda TAM kapsıyor.
 * Aynı slotu daha önce reddetmiş/düşürmüş/süresi dolmuş eğitmen tekrar aday olmaz.
 * G0: okul reşit-olmayan içeriyorsa (school.minors) yalnız kimlik+ülke-sabıka
 * belgeleri doğrulanmış eğitmen (teacher.safeguarding_ready) aday olur.
 */
export async function findCandidates(db: Db, slot: SlotRow): Promise<Candidate[]> {
  const teachers = await db.query<{
    id: string;
    timezone: string;
    confirmed_count: string;
  }>(
    `SELECT t.id, t.timezone,
            (SELECT count(*) FROM assignment ca
              WHERE ca.teacher_id = t.id AND ca.status = 'confirmed') AS confirmed_count
       FROM teacher t
       JOIN teacher_pool tp ON tp.teacher_id = t.id AND tp.pool_id = $1 AND tp.active
       JOIN school s ON s.id = $5
      WHERE t.status = 'active'
        AND t.dispatch_ready
        AND t.strike_count < 3
        -- G0 kapısı: reşit-olmayan içeren okulda safeguarding evrakları şart
        AND (NOT s.minors OR t.safeguarding_ready)
        -- çakışan canlı atama (offered/confirmed) olan eğitmen aday değil
        AND NOT EXISTS (
          SELECT 1 FROM assignment a
           WHERE a.teacher_id = t.id
             AND a.status IN ('offered', 'confirmed')
             AND tstzrange(a.starts_at, a.ends_at) && tstzrange($2::timestamptz, $3::timestamptz)
        )
        -- bu slotu zaten reddetmiş/bırakmış/süresi dolmuş eğitmene tekrar teklif yok
        AND NOT EXISTS (
          SELECT 1 FROM assignment p
           WHERE p.teacher_id = t.id AND p.slot_id = $4
             AND p.status IN ('declined', 'dropped', 'expired')
        )
      ORDER BY confirmed_count ASC, t.created_at ASC`,
    [slot.pool_id, slot.starts_at, slot.ends_at, slot.id, slot.school_id],
  );
  if (teachers.rows.length === 0) return [];

  const availability = await db.query<AvailabilityRow>(
    `SELECT teacher_id, weekday, start_minute, end_minute, timezone
       FROM teacher_availability
      WHERE active AND teacher_id = ANY($1::uuid[])`,
    [teachers.rows.map((t) => t.id)],
  );
  const windowsByTeacher = new Map<string, AvailabilityRow[]>();
  for (const w of availability.rows) {
    const list = windowsByTeacher.get(w.teacher_id) ?? [];
    list.push(w);
    windowsByTeacher.set(w.teacher_id, list);
  }

  const durationMin = Math.round((slot.ends_at.getTime() - slot.starts_at.getTime()) / 60_000);
  const covers = (w: AvailabilityRow): boolean => {
    // Slot başlangıcını PENCERENİN timezone'unda duvar saatine indir; pencere
    // slotu tam kapsamalı. Gece yarısını aşan slot tek pencereye sığmaz (end<=1440).
    const local = utcToZoneMinutes(slot.starts_at, w.timezone);
    const localEnd = local.minute + durationMin;
    return (
      w.weekday === local.weekday && w.start_minute <= local.minute && w.end_minute >= localEnd
    );
  };

  return teachers.rows
    .filter((t) => (windowsByTeacher.get(t.id) ?? []).some(covers))
    .map((t) => ({
      teacherId: t.id,
      timezone: t.timezone,
      confirmedCount: Number(t.confirmed_count),
    }));
}

export interface OfferResult {
  assignmentId: string;
  teacherId: string;
  /** Ham token yalnız burada döner; DB'de SHA-256 hash'i durur. */
  token: string;
}

export interface OfferNextOptions {
  offerTtlMinutes?: number;
  now?: Date;
}

/**
 * Sıradaki adaya teklif açar. Exclusion (23P01) yarışında sıradaki adaya geçer;
 * slotta zaten canlı atama varsa (partial unique, 23505) null döner.
 * Çağıranın platform transaction'ı içinde çalışır.
 */
export async function offerNext(
  db: Db,
  slot: SlotRow,
  opts: OfferNextOptions = {},
): Promise<OfferResult | null> {
  const ttlMinutes = opts.offerTtlMinutes ?? 20;
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

  const candidates = await findCandidates(db, slot);
  for (const candidate of candidates) {
    const token = randomBytes(32).toString("hex");
    await db.query("SAVEPOINT offer_try");
    try {
      const res = await db.query<{ id: string }>(
        `INSERT INTO assignment
           (slot_id, teacher_id, status, starts_at, ends_at, offer_token_hash, offer_expires_at)
         VALUES ($1, $2, 'offered', $3, $4, $5, $6)
         RETURNING id`,
        [slot.id, candidate.teacherId, slot.starts_at, slot.ends_at, sha256Hex(token), expiresAt],
      );
      // Teklif e-postası AYNI transaction'da outbox'a düşer (0012 outbox deseni):
      // teklif varsa kayıt da vardır. URL kurulmaz — dispatcher BASE_URL ile kurar.
      await enqueueOfferNotification(db, slot, candidate, token, expiresAt);
      await db.query("RELEASE SAVEPOINT offer_try");
      return { assignmentId: res.rows[0]!.id, teacherId: candidate.teacherId, token };
    } catch (err) {
      await db.query("ROLLBACK TO SAVEPOINT offer_try");
      const code = (err as { code?: string }).code;
      if (code === "23P01") continue; // eğitmen yarışta başka slot kaptı → sıradaki aday
      if (code === "23505") return null; // slotta zaten canlı atama var
      throw err;
    }
  }
  return null;
}

/** Teklif açılan eğitmene 'teacher_offer' outbox kaydı (offerNext transaction'ı içinde).
 * P0-A: ücret (payCents) ve son geçerlilik (expiresAt) e-postada ZORUNLU — payload'a
 * burada girer; dispatcher şablonu bunları eğitmen dilinde/diliminde biçimler. */
async function enqueueOfferNotification(
  db: Db,
  slot: SlotRow,
  candidate: Candidate,
  token: string,
  expiresAt: Date,
): Promise<void> {
  const ctx = await db.query<{ email: string; pool_name: string; school_name: string }>(
    `SELECT t.email, p.name AS pool_name, s.name AS school_name
       FROM teacher t
       JOIN pool p ON p.id = $2
       JOIN school s ON s.id = $3
      WHERE t.id = $1`,
    [candidate.teacherId, slot.pool_id, slot.school_id],
  );
  const row = ctx.rows[0];
  if (!row) throw new Error(`offerNext: eğitmen bulunamadı (teacher=${candidate.teacherId})`);
  await enqueueNotification(db, {
    recipientEmail: row.email,
    template: "teacher_offer",
    payload: {
      token,
      slotStartsAt: slot.starts_at.toISOString(),
      durationMin: Math.round((slot.ends_at.getTime() - slot.starts_at.getTime()) / 60_000),
      teacherTimezone: candidate.timezone,
      poolName: row.pool_name,
      schoolName: row.school_name,
      payCents: Number(slot.teacher_pay_cents), // pg bigint → string → number
      expiresAt: expiresAt.toISOString(),
    },
  });
}

export type AcceptOfferResult =
  | { ok: true; slotId: string }
  | { ok: false; reason: "expired_or_taken" };

/** Token'lı kabul: CAS ile offered→confirmed. Süresi dolmuş/sonuçlanmış teklif reddedilir. */
export async function acceptOffer(pool: ActorPool, token: string): Promise<AcceptOfferResult> {
  return pool.withPlatform(async (db) => {
    const found = await db.query<{ id: string; slot_id: string }>(
      `SELECT id, slot_id FROM assignment
        WHERE offer_token_hash = $1 AND status = 'offered' AND offer_expires_at > now()`,
      [sha256Hex(token)],
    );
    const offer = found.rows[0];
    if (!offer) return { ok: false, reason: "expired_or_taken" };

    const updated = await db.query(
      `UPDATE assignment
          SET status = 'confirmed', responded_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'offered'`,
      [offer.id],
    );
    if (updated.rowCount === 0) return { ok: false, reason: "expired_or_taken" };
    return { ok: true, slotId: offer.slot_id };
  });
}

export type DeclineOfferResult =
  | { ok: true; nextTeacherId?: string }
  | { ok: false; reason: "expired_or_taken" };

/** Token'lı red: CAS ile declined + AYNI transaction'da sıradaki adaya teklif. */
export async function declineOffer(pool: ActorPool, token: string): Promise<DeclineOfferResult> {
  return pool.withPlatform(async (db) => {
    const found = await db.query<{ id: string; slot_id: string }>(
      `SELECT id, slot_id FROM assignment WHERE offer_token_hash = $1 AND status = 'offered'`,
      [sha256Hex(token)],
    );
    const offer = found.rows[0];
    if (!offer) return { ok: false, reason: "expired_or_taken" };

    const updated = await db.query(
      `UPDATE assignment
          SET status = 'declined', responded_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'offered'`,
      [offer.id],
    );
    if (updated.rowCount === 0) return { ok: false, reason: "expired_or_taken" };

    const slot = await getSlot(db, offer.slot_id);
    if (!slot || slot.status !== "scheduled") return { ok: true };
    const next = await offerNext(db, slot);
    return next ? { ok: true, nextTeacherId: next.teacherId } : { ok: true };
  });
}

export interface ExpireResult {
  expired: number;
  reoffered: number;
}

/** Süresi geçmiş teklifleri CAS ile expired yapar ve her slot için sıradaki adaya geçer. */
export async function expireStaleOffers(
  pool: ActorPool,
  opts: { now?: Date } = {},
): Promise<ExpireResult> {
  const now = opts.now ?? new Date();
  return pool.withPlatform(async (db) => {
    const stale = await db.query<{ slot_id: string }>(
      `UPDATE assignment
          SET status = 'expired', updated_at = now()
        WHERE status = 'offered' AND offer_expires_at < $1
        RETURNING slot_id`,
      [now],
    );
    let reoffered = 0;
    for (const row of stale.rows) {
      const slot = await getSlot(db, row.slot_id);
      if (!slot || slot.status !== "scheduled") continue;
      const next = await offerNext(db, slot);
      if (next) reoffered += 1;
    }
    return { expired: stale.rowCount ?? 0, reoffered };
  });
}
