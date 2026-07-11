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

interface Panel {
  teacherName: string;
  timezone: string;
  payableCents: number;
  upcoming: UpcomingLesson[];
  settled: SettledLesson[];
  payouts: TeacherPayout[];
}

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
          {loadError ? <p className="muted">Details: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Hi {panel.teacherName}</h1>
      <p className="muted">All times are shown in {panel.timezone}.</p>

      <div className="card">
        <h2>Your earnings balance</h2>
        <p className="balance">{formatCents(panel.payableCents)}</p>
        <p className="muted">Your per-lesson rate for each completed lesson accumulates here.</p>
        <p className="muted">
          Payouts run every 2 weeks via Wise, after your documents have been verified.
        </p>
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
