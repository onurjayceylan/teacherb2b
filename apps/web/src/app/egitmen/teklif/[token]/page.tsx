"use client";

// Public eğitmen teklif sayfası: token URL'de taşınır, tüm yetki sunucuda (offer.* uçları
// token'ı her istekte doğrular). Login yok. Eğitmen KENDİ ücretini görür; okul fiyatı
// sunucudan hiç gelmez.
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

  if (loading) return <main className="muted">Yükleniyor…</main>;

  if (result) {
    return (
      <main>
        <h1>Ders teklifi</h1>
        <div className="card">
          {result.kind === "accepted" ? (
            <>
              <p className="success">Teklifi kabul ettiniz — ders programınıza eklendi.</p>
              <p className="muted">Ders detayları için Teachernow ekibi sizinle iletişimde olacak.</p>
            </>
          ) : null}
          {result.kind === "declined" ? (
            <>
              <p>Teklifi reddettiniz.</p>
              <p className="muted">
                Sorun değil — müsaitliğinize uyan yeni dersler için tekrar teklif alacaksınız.
              </p>
            </>
          ) : null}
          {result.kind === "gone" ? (
            <p className="muted">
              Bu teklif artık geçerli değil: süresi dolmuş ya da ders başka bir eğitmene atanmış
              olabilir. Yeni teklifler geldikçe size ulaşacağız.
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  if (!offer) {
    return (
      <main>
        <h1>Ders teklifi</h1>
        <div className="card">
          <p className="muted">
            Bu teklif bağlantısı kullanılamıyor: süresi dolmuş, geri çekilmiş ya da ders başka bir
            eğitmene atanmış olabilir. Yeni teklifler geldikçe size ulaşacağız.
          </p>
          {loadError ? <p className="muted">Ayrıntı: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Merhaba {offer.teacherName}, yeni ders teklifiniz var</h1>

      {actionError ? <p className="error">{actionError}</p> : null}

      <div className="card">
        <table>
          <tbody>
            <tr>
              <th>Okul</th>
              <td>{offer.schoolName}</td>
            </tr>
            <tr>
              <th>Sınıf</th>
              <td>{offer.className}</td>
            </tr>
            <tr>
              <th>Ders</th>
              <td>{offer.poolName}</td>
            </tr>
            <tr>
              <th>Tarih / saat</th>
              <td>
                {offer.startsAtLocal}{" "}
                <span className="muted">({offer.timezone} saatiyle)</span>
              </td>
            </tr>
            <tr>
              <th>Süre</th>
              <td>{offer.durationMin} dakika</td>
            </tr>
            <tr>
              <th>Ücretiniz</th>
              <td>
                <strong>{formatCents(offer.teacherPayCents)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="muted">
          Teklif {new Date(offer.expiresAt).toLocaleString("tr-TR")} itibarıyla sona erer; yanıt
          vermezseniz ders sıradaki eğitmene önerilir.
        </p>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button disabled={busy} onClick={() => void respond("accept")}>
            Kabul et
          </button>
          <button className="secondary" disabled={busy} onClick={() => void respond("decline")}>
            Reddet
          </button>
        </div>
      </div>
    </main>
  );
}
