"use client";

// Panel linki self-yenileme (public, denetim P2): e-posta gir → requestPortalLink.
// Varlık SIZDIRMAZ: kayıtlı olsun olmasın AYNI mesaj gösterilir; kayıtlıysa outbox'a
// teacher_portal e-postası düşer (15dk rate-limit sunucuda).
// DİL: EĞİTMEN YÜZÜ İNGİLİZCE — hedef arz native ESL, Türkçe anlamıyor.
import { useState } from "react";
import { errorMessage, trpc } from "../../../lib/trpc";

export default function EgitmenLinkPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await trpc.teacherPortal.requestLink.mutate({ email: email.trim() });
      setSent(true);
    } catch (err) {
      // Yalnız girdi/ağ hataları buraya düşer — sunucu varlık bilgisi döndürmez.
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Get a new panel link</h1>
      <div className="card">
        {sent ? (
          <>
            <p className="success">
              If this email is registered, a new panel link has been sent.
            </p>
            <p className="muted">
              Please check your inbox (and spam folder). You can request another link in a few
              minutes if it does not arrive.
            </p>
          </>
        ) : (
          <>
            <p className="muted">
              Lost your teacher panel link? Enter the email address you use with Teachernow and
              we will send you a new one.
            </p>
            <form onSubmit={submit}>
              <div className="row">
                <div>
                  <label htmlFor="tl-email">Your email address</label>
                  <input
                    id="tl-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                  />
                </div>
                <div>
                  <button type="submit" disabled={busy}>
                    {busy ? "Sending…" : "Send me a new link"}
                  </button>
                </div>
              </div>
            </form>
            {error ? <p className="error">{error}</p> : null}
          </>
        )}
      </div>
    </main>
  );
}
