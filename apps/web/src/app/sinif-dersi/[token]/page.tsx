"use client";

// Sınıf katılım sayfası (public, class token'lı): Faz-1'de yalnız durum ekranı —
// sınıf adı + "ders başladı / bekleniyor". PII yok, fiyat yok.
// DİL: İKİ DİLLİ (kısa Türkçe + İngilizce) — sayfa okul/öğrenci projeksiyonuna açılıyor;
// ders İngilizce, sınıf Türkiye'de. Tarihler iki formatta basılır (tr-TR + en-US).
// NOT: SuperClass entegrasyonu geldiğinde bu sayfa (veya /join ucu) provider'ın
// canlı ders URL'sine 302 yönlendirecek; token akışı değişmeden kalır.
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { errorMessage, trpc } from "../../../lib/trpc";

interface ClassStatus {
  className: string;
  startsAt: Date;
  started: boolean;
  ended: boolean;
}

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
      <main>
        <h1>Sınıf dersi / Class lesson</h1>
        <div className="card">
          <p className="muted">
            Bu ders bağlantısı kullanılamıyor: geçersiz ya da süresi dolmuş olabilir.
          </p>
          <p className="muted">
            This lesson link cannot be used: it may be invalid or expired.
          </p>
          {loadError ? <p className="muted">Ayrıntı / Details: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  const startsAt = new Date(status.startsAt);

  return (
    <main>
      <h1>{status.className}</h1>
      <div className="card">
        {status.ended ? (
          <>
            <p>Ders sona erdi. Katıldığınız için teşekkürler!</p>
            <p className="muted">The lesson has ended. Thank you for joining!</p>
          </>
        ) : status.started ? (
          <>
            <p className="success">Ders başladı! / The lesson has started!</p>
            <p className="muted">
              Eğitmeniniz sizi bekliyor. (Canlı ders bağlantısı yakında burada otomatik
              açılacak.)
            </p>
            <p className="muted">
              Your teacher is waiting for you. (The live lesson link will open here
              automatically soon.)
            </p>
          </>
        ) : (
          <>
            <p>Ders bekleniyor… / Waiting for the lesson…</p>
            <p className="muted">
              Planlanan başlangıç: {startsAt.toLocaleString("tr-TR")}. Eğitmen dersi
              başlattığında bu sayfa kendini yenileyecek.
            </p>
            <p className="muted">
              Scheduled start: {startsAt.toLocaleString("en-US")}. This page will refresh
              automatically when your teacher starts the lesson.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
