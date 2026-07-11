"use client";

// Kök layout çökerse devreye giren SON savunma hattı. Bilinçli olarak minimal ve
// bağımsız: globals.css ve lib/trpc dahil hiçbir uygulama modülü import edilmez —
// onları yükleyen kod da çökmüş olabilir. Kendi <html>/<body>'sini render etmek zorunda;
// liquid-glass görünümü bu yüzden satır içi stille (globals.css'in kopyası değil, yankısı).
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
      <body
        style={{
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, Roboto, sans-serif',
          margin: 0,
          padding: "4rem 1.5rem",
          minHeight: "100vh",
          color: "#16181d",
          backgroundColor: "#f4f5f9",
          backgroundImage:
            "radial-gradient(52rem 36rem at 12% -6%, rgba(96,156,255,0.2), transparent 62%)," +
            "radial-gradient(44rem 30rem at 96% 4%, rgba(255,158,214,0.14), transparent 60%)",
        }}
      >
        <main
          style={{
            maxWidth: "26rem",
            margin: "0 auto",
            textAlign: "center",
            background: "rgba(255,255,255,0.72)",
            border: "1px solid rgba(255,255,255,0.65)",
            borderRadius: 22,
            padding: "2rem 1.6rem",
            boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 10px 30px rgba(16,24,40,0.07)",
          }}
        >
          <h1 style={{ fontSize: "1.3rem", letterSpacing: "-0.02em", margin: "0 0 0.6rem" }}>
            Uygulama hatası
          </h1>
          <p style={{ margin: "0 0 0.8rem" }}>
            Beklenmeyen bir hata oluştu; sayfa görüntülenemiyor. Yeniden deneyin.
          </p>
          {error.digest ? (
            <p style={{ color: "#6b7280", fontSize: "0.9rem", margin: "0 0 1rem" }}>
              Destek için hata kodu:{" "}
              <span style={{ fontFamily: "ui-monospace, monospace" }}>{error.digest}</span>
            </p>
          ) : null}
          <button
            onClick={() => reset()}
            style={{
              padding: "0.55rem 1.3rem",
              border: "none",
              borderRadius: 11,
              background: "linear-gradient(180deg, #2f97ff, #0a7cff 78%)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.32), 0 2px 8px rgba(10,124,255,0.3)",
              color: "#fff",
              fontWeight: 600,
              fontSize: "0.93rem",
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
