"use client";

// Eğitmen paneli (public, kalıcı imzalı link): kazanç bakiyesi + gelecek dersler
// (kendi saat diliminde, katılım linkiyle) + son settle edilmiş dersler.
// Token her istekte sunucuda doğrulanır; iptal edilirse sayfa anında kapanır.
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

interface Panel {
  teacherName: string;
  timezone: string;
  payableCents: number;
  upcoming: UpcomingLesson[];
  settled: SettledLesson[];
}

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

  if (loading) return <main className="muted">Yükleniyor…</main>;

  if (!panel) {
    return (
      <main>
        <h1>Eğitmen paneli</h1>
        <div className="card">
          <p className="muted">
            Bu panel bağlantısı kullanılamıyor: geçersiz ya da iptal edilmiş olabilir. Yeni
            link için Teachernow ekibine ulaşın.
          </p>
          {loadError ? <p className="muted">Ayrıntı: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Merhaba {panel.teacherName}</h1>
      <p className="muted">Saatler {panel.timezone} dilimindedir.</p>

      <div className="card">
        <h2>Kazanç bakiyeniz</h2>
        <p className="balance">{formatCents(panel.payableCents)}</p>
        <p className="muted">Tamamlanan derslerin ücretleri burada birikir.</p>
      </div>

      <div className="card">
        <h2>Yaklaşan dersleriniz</h2>
        {panel.upcoming.length === 0 ? (
          <p className="muted">Planlanmış ders yok — yeni teklifler geldikçe burada görünür.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Tarih / saat</th>
                  <th>Okul / sınıf</th>
                  <th>Süre</th>
                  <th>Ücret</th>
                  <th>Katılım</th>
                </tr>
              </thead>
              <tbody>
                {panel.upcoming.map((l) => (
                  <tr key={l.slotId}>
                    <td>{l.startsAtLocal}</td>
                    <td>
                      {l.schoolName} — {l.className}
                    </td>
                    <td>{l.durationMin} dk</td>
                    <td>{formatCents(l.teacherPayCents)}</td>
                    <td>
                      <a href={l.joinUrl}>Derse katıl →</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Son dersler (ödemesi işlendi)</h2>
        {panel.settled.length === 0 ? (
          <p className="muted">Henüz tamamlanmış ders yok.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Okul / sınıf</th>
                  <th>Süre</th>
                  <th>Kazanç</th>
                </tr>
              </thead>
              <tbody>
                {panel.settled.map((l) => (
                  <tr key={l.sessionId}>
                    <td>{l.endedAtLocal}</td>
                    <td>
                      {l.schoolName} — {l.className}
                    </td>
                    <td>{l.dosageMin} dk</td>
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
