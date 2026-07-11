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
  teacherPayCents: number;
  roster: RosterEntry[];
}

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
          {loadError ? <p className="muted">Details: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  const started = room.sessionStatus === "started";
  const done = room.sessionStatus === "ended" || room.sessionStatus === "settled";
  const notStarted = !started && !done;

  return (
    <main>
      <h1>
        {room.className} — lesson room
      </h1>
      <p className="muted">
        Hi {room.teacherName}. {room.startsAtLocal}{" "}
        <span className="muted">({room.timezone} time)</span> · {room.durationMin} min ·
        your rate <strong>{formatCents(room.teacherPayCents)}</strong>
      </p>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      {finished ? (
        <div className="card">
          {finished.reviewRequired ? (
            <p className="success">
              Lesson recorded: {finished.dosageMin} min. Because it was unusually short, payment
              is pending a quick review by our team.
            </p>
          ) : (
            <p className="success">
              Lesson recorded: {finished.dosageMin} min. Your payment has been credited to your
              balance.
            </p>
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
            <p className="muted">There are no students enrolled in this class.</p>
          ) : done ? (
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
          ) : (
            <>
              <p className="muted">
                Check the students who attended the lesson. Students start unmarked — anyone left
                unmarked when you finish will be recorded as absent.
              </p>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {room.roster.map((s) => (
                  <li key={s.studentId} style={{ marginBottom: "0.35rem" }}>
                    <label>
                      <input
                        type="checkbox"
                        style={{ width: "auto", marginRight: "0.5rem" }}
                        checked={checks[s.studentId] ?? false}
                        onChange={(e) =>
                          setChecks({ ...checks, [s.studentId]: e.target.checked })
                        }
                      />
                      {s.name}
                      {s.present !== null ? (
                        <span className="muted"> (saved: {s.present ? "present" : "absent"})</span>
                      ) : (
                        <span className="muted"> (unmarked)</span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
              <div style={{ display: "flex", gap: "0.5rem" }}>
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
          <button disabled={busy} onClick={finishLesson}>
            Finish lesson
          </button>
        </div>
      ) : null}

      {done && !finished ? (
        <div className="card">
          <h2>Lesson completed</h2>
          <p className="success">
            Lesson recorded: {room.dosageMin ?? room.durationMin} min.
            {room.sessionStatus === "settled"
              ? " Your payment has been credited to your balance."
              : " Payment is pending a quick review by our team."}
          </p>
        </div>
      ) : null}
    </main>
  );
}
