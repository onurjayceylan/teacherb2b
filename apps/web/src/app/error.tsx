"use client";

// Global hata sınırı (route segment'leri için). Sert kısıt: client crash sunucuda
// GÖRÜNMEZ — bu yüzden digest client konsoluna loglanır ki kullanıcı destek talebinde
// kodu iletebilsin. Yalnız digest loglanır; hata mesajı PII içerebileceğinden konsola
// basılmaz (kullanıcıya ekranda errorMessage ile gösterilir — kendi hatasıdır).
import { useEffect } from "react";
import { errorMessage } from "../lib/trpc";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("client-error digest:", error.digest ?? "(digest yok)");
  }, [error]);

  return (
    <main>
      <h1>Bir şeyler ters gitti</h1>
      <div className="card">
        <p>
          Beklenmeyen bir hata oluştu. Sayfayı yeniden deneyebilir ya da ana sayfaya
          dönebilirsiniz — verileriniz güvende.
        </p>
        <p className="muted">{errorMessage(error)}</p>
        {error.digest ? (
          <p className="muted">
            Destek için hata kodu: <span className="mono">{error.digest}</span>
          </p>
        ) : null}
        <div className="actions" style={{ marginTop: "0.9rem" }}>
          <button onClick={() => reset()}>Yeniden dene</button>
          <button className="secondary" onClick={() => (window.location.href = "/")}>
            Ana sayfaya dön
          </button>
        </div>
      </div>
    </main>
  );
}
