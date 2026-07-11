"use client";

// Eğitmen paneli (public, kalıcı imzalı link): kazanç bakiyesi + gelecek dersler
// (kendi saat diliminde, katılım linkiyle) + son settle edilmiş dersler.
// Token her istekte sunucuda doğrulanır; iptal edilirse sayfa anında kapanır.
// DİL: EĞİTMEN YÜZÜ İNGİLİZCE — hedef arz native ESL, Türkçe anlamıyor.
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { errorMessage, formatCents, trpc } from "../../../../lib/trpc";

interface UpcomingLesson {
  slotId: string;
  schoolName: string;
  className: string;
  startsAt: Date;
  startsAtLocal: string;
  durationMin: number;
  teacherPayCents: number;
  joinUrl: string;
}

interface SettledLesson {
  sessionId: string;
  schoolName: string;
  className: string;
  endedAt: Date | null;
  endedAtLocal: string;
  dosageMin: number;
  earnedCents: number;
}

interface TeacherPayout {
  id: string;
  amountCents: number;
  status: string;
  failureReason: string | null;
  paidAt: Date | null;
  paidAtLocal: string;
  createdAtLocal: string;
  externalRef: string | null;
}

type PayoutMethod = "wise_email" | "iban";

interface MaskedPayout {
  method: PayoutMethod;
  maskedValue: string;
  accountHolder: string;
}

interface AvailabilityWindow {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  timezone: string;
}

interface Panel {
  teacherName: string;
  timezone: string;
  payableCents: number;
  strikeCount: number;
  strikeLimit: number;
  availability: AvailabilityWindow[];
  payoutDetails: MaskedPayout | null;
  upcoming: UpcomingLesson[];
  settled: SettledLesson[];
  payouts: TeacherPayout[];
}

// ISO weekday order (0=Monday) — must match the server-side weekday convention.
const WEEKDAYS_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function minuteToHHMM(minute: number): string {
  const h = String(Math.floor(minute / 60)).padStart(2, "0");
  const m = String(minute % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function hhmmToMinute(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  return minute >= 0 && minute <= 1440 ? minute : null;
}

const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  wise_email: "Wise e-mail",
  iban: "IBAN",
};

const PAYOUT_STATUS_LABELS: Record<string, { label: string; ok: boolean }> = {
  pending: { label: "being prepared", ok: false },
  submitted: { label: "sent to bank", ok: false },
  paid: { label: "paid", ok: true },
  failed: { label: "failed", ok: false },
  cancelled: { label: "cancelled", ok: false },
};

export default function EgitmenPanelPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [panel, setPanel] = useState<Panel | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPayoutForm, setShowPayoutForm] = useState(false);
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod>("wise_email");
  const [payoutValue, setPayoutValue] = useState("");
  const [payoutHolder, setPayoutHolder] = useState("");
  const [availWeekday, setAvailWeekday] = useState("0");
  const [availStart, setAvailStart] = useState("09:00");
  const [availEnd, setAvailEnd] = useState("17:00");

  const load = useCallback(async () => {
    if (!token) return;
    setLoadError(null);
    try {
      setPanel(await trpc.teacherPortal.getPanel.query({ token }));
    } catch (err) {
      setPanel(null);
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <main className="muted">Loading…</main>;

  if (!panel) {
    return (
      <main>
        <h1>Teacher panel</h1>
        <div className="card">
          <p className="muted">
            This panel link cannot be used: it may be invalid or revoked. Contact the Teachernow
            team for a new link.
          </p>
          <p>
            <a href="/egitmen/link">Lost your link? Request a new one →</a>
          </p>
          {loadError ? <p className="muted">Details: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  async function runAction(action: () => Promise<string | null>) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const msg = await action();
      if (msg) setNotice(msg);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function addAvailability(e: React.FormEvent) {
    e.preventDefault();
    const startMinute = hhmmToMinute(availStart);
    const endMinute = hhmmToMinute(availEnd);
    if (startMinute === null || endMinute === null || endMinute <= startMinute) {
      setActionError("Please enter a valid time window (end must be after start).");
      return;
    }
    void runAction(async () => {
      await trpc.teacherPortal.addAvailability.mutate({
        token,
        weekday: Number(availWeekday),
        startMinute,
        endMinute,
        timezone: panel!.timezone,
      });
      return "Availability window added.";
    });
  }

  function removeAvailability(id: string) {
    void runAction(async () => {
      await trpc.teacherPortal.removeAvailability.mutate({ token, id });
      return "Availability window removed.";
    });
  }

  function dropLesson(lesson: UpcomingLesson) {
    const confirmed = window.confirm(
      "The lesson will be re-offered to other teachers. Dropping lessons frequently may reduce your future offers. Do you want to drop this lesson?",
    );
    if (!confirmed) return;
    void runAction(async () => {
      const res = await trpc.teacherPortal.dropLesson.mutate({ token, slotId: lesson.slotId });
      return res.reoffered
        ? "You dropped the lesson — it has been re-offered to another teacher."
        : "You dropped the lesson — no replacement teacher was found, so the school has been refunded.";
    });
  }

  async function savePayoutDetails(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await trpc.teacherPortal.updatePayoutDetails.mutate({
        token,
        details: {
          method: payoutMethod,
          value: payoutValue.trim(),
          accountHolder: payoutHolder.trim(),
        },
      });
      setNotice("Payout details saved.");
      setPayoutValue("");
      setPayoutHolder("");
      setShowPayoutForm(false);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Hi {panel.teacherName}</h1>
      <p className="muted">All times are shown in {panel.timezone}.</p>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      <div className="card">
        <h2>Your earnings balance</h2>
        <p className="balance">{formatCents(panel.payableCents)}</p>
        <p className="muted">Your per-lesson rate for each completed lesson accumulates here.</p>
        <p className="muted">
          Payouts run every 2 weeks via Wise, after your documents have been verified.
        </p>
        <p>
          No-show strikes:{" "}
          <span className={`badge ${panel.strikeCount === 0 ? "ok" : "warn"}`}>
            {panel.strikeCount}/{panel.strikeLimit}
          </span>{" "}
          <span className="muted">{panel.strikeLimit} strikes lead to suspension.</span>
        </p>
      </div>

      <div className="card">
        <h2>My weekly availability</h2>
        <p className="muted">
          These windows tell us when you can teach — new lesson offers are matched against them.
        </p>
        {panel.availability.length === 0 ? (
          <p className="error">
            No availability windows yet — add at least one to receive lesson offers.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Hours</th>
                <th>Time zone</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {panel.availability.map((w) => (
                <tr key={w.id}>
                  <td>{WEEKDAYS_EN[w.weekday] ?? w.weekday}</td>
                  <td>
                    {minuteToHHMM(w.startMinute)}–{minuteToHHMM(w.endMinute)}
                  </td>
                  <td>{w.timezone}</td>
                  <td>
                    <button
                      className="secondary"
                      style={{ marginTop: 0 }}
                      disabled={busy}
                      onClick={() => removeAvailability(w.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form onSubmit={addAvailability}>
          <div className="row">
            <div>
              <label htmlFor="av-day">Day</label>
              <select
                id="av-day"
                value={availWeekday}
                onChange={(e) => setAvailWeekday(e.target.value)}
              >
                {WEEKDAYS_EN.map((d, i) => (
                  <option key={d} value={String(i)}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="av-start">From</label>
              <input
                id="av-start"
                type="time"
                value={availStart}
                onChange={(e) => setAvailStart(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="av-end">To</label>
              <input
                id="av-end"
                type="time"
                value={availEnd}
                onChange={(e) => setAvailEnd(e.target.value)}
                required
              />
            </div>
            <div>
              <button type="submit" className="secondary" disabled={busy}>
                Add window
              </button>
            </div>
          </div>
          <p className="muted">Times are in your time zone ({panel.timezone}).</p>
        </form>
      </div>

      <div className="card">
        <h2>Payout details</h2>
        {panel.payoutDetails ? (
          <p>
            {PAYOUT_METHOD_LABELS[panel.payoutDetails.method]}{" "}
            <span className="mono">{panel.payoutDetails.maskedValue}</span> — account holder{" "}
            {panel.payoutDetails.accountHolder}
          </p>
        ) : (
          <p className="error">Add your payout details to receive payments.</p>
        )}
        {showPayoutForm ? (
          <form onSubmit={savePayoutDetails}>
            <div className="row">
              <div>
                <label htmlFor="pp-method">Method</label>
                <select
                  id="pp-method"
                  value={payoutMethod}
                  onChange={(e) => setPayoutMethod(e.target.value as PayoutMethod)}
                >
                  <option value="wise_email">Wise e-mail</option>
                  <option value="iban">IBAN</option>
                </select>
              </div>
              <div>
                <label htmlFor="pp-value">
                  {payoutMethod === "wise_email" ? "Wise account e-mail" : "IBAN"}
                </label>
                <input
                  id="pp-value"
                  value={payoutValue}
                  onChange={(e) => setPayoutValue(e.target.value)}
                  placeholder={payoutMethod === "wise_email" ? "you@example.com" : "TR00 0000 ..."}
                  required
                  minLength={5}
                />
              </div>
              <div>
                <label htmlFor="pp-holder">Account holder (full legal name)</label>
                <input
                  id="pp-holder"
                  value={payoutHolder}
                  onChange={(e) => setPayoutHolder(e.target.value)}
                  placeholder={panel.teacherName}
                  required
                  minLength={2}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="submit" disabled={busy}>
                Save payout details
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setShowPayoutForm(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button className="secondary" onClick={() => setShowPayoutForm(true)}>
            {panel.payoutDetails ? "Update payout details" : "Add payout details"}
          </button>
        )}
      </div>

      <div className="card">
        <h2>My payouts</h2>
        {panel.payouts.length === 0 ? (
          <p className="muted">No payouts yet — payouts run every 2 weeks.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th>Wise reference</th>
                </tr>
              </thead>
              <tbody>
                {panel.payouts.map((p) => {
                  const st = PAYOUT_STATUS_LABELS[p.status] ?? { label: p.status, ok: false };
                  return (
                    <tr key={p.id}>
                      <td>{formatCents(p.amountCents)}</td>
                      <td>
                        <span className={`badge ${st.ok ? "ok" : "warn"}`}>{st.label}</span>
                        {p.status === "failed" && p.failureReason ? (
                          <span className="muted"> — {p.failureReason}</span>
                        ) : null}
                      </td>
                      <td>{p.paidAt ? p.paidAtLocal : p.createdAtLocal}</td>
                      <td className="mono">{p.externalRef ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted">
          If a payout fails, your balance is protected — it carries over to the next payout run.
        </p>
      </div>

      <div className="card">
        <h2>Your upcoming lessons</h2>
        {panel.upcoming.length === 0 ? (
          <p className="muted">No scheduled lessons — new offers will appear here as they come in.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Date / time</th>
                  <th>School / class</th>
                  <th>Duration</th>
                  <th>Rate</th>
                  <th>Join</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {panel.upcoming.map((l) => (
                  <tr key={l.slotId}>
                    <td>{l.startsAtLocal}</td>
                    <td>
                      {l.schoolName} — {l.className}
                    </td>
                    <td>{l.durationMin} min</td>
                    <td>{formatCents(l.teacherPayCents)}</td>
                    <td>
                      <a href={l.joinUrl}>Join lesson →</a>
                    </td>
                    <td>
                      <button
                        className="secondary"
                        style={{ marginTop: 0 }}
                        disabled={busy}
                        onClick={() => dropLesson(l)}
                      >
                        Drop this lesson
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Recent lessons (payment processed)</h2>
        {panel.settled.length === 0 ? (
          <p className="muted">No completed lessons yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>School / class</th>
                  <th>Duration</th>
                  <th>Earned</th>
                </tr>
              </thead>
              <tbody>
                {panel.settled.map((l) => (
                  <tr key={l.sessionId}>
                    <td>{l.endedAtLocal}</td>
                    <td>
                      {l.schoolName} — {l.className}
                    </td>
                    <td>{l.dosageMin} min</td>
                    <td>{formatCents(l.earnedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
