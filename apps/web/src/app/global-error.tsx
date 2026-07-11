"use client";

// Kök layout çökerse devreye giren SON savunma hattı. Bilinçli olarak minimal ve
// bağımsız: globals.css ve lib/trpc dahil hiçbir uygulama modülü import edilmez —
// onları yükleyen kod da çökmüş olabilir. Kendi <html>/<body>'sini render etmek zorunda.
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Client crash sunucuda görünmez — digest'i client konsoluna bırak (PII değil).
    console.error("global-error digest:", error.digest ?? "(digest yok)");
  }, [error]);

  return (
    <html lang="tr">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "3rem 1.5rem" }}>
        <main style={{ maxWidth: "36rem", margin: "0 auto" }}>
          <h1 style={{ fontSize: "1.3rem" }}>Uygulama hatası</h1>
          <p>Beklenmeyen bir hata oluştu; sayfa görüntülenemiyor. Yeniden deneyin.</p>
          {error.digest ? (
            <p style={{ color: "#66707d", fontSize: "0.9rem" }}>
              Destek için hata kodu:{" "}
              <span style={{ fontFamily: "ui-monospace, monospace" }}>{error.digest}</span>
            </p>
          ) : null}
          <button
            onClick={() => reset()}
            style={{
              padding: "0.5rem 1.1rem",
              border: "none",
              borderRadius: 8,
              background: "#2456d6",
              color: "#fff",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Yeniden dene
          </button>
        </main>
      </body>
    </html>
  );
}
