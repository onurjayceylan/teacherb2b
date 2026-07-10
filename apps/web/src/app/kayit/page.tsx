"use client";

// Self-serve okul kaydı: onboarding.createSchool → /okul.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage, trpc } from "../../lib/trpc";

export default function KayitPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [country, setCountry] = useState("TR");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await trpc.onboarding.createSchool.mutate({ name, country });
      router.push("/okul");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Okul kaydı</h1>
      <div className="card">
        <form onSubmit={submit}>
          <label htmlFor="school-name">Okul adı</label>
          <input
            id="school-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            placeholder="Örn. Bilge Koleji"
          />
          <label htmlFor="country">Ülke</label>
          <select id="country" value={country} onChange={(e) => setCountry(e.target.value)}>
            <option value="TR">Türkiye</option>
            <option value="US">ABD</option>
            <option value="DE">Almanya</option>
            <option value="GB">Birleşik Krallık</option>
            <option value="AE">BAE</option>
          </select>
          {error ? <p className="error">{error}</p> : null}
          <button type="submit" disabled={busy}>
            {busy ? "Oluşturuluyor…" : "Okulu oluştur"}
          </button>
        </form>
      </div>
      <p className="muted">
        Kayıt, organizasyon + okul + owner üyeliği ve okul cüzdanını birlikte oluşturur. Oturum
        açmadıysanız önce <a href="/">giriş yapın</a>.
      </p>
    </main>
  );
}
