"use client";

// Public eğitmen teklif sayfası: token URL'de taşınır, tüm yetki sunucuda (offer.* uçları
// token'ı her istekte doğrular). Login yok. Eğitmen KENDİ ücretini görür; okul fiyatı
// sunucudan hiç gelmez.
// DİL: EĞİTMEN YÜZÜ İNGİLİZCE — hedef arz native ESL, Türkçe anlamıyor. Saatler
// sunucuda eğitmenin kendi diliminde (en-US) formatlanır; dilim etiketi yanında basılır.
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { errorMessage, formatCents, trpc } from "../../../../lib/trpc";

interface OfferView {
  schoolName: string;
  className: string;
  poolName: string;
  teacherName: string;
  timezone: string;
  startsAt: Date;
  endsAt: Date;
  startsAtLocal: string;
  expiresAt: Date;
  expiresAtLocal: string;
  durationMin: number;
  teacherPayCents: number;
}

type Result =
  | { kind: "accepted" }
  | { kind: "declined" }
  | { kind: "gone" };

export default function TeklifPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [offer, setOffer] = useState<OfferView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoadError(null);
    try {
      setOffer(await trpc.offer.get.query({ token }));
    } catch (err) {
      setOffer(null);
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function respond(kind: "accept" | "decline") {
    setBusy(true);
    setActionError(null);
    try {
      if (kind === "accept") {
        const res = await trpc.offer.accept.mutate({ token });
        setResult(res.ok ? { kind: "accepted" } : { kind: "gone" });
      } else {
        const res = await trpc.offer.decline.mutate({ token });
        setResult(res.ok ? { kind: "declined" } : { kind: "gone" });
      }
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="muted">Loading…</main>;

  if (result) {
    return (
      <main>
        <h1>Lesson offer</h1>
        <div className="card">
          {result.kind === "accepted" ? (
            <>
              <p className="success">You accepted the offer — the lesson has been added to your schedule.</p>
              <p className="muted">The Teachernow team will be in touch with the lesson details.</p>
            </>
          ) : null}
          {result.kind === "declined" ? (
            <>
              <p>You declined the offer.</p>
              <p className="muted">
                No problem — you will receive new offers for lessons that match your availability.
              </p>
            </>
          ) : null}
          {result.kind === "gone" ? (
            <p className="muted">
              This offer is no longer valid: it may have expired or the lesson may have been
              assigned to another teacher. We will reach out as new offers come in.
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  if (!offer) {
    return (
      <main>
        <h1>Lesson offer</h1>
        <div className="card">
          <p className="muted">
            This offer link is no longer available: it may have expired, been withdrawn, or the
            lesson may have been assigned to another teacher. We will reach out as new offers
            come in.
          </p>
          {loadError ? <p className="muted">Details: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Hi {offer.teacherName}, you have a new lesson offer</h1>

      {actionError ? <p className="error">{actionError}</p> : null}

      <div className="card">
        <table>
          <tbody>
            <tr>
              <th>School</th>
              <td>{offer.schoolName}</td>
            </tr>
            <tr>
              <th>Class</th>
              <td>{offer.className}</td>
            </tr>
            <tr>
              <th>Course</th>
              <td>{offer.poolName}</td>
            </tr>
            <tr>
              <th>Date / time</th>
              <td>
                {offer.startsAtLocal}{" "}
                <span className="muted">({offer.timezone} time)</span>
              </td>
            </tr>
            <tr>
              <th>Duration</th>
              <td>{offer.durationMin} minutes</td>
            </tr>
            <tr>
              <th>Your rate for this lesson</th>
              <td>
                <strong>{formatCents(offer.teacherPayCents)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          This offer expires on {offer.expiresAtLocal}{" "}
          <span className="muted">({offer.timezone} time)</span>. If you do not respond, the
          lesson will be offered to the next teacher.
        </p>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button disabled={busy} onClick={() => void respond("accept")}>
            Accept
          </button>
          <button className="secondary" disabled={busy} onClick={() => void respond("decline")}>
            Decline
          </button>
        </div>
      </div>
    </main>
  );
}
