"use client";

// Giriş + kayıt: better-auth e-posta/parola. Başarıda /okul'a yönlendirir.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "../lib/auth-client";

export default function HomePage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "signin"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name });
      if (result.error) {
        setError(result.error.message ?? "işlem başarısız");
        return;
      }
      // Yeni hesap → başlangıç sihirbazı (kayıt→ilk reçete <15 dk); mevcut hesap → panel.
      router.push(mode === "signup" ? "/baslangic" : "/okul");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <section className="hero">
        <h1>Okulunuz için native speaking club dersleri</h1>
        <p>
          Doğrulanmış eğitmen havuzu, otomatik ders planlama ve tek panelden yönetim — kayıttan
          ilk ders reçetenize 15 dakikada ulaşın.
        </p>
      </section>

      {!isPending && session ? (
        <div className="card">
          <h2>Oturum açık</h2>
          <p>
            <strong>{session.user.email}</strong> olarak giriş yaptınız.
          </p>
          <div className="actions" style={{ marginTop: "0.9rem" }}>
            <button onClick={() => router.push("/okul")}>Okul paneline git</button>
            <button
              className="secondary"
              onClick={async () => {
                await authClient.signOut();
                router.refresh();
              }}
            >
              Çıkış yap
            </button>
          </div>
        </div>
      ) : null}

      <div className="card">
        <h2>{mode === "signin" ? "Giriş yap" : "Hesap oluştur"}</h2>
        <form onSubmit={submit}>
          {mode === "signup" ? (
            <>
              <label htmlFor="name">Ad Soyad</label>
              <input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
              />
            </>
          ) : null}
          <label htmlFor="email">E-posta</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <label htmlFor="password">Parola</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
          />
          {error ? <p className="error">{error}</p> : null}
          <div className="actions" style={{ marginTop: "0.9rem" }}>
            <button type="submit" disabled={busy}>
              {busy ? "Bekleyin…" : mode === "signin" ? "Giriş yap" : "Kayıt ol"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
              }}
            >
              {mode === "signin" ? "Hesabın yok mu? Kayıt ol" : "Zaten üye misin? Giriş yap"}
            </button>
          </div>
        </form>
      </div>

      <div className="stat-grid" style={{ marginBottom: "1.15rem" }}>
        <div className="stat">
          <div className="k">Doğrulanmış eğitmenler</div>
          <p className="muted" style={{ margin: "0.4rem 0 0" }}>
            Evrak kontrolü ve görüşme sürecinden geçmiş native eğitmen havuzu.
          </p>
        </div>
        <div className="stat">
          <div className="k">Otomatik planlama</div>
          <p className="muted" style={{ margin: "0.4rem 0 0" }}>
            Haftalık reçeteniz derslere dönüşür; eğitmen araması kendiliğinden başlar.
          </p>
        </div>
        <div className="stat">
          <div className="k">SLA garantili yedekleme</div>
          <p className="muted" style={{ margin: "0.4rem 0 0" }}>
            Eğitmen düşerse sistem yeniden eğitmen arar; karşılanamayan dersin ücreti iade edilir.
          </p>
        </div>
      </div>

      <p className="muted" style={{ textAlign: "center" }}>
        Girişten sonra okulunuz yoksa <a href="/baslangic">başlangıç sihirbazı</a> ile devam edin.
      </p>
    </main>
  );
}
