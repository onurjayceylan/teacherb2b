"use client";

// Sınıf katılım sayfası (public, class token'lı): Faz-1'de yalnız durum ekranı —
// sınıf adı + "ders başladı / bekleniyor". PII yok, fiyat yok.
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

  if (loading) return <main className="muted">Yükleniyor…</main>;

  if (!status) {
    return (
      <main>
        <h1>Sınıf dersi</h1>
        <div className="card">
          <p className="muted">
            Bu ders bağlantısı kullanılamıyor: geçersiz ya da süresi dolmuş olabilir.
          </p>
          {loadError ? <p className="muted">Ayrıntı: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>{status.className}</h1>
      <div className="card">
        {status.ended ? (
          <p>Ders sona erdi. Katıldığınız için teşekkürler!</p>
        ) : status.started ? (
          <>
            <p className="success">Ders başladı!</p>
            <p className="muted">
              Eğitmeniniz sizi bekliyor. (Canlı ders bağlantısı yakında burada otomatik
              açılacak.)
            </p>
          </>
        ) : (
          <>
            <p>Ders bekleniyor…</p>
            <p className="muted">
              Planlanan başlangıç: {new Date(status.startsAt).toLocaleString("tr-TR")}. Eğitmen
              dersi başlattığında bu sayfa kendini yenileyecek.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
