"use client";

// Sınıf katılım sayfası (public, class token'lı): Faz-1'de yalnız durum ekranı —
// sınıf adı + "ders başladı / bekleniyor". PII yok, fiyat yok.
// DİL: İKİ DİLLİ (kısa Türkçe + İngilizce) — sayfa okul/öğrenci projeksiyonuna açılıyor;
// ders İngilizce, sınıf Türkiye'de. Tarihler iki formatta basılır (tr-TR + en-US).
// TASARIM: projeksiyon sayfası — tipografi sınıfın arkasından okunacak kadar BÜYÜK.
// NOT: SuperClass entegrasyonu geldiğinde bu sayfa (veya /join ucu) provider'ın
// canlı ders URL'sine 302 yönlendirecek; token akışı değişmeden kalır.
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { errorMessage, trpc } from "../../../lib/trpc";
import { SUPPORT_EMAIL } from "../../../lib/support";

interface ClassStatus {
  className: string;
  startsAt: Date;
  schoolTz: string;
  started: boolean;
  ended: boolean;
  // P1-H: dersin yeri (okulun Zoom/Meet linki) — sınıf projeksiyonundan buraya tıklanır.
  lessonLink: string | null;
}

/**
 * Saatler planın OKUL saat diliminde (denetim P2): sayfa sınıf projeksiyonuna açılır,
 * tarayıcının dilimi (ör. sunum bilgisayarı UTC'de) yanıltmasın. Geçersiz tz'de
 * tarayıcı yereline düşer.
 */
function formatInSchoolTz(at: Date, locale: "tr-TR" | "en-US", tz: string): string {
  try {
    return new Date(at).toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: tz,
    });
  } catch {
    return new Date(at).toLocaleString(locale);
  }
}

// Projeksiyon tipografisi (yalnız sunum): ana durum satırı, ikincil dil satırı, saat.
const LEAD: React.CSSProperties = {
  fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)",
  fontWeight: 700,
  letterSpacing: "-0.02em",
  lineHeight: 1.25,
  margin: "0 0 0.4rem",
};
const LEAD_EN: React.CSSProperties = {
  fontSize: "clamp(1.15rem, 3vw, 1.6rem)",
  lineHeight: 1.3,
  margin: "0 0 0.9rem",
};
const BODY_BIG: React.CSSProperties = {
  fontSize: "clamp(1rem, 2.4vw, 1.25rem)",
  lineHeight: 1.45,
  margin: "0.35rem 0",
};

export default function SinifDersiPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [status, setStatus] = useState<ClassStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoadError(null);
    try {
      setStatus(await trpc.session.getClassStatus.query({ token }));
    } catch (err) {
      setStatus(null);
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    // Ders başlangıcını beklerken hafif yoklama: 15 sn'de bir durum tazelenir.
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) return <main className="muted">Yükleniyor… / Loading…</main>;

  if (!status) {
    return (
      <main style={{ textAlign: "center" }}>
        <h1>Sınıf dersi / Class lesson</h1>
        <div className="card" style={{ padding: "2rem 1.6rem" }}>
          <p style={BODY_BIG}>
            Bu ders bağlantısı kullanılamıyor: geçersiz ya da süresi dolmuş olabilir.
          </p>
          <p className="muted" style={BODY_BIG}>
            This lesson link cannot be used: it may be invalid or expired.
          </p>
          <p style={{ ...BODY_BIG, marginBottom: 0 }}>
            <a href="/egitmen/link">Bağlantınızı mı kaybettiniz? / Lost your link? →</a>
          </p>
          {loadError ? <p className="muted">Ayrıntı / Details: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  const startsAt = new Date(status.startsAt);

  return (
    <main style={{ textAlign: "center" }}>
      <h1 style={{ fontSize: "clamp(2.1rem, 6vw, 3.2rem)", marginBottom: "1.3rem" }}>
        {status.className}
      </h1>
      <div className="card" style={{ padding: "2.4rem 1.8rem" }}>
        {status.ended ? (
          <>
            <p style={LEAD}>Ders sona erdi. Katıldığınız için teşekkürler!</p>
            <p className="muted" style={{ ...LEAD_EN, marginBottom: 0 }}>
              The lesson has ended. Thank you for joining!
            </p>
          </>
        ) : status.started ? (
          <>
            <p style={{ ...LEAD, color: "var(--ok)" }}>Ders başladı!</p>
            <p style={{ ...LEAD_EN, color: "var(--ok)" }}>The lesson has started!</p>
            {status.lessonLink ? (
              <p style={{ margin: "1.1rem 0 0" }}>
                <a
                  href={status.lessonLink}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: "inline-block",
                    fontWeight: 700,
                    fontSize: "clamp(1.15rem, 3vw, 1.7rem)",
                    padding: "0.85rem 2rem",
                    borderRadius: "999px",
                    color: "#fff",
                    textDecoration: "none",
                    background: "linear-gradient(180deg, var(--accent) 0%, var(--accent-deep) 100%)",
                  }}
                >
                  Derse katıl / Join the video call →
                </a>
              </p>
            ) : (
              <>
                <p className="muted" style={BODY_BIG}>
                  Eğitmeniniz sizi bekliyor. (Canlı ders bağlantısı yakında burada otomatik
                  açılacak.)
                </p>
                <p className="muted" style={{ ...BODY_BIG, marginBottom: 0 }}>
                  Your teacher is waiting for you. (The live lesson link will open here
                  automatically soon.)
                </p>
              </>
            )}
          </>
        ) : (
          <>
            <p style={LEAD}>Ders bekleniyor…</p>
            <p className="muted" style={LEAD_EN}>Waiting for the lesson…</p>
            <p
              style={{
                fontSize: "clamp(1.5rem, 4vw, 2.2rem)",
                fontWeight: 700,
                letterSpacing: "-0.02em",
                fontVariantNumeric: "tabular-nums",
                margin: "0.6rem 0 0.15rem",
              }}
            >
              {formatInSchoolTz(startsAt, "tr-TR", status.schoolTz)}
            </p>
            <p className="muted" style={{ ...BODY_BIG, marginTop: 0 }}>
              Planlanan başlangıç ({status.schoolTz} saati) / Scheduled start:{" "}
              {formatInSchoolTz(startsAt, "en-US", status.schoolTz)} ({status.schoolTz} time)
            </p>
            <p className="muted" style={BODY_BIG}>
              Eğitmen dersi başlattığında bu sayfa kendini yenileyecek.
            </p>
            <p className="muted" style={{ ...BODY_BIG, marginBottom: 0 }}>
              This page will refresh automatically when your teacher starts the lesson.
            </p>
          </>
        )}
      </div>

      <p className="muted" style={BODY_BIG}>
        Sorularınız için / Questions? Contact us: {SUPPORT_EMAIL}
      </p>
    </main>
  );
}
