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
      <h1>{mode === "signin" ? "Giriş yap" : "Hesap oluştur"}</h1>

      {!isPending && session ? (
        <div className="card">
          <p>
            Oturum açık: <strong>{session.user.email}</strong>
          </p>
          <button onClick={() => router.push("/okul")}>Okul paneline git</button>{" "}
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
      ) : null}

      <div className="card">
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
          <button type="submit" disabled={busy}>
            {busy ? "Bekleyin…" : mode === "signin" ? "Giriş yap" : "Kayıt ol"}
          </button>{" "}
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
        </form>
      </div>

      <p className="muted">
        Girişten sonra okulunuz yoksa <a href="/baslangic">başlangıç sihirbazı</a> ile devam edin.
      </p>
    </main>
  );
}
