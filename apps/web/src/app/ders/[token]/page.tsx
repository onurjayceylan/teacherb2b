"use client";

// Eğitmen ders odası (public, token'lı): token URL'de taşınır, tüm yetki sunucuda
// (session.* uçları token'ı her istekte doğrular). Login yok.
// Öğrenciler MASKELİ adla gelir ("Ad S."); okulun ödediği fiyat sunucudan hiç gelmez.
// DİL: EĞİTMEN YÜZÜ İNGİLİZCE — hedef arz native ESL, Türkçe anlamıyor.
// Denetim P0: kısa ders otomatik settle olmaz — finish yanıtındaki reviewRequired
// eğitmene "payment is pending a quick review" mesajıyla gösterilir.
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { errorMessage, formatCents, trpc } from "../../../lib/trpc";
import { SUPPORT_EMAIL } from "../../../lib/support";

interface RosterEntry {
  studentId: string;
  name: string;
  present: boolean | null;
}

interface Room {
  slotStatus: string;
  sessionStatus: "not_started" | "created" | "started" | "ended" | "settled" | string;
  className: string;
  teacherName: string;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  startsAtLocal: string;
  durationMin: number;
  dosageMin: number | null;
  // Ödeme incelemede mi (kısa ders settle olmadı) — başlık rozeti "Under review" olur.
  reviewRequired: boolean;
  teacherPayCents: number;
  // P1-H: dersin yeri (okulun Zoom/Meet linki) — eğitmen buradan derse girer.
  lessonLink: string | null;
  roster: RosterEntry[];
}

// Yoklama toggle düğmeleri: seçili durum renk-buğulu vurgu alır (yalnız sunum;
// state modeli aynı — true=present, false=absent, undefined=unmarked).
const TOGGLE_BTN: React.CSSProperties = {
  marginTop: 0,
  padding: "0.3rem 0.85rem",
  fontSize: "0.8rem",
};
const TOGGLE_PRESENT_ON: React.CSSProperties = {
  ...TOGGLE_BTN,
  background: "var(--ok-tint)",
  color: "var(--ok)",
  borderColor: "rgba(52, 199, 89, 0.45)",
};
const TOGGLE_ABSENT_ON: React.CSSProperties = {
  ...TOGGLE_BTN,
  background: "var(--danger-tint)",
  color: "var(--danger)",
  borderColor: "rgba(255, 59, 48, 0.4)",
};
const BIG_BTN: React.CSSProperties = {
  padding: "0.7rem 1.8rem",
  fontSize: "1.02rem",
};

export default function DersPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [finished, setFinished] = useState<{ dosageMin: number; reviewRequired: boolean } | null>(
    null,
  );

  const load = useCallback(async () => {
    if (!token) return;
    setLoadError(null);
    try {
      const r = await trpc.session.getRoom.query({ token });
      setRoom(r);
      // Checklist ön dolumu (denetim P2): yalnız DB'de kayıtlı işaretler yüklenir —
      // present ÖN SEÇİLİ DEĞİLDİR; işaretsiz öğrenci "unmarked" kalır ve finish'te uyarılır.
      const next: Record<string, boolean> = {};
      for (const s of r.roster) {
        if (s.present !== null) next[s.studentId] = s.present;
      }
      setChecks(next);
    } catch (err) {
      setRoom(null);
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, successMsg: string | null) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      if (successMsg) setNotice(successMsg);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function saveAttendance() {
    if (!room || room.roster.length === 0) return;
    // Yalnız İŞARETLENMİŞ öğrenciler kaydedilir — işaretsizler DB'de "unmarked" kalır
    // (finish uyarısı bu sayede doğru sayar).
    const entries = room.roster
      .filter((s) => checks[s.studentId] !== undefined)
      .map((s) => ({ studentId: s.studentId, present: checks[s.studentId]! }));
    if (entries.length === 0) {
      setActionError("Mark at least one student first (or use “Mark all present”).");
      return;
    }
    void run(async () => {
      await trpc.session.mark.mutate({ token, entries });
    }, "Attendance saved.");
  }

  function markAllPresent() {
    if (!room) return;
    const next: Record<string, boolean> = {};
    for (const s of room.roster) next[s.studentId] = true;
    setChecks(next);
  }

  function finishLesson() {
    if (!room) return;
    const unmarkedCount = room.roster.filter((s) => checks[s.studentId] === undefined).length;
    const message =
      unmarkedCount > 0
        ? `${unmarkedCount} student${unmarkedCount === 1 ? "" : "s"} unmarked — they will be recorded as absent. Finish the lesson? The duration will be finalized and your payment processed.`
        : "Are you sure you want to finish the lesson? The duration will be finalized and your payment processed.";
    if (!window.confirm(message)) {
      return;
    }
    void run(async () => {
      // Onaylı devam: mevcut işaret durumu tüm sınıf için kalıcılaştırılır (işaretsiz →
      // absent) — uyarı metniyle kayıt bire bir tutarlı. Settle akışına dokunulmaz.
      if (room.roster.length > 0) {
        await trpc.session.mark.mutate({
          token,
          entries: room.roster.map((s) => ({
            studentId: s.studentId,
            present: checks[s.studentId] ?? false,
          })),
        });
      }
      const res = await trpc.session.finish.mutate({ token });
      setFinished({ dosageMin: res.dosageMin, reviewRequired: res.reviewRequired === true });
    }, null);
  }

  if (loading) return <main className="muted">Loading…</main>;

  if (!room) {
    return (
      <main>
        <h1>Lesson room</h1>
        <div className="card">
          <p className="muted">
            This lesson link cannot be used: it may be invalid, expired, or the lesson assignment
            may have changed.
          </p>
          <p>
            <a href="/egitmen/link">Lost your link? Request a new one →</a>
          </p>
          {loadError ? <p className="muted">Details: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  const started = room.sessionStatus === "started";
  const settled = room.sessionStatus === "settled";
  const done = room.sessionStatus === "ended" || settled;
  // Ders bitti ama kısa olduğu için settle OLMADI → başlıkta "Completed" DEĞİL
  // "Under review" gösterilir (alt karttaki rozetle tutarlı; denetim D1/G2 çelişkisi).
  const underReview = room.sessionStatus === "ended" && room.reviewRequired;
  const completed = settled || (room.sessionStatus === "ended" && !room.reviewRequired);
  const notStarted = !started && !done;

  return (
    <main>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.55rem",
          flexWrap: "wrap",
          marginBottom: "0.35rem",
        }}
      >
        <h1 style={{ margin: 0 }}>{room.className} — lesson room</h1>
        {started ? <span className="badge info">In progress</span> : null}
        {completed ? <span className="badge ok">Completed</span> : null}
        {underReview ? <span className="badge info">Under review</span> : null}
      </div>
      <p className="muted">Hi {room.teacherName}.</p>

      <div className="card">
        <p style={{ marginTop: 0 }}>
          {room.lessonLink ? (
            <a
              href={room.lessonLink}
              target="_blank"
              rel="noreferrer"
              style={{ fontWeight: 600, fontSize: "1.05rem" }}
            >
              Join the video call →
            </a>
          ) : (
            <span className="muted">
              No video link set by the school yet — contact support.
            </span>
          )}
        </p>
        <div className="stat-grid">
          <div className="stat">
            <div className="k">Starts</div>
            <div className="v" style={{ fontSize: "1.02rem", lineHeight: 1.4 }}>
              {room.startsAtLocal}
            </div>
            <div className="muted" style={{ fontSize: "0.78rem" }}>{room.timezone} time</div>
          </div>
          <div className="stat">
            <div className="k">Duration</div>
            <div className="v">{room.durationMin} min</div>
          </div>
          <div className="stat">
            <div className="k">Your rate</div>
            <div className="v">{formatCents(room.teacherPayCents)}</div>
          </div>
        </div>
      </div>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      {finished ? (
        <div className="card">
          {finished.reviewRequired ? (
            <>
              <p style={{ marginTop: 0 }}>
                <span className="badge info">Under review</span>
              </p>
              <p style={{ marginBottom: 0 }}>
                Lesson recorded: {finished.dosageMin} min. Because it was unusually short, payment
                is pending a quick review by our team.
              </p>
            </>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>
                <span className="badge ok">Payment processed</span>
              </p>
              <p className="success" style={{ marginBottom: 0 }}>
                Lesson recorded: {finished.dosageMin} min. Your payment has been credited to your
                balance.
              </p>
            </>
          )}
        </div>
      ) : null}

      {notStarted ? (
        <div className="card">
          <h2>The lesson has not started yet</h2>
          <p className="muted">
            The timer starts when you start the lesson; when you finish, your payment is processed
            automatically.
          </p>
          <button
            style={BIG_BTN}
            disabled={busy}
            onClick={() =>
              void run(() => trpc.session.start.mutate({ token }), "Lesson started — have a great class!")
            }
          >
            Start lesson
          </button>
        </div>
      ) : null}

      {started || done ? (
        <div className="card">
          <h2>Attendance</h2>
          {room.roster.length === 0 ? (
            <div className="empty">There are no students enrolled in this class.</div>
          ) : done ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Student</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {room.roster.map((s) => (
                    <tr key={s.studentId}>
                      <td>{s.name}</td>
                      <td>
                        {s.present === null ? (
                          <span className="muted">not marked</span>
                        ) : s.present ? (
                          <span className="badge ok">present</span>
                        ) : (
                          <span className="badge warn">absent</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <p className="muted">
                Mark each student who attended the lesson. Students start unmarked — anyone left
                unmarked when you finish will be recorded as absent.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Mark</th>
                      <th>Saved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {room.roster.map((s) => {
                      const mark = checks[s.studentId];
                      return (
                        <tr key={s.studentId}>
                          <td>{s.name}</td>
                          <td>
                            <div className="actions" style={{ gap: "0.4rem" }}>
                              <button
                                type="button"
                                className="secondary"
                                style={mark === true ? TOGGLE_PRESENT_ON : TOGGLE_BTN}
                                aria-pressed={mark === true}
                                disabled={busy}
                                onClick={() => setChecks({ ...checks, [s.studentId]: true })}
                              >
                                Present
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                style={mark === false ? TOGGLE_ABSENT_ON : TOGGLE_BTN}
                                aria-pressed={mark === false}
                                disabled={busy}
                                onClick={() => setChecks({ ...checks, [s.studentId]: false })}
                              >
                                Absent
                              </button>
                              {mark === undefined ? (
                                <span className="muted" style={{ fontSize: "0.8rem" }}>
                                  unmarked
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td>
                            {s.present === null ? (
                              <span className="muted">—</span>
                            ) : s.present ? (
                              <span className="badge ok">present</span>
                            ) : (
                              <span className="badge warn">absent</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="actions" style={{ marginTop: "0.9rem" }}>
                <button className="secondary" disabled={busy} onClick={markAllPresent}>
                  Mark all present
                </button>
                <button className="secondary" disabled={busy} onClick={saveAttendance}>
                  Save attendance
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {started ? (
        <div className="card">
          <h2>Finish lesson</h2>
          <p className="muted">
            When you finish, the lesson duration is finalized and your payment is credited to
            your balance.
          </p>
          <button style={BIG_BTN} disabled={busy} onClick={finishLesson}>
            Finish lesson
          </button>
        </div>
      ) : null}

      {done && !finished ? (
        <div className="card">
          <h2>Lesson completed</h2>
          {room.sessionStatus === "settled" ? (
            <>
              <p style={{ marginTop: 0 }}>
                <span className="badge ok">Payment processed</span>
              </p>
              <p className="success" style={{ marginBottom: 0 }}>
                Lesson recorded: {room.dosageMin ?? room.durationMin} min. Your payment has been
                credited to your balance.
              </p>
            </>
          ) : (
            <>
              <p style={{ marginTop: 0 }}>
                <span className="badge info">Under review</span>
              </p>
              <p style={{ marginBottom: 0 }}>
                Lesson recorded: {room.dosageMin ?? room.durationMin} min. Payment is pending a
                quick review by our team.
              </p>
            </>
          )}
        </div>
      ) : null}

      <p className="muted">Questions? Contact us: {SUPPORT_EMAIL}</p>
    </main>
  );
}
