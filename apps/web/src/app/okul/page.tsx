"use client";

// Okul paneli: bakiye + kart top-up (Stripe Checkout) + havale akışı (referans kodu).
import { useCallback, useEffect, useState } from "react";
import { errorMessage, formatCents, trpc } from "../../lib/trpc";

interface Me {
  email: string;
  isPlatformAdmin: boolean;
  schools: { id: string; name: string }[];
  activeSchoolId: string | null;
  stripeConfigured: boolean;
}

interface Balance {
  balanceCents: number;
  currency: string;
}

interface Runway {
  committedCents: number;
  weeklyAvgCents: number;
  weeks: number | null;
}

interface BankAccount {
  id: string;
  label: string;
  rail: "eft_tr" | "swift_usd";
  currency: string;
  holder: string;
  iban: string;
  bankName: string;
  swiftBic: string | null;
}

interface BankRef {
  id: string;
  referenceCode: string;
}

interface PendingBankTopup {
  id: string;
  amountCents: number;
  currency: string;
  referenceCode: string | null;
  createdAt: Date;
}

export default function OkulPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [runway, setRunway] = useState<Runway | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [cardAmount, setCardAmount] = useState("100");
  const [cardBusy, setCardBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  const [bankAmount, setBankAmount] = useState("100");
  const [bankAccountId, setBankAccountId] = useState("");
  const [bankBusy, setBankBusy] = useState(false);
  const [bankError, setBankError] = useState<string | null>(null);
  const [bankRef, setBankRef] = useState<BankRef | null>(null);
  const [pendingTopups, setPendingTopups] = useState<PendingBankTopup[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const meData = await trpc.me.get.query();
      setMe(meData);
      if (meData.schools.length > 0) {
        const [bal, rw, accounts, pending] = await Promise.all([
          trpc.wallet.balance.query(),
          trpc.wallet.runway.query(),
          trpc.topup.listBankAccounts.query(),
          trpc.topup.listPendingBank.query(),
        ]);
        setBalance(bal);
        setRunway(rw);
        setBankAccounts(accounts);
        setPendingTopups(pending);
      }
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function parseAmountCents(value: string): number | null {
    const amount = Number(value.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return Math.round(amount * 100);
  }

  async function startCardCheckout() {
    const amountCents = parseAmountCents(cardAmount);
    if (!amountCents) {
      setCardError("Geçerli bir tutar girin");
      return;
    }
    setCardBusy(true);
    setCardError(null);
    try {
      const res = await trpc.topup.createCardCheckout.mutate({ amountCents });
      window.location.href = res.url;
    } catch (err) {
      setCardError(errorMessage(err));
    } finally {
      setCardBusy(false);
    }
  }

  async function createBankTopup(e: React.FormEvent) {
    e.preventDefault();
    const amountCents = parseAmountCents(bankAmount);
    if (!amountCents) {
      setBankError("Geçerli bir tutar girin");
      return;
    }
    setBankBusy(true);
    setBankError(null);
    try {
      const res = await trpc.topup.createBank.mutate({
        amountCents,
        ...(bankAccountId ? { bankAccountId } : {}),
      });
      setBankRef(res);
      // Yeni talep bekleyenler listesine anında düşsün (aynı sayfadaki kart).
      setPendingTopups(await trpc.topup.listPendingBank.query());
    } catch (err) {
      setBankError(errorMessage(err));
    } finally {
      setBankBusy(false);
    }
  }

  if (loading) return <main className="muted">Yükleniyor…</main>;

  if (loadError) {
    return (
      <main>
        <h1>Okul paneli</h1>
        <div className="card">
          <p className="error">{loadError}</p>
          <p className="muted">
            Oturum açmadıysanız <a href="/">giriş sayfasına</a> dönün.
          </p>
        </div>
      </main>
    );
  }

  const school = me?.schools.find((s) => s.id === me.activeSchoolId) ?? me?.schools[0];
  if (!me || !school) {
    return (
      <main>
        <h1>Okul paneli</h1>
        <div className="card">
          <p>Henüz bir okulunuz yok.</p>
          <p className="muted">
            Başlamak için <a href="/kayit">okul kaydını</a> tamamlayın.
          </p>
        </div>
      </main>
    );
  }

  const selectedInstructions = bankRef
    ? bankAccounts.filter((a) => !bankAccountId || a.id === bankAccountId)
    : [];

  async function switchSchool(schoolId: string) {
    // Cookie yalnız tercih; yetki sunucuda üyelikle yeniden doğrulanır.
    const res = await fetch("/api/active-school", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schoolId }),
    });
    if (res.ok) await load();
  }

  return (
    <main>
      <h1>{school.name}</h1>
      <p className="muted">
        <a href="/okul/siniflar">Sınıflar ve öğrenciler (roster) →</a>
        {" · "}
        <a href="/okul/program">Ders programı (reçeteler ve slotlar) →</a>
        {" · "}
        <a href="/okul/ekstre">Hesap ekstresi →</a>
      </p>
      {me.schools.length > 1 ? (
        <p>
          <label htmlFor="school-switch" className="muted">
            Aktif okul:{" "}
          </label>
          <select
            id="school-switch"
            value={school.id}
            onChange={(e) => void switchSchool(e.target.value)}
          >
            {me.schools.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </p>
      ) : null}

      <div className="card">
        <h2>Cüzdan bakiyesi</h2>
        <p className="balance">
          {balance ? formatCents(balance.balanceCents, balance.currency) : "—"}
        </p>
        <p className="muted">Bakiye yalnız kesinleşmiş (settle edilmiş) yüklemeleri içerir.</p>
        {runway && runway.weeks !== null ? (
          // Runway: önümüzdeki 28 günün taahhüdü (tutarları zaten rezervde) + serbest bakiye,
          // haftalık ortalamaya bölünür. Haftalık taahhüt yoksa gösterge gizli.
          <>
            <div className="stat-grid" style={{ marginTop: "0.9rem" }}>
              <div className={`stat${runway.weeks < 2 ? " alert" : ""}`}>
                <div className="k">Tahmini runway</div>
                <div className="v">{runway.weeks} hafta</div>
              </div>
              <div className="stat">
                <div className="k">28 günlük rezerv</div>
                <div className="v">{formatCents(runway.committedCents)}</div>
              </div>
              <div className="stat">
                <div className="k">Haftalık ortalama</div>
                <div className="v">{formatCents(runway.weeklyAvgCents)}</div>
              </div>
            </div>
            <p className="muted" style={{ marginTop: "0.6rem" }}>
              Bakiye + mevcut rezervlerle yaklaşık <strong>{runway.weeks} hafta</strong> taahhüt
              karşılanıyor (önümüzdeki 28 günde {formatCents(runway.committedCents)} planlı ders).
            </p>
          </>
        ) : null}
      </div>

      <div className="card">
        <h2>Kartla bakiye yükle</h2>
        <div className="row">
          <div>
            <label htmlFor="card-amount">Tutar (USD)</label>
            <input
              id="card-amount"
              inputMode="decimal"
              value={cardAmount}
              onChange={(e) => setCardAmount(e.target.value)}
              disabled={!me.stripeConfigured}
            />
          </div>
          <div>
            <button onClick={() => void startCardCheckout()} disabled={!me.stripeConfigured || cardBusy}>
              {cardBusy ? "Yönlendiriliyor…" : "Kartla öde"}
            </button>
          </div>
        </div>
        {!me.stripeConfigured ? (
          <p className="muted">
            Kart ödemesi henüz yapılandırılmadı (STRIPE_SECRET_KEY tanımlı değil). Şimdilik banka
            havalesi kullanın.
          </p>
        ) : null}
        {cardError ? <p className="error">{cardError}</p> : null}
      </div>

      <div className="card">
        <h2>Banka havalesi ile yükle</h2>
        <form onSubmit={createBankTopup}>
          <div className="row">
            <div>
              <label htmlFor="bank-amount">Tutar (USD)</label>
              <input
                id="bank-amount"
                inputMode="decimal"
                value={bankAmount}
                onChange={(e) => setBankAmount(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="bank-account">Hedef hesap (opsiyonel)</label>
              <select
                id="bank-account"
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
              >
                <option value="">Seçim yok</option>
                {bankAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} ({a.rail === "eft_tr" ? "EFT / TL" : "SWIFT / USD"})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <button type="submit" disabled={bankBusy}>
                {bankBusy ? "Oluşturuluyor…" : "Referans kodu al"}
              </button>
            </div>
          </div>
          {bankError ? <p className="error">{bankError}</p> : null}
        </form>

        {bankRef ? (
          <div>
            <p className="success">
              Havale talebi oluşturuldu. Açıklama alanına şu referans kodunu yazın:{" "}
              <strong className="mono">{bankRef.referenceCode}</strong>
            </p>
            {(selectedInstructions.length > 0 ? selectedInstructions : bankAccounts).map((a) => (
              <div key={a.id} style={{ marginTop: "0.75rem" }}>
                <strong>{a.label}</strong>{" "}
                <span className="muted">({a.rail === "eft_tr" ? "EFT / TL" : "SWIFT / USD"})</span>
                <div className="table-wrap" style={{ marginTop: "0.4rem" }}>
                  <table>
                    <tbody>
                      <tr>
                        <th>Alıcı</th>
                        <td>{a.holder}</td>
                      </tr>
                      <tr>
                        <th>IBAN</th>
                        <td className="mono">{a.iban}</td>
                      </tr>
                      <tr>
                        <th>Banka</th>
                        <td>{a.bankName}</td>
                      </tr>
                      {a.swiftBic ? (
                        <tr>
                          <th>SWIFT/BIC</th>
                          <td className="mono">{a.swiftBic}</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {bankAccounts.length === 0 ? (
              <p className="muted">
                Henüz tanımlı banka hesabı yok — talimatlar platform yöneticisi hesap ekleyince
                burada görünür.
              </p>
            ) : null}
            <p className="muted">
              Havaleniz alındıktan sonra platform yöneticisi onaylayınca bakiyenize yansır.
            </p>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h2>Bekleyen havaleleriniz</h2>
        {pendingTopups.length === 0 ? (
          <div className="empty">Bekleyen havale talebi yok.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Referans kodu</th>
                  <th>Tutar</th>
                  <th>Talep tarihi</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {pendingTopups.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <strong className="mono">{t.referenceCode ?? "—"}</strong>
                    </td>
                    <td>{formatCents(t.amountCents, t.currency)}</td>
                    <td>{new Date(t.createdAt).toLocaleString("tr-TR")}</td>
                    <td>
                      <span className="badge warn">onay bekliyor</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* Denetim tur 3: hedef IBAN yalnız kod-alma ânında görünüyordu; bekleyen havalesi olan
            okul "hangi hesaba?" cevabını burada da bulmalı. */}
        {pendingTopups.length > 0 ? (
          bankAccounts.length > 0 ? (
            <div style={{ marginTop: "0.5rem" }}>
              <p className="muted" style={{ marginBottom: "0.25rem" }}>
                Havaleyi şu hesaplardan birine gönderin (açıklamaya referans kodunu yazın):
              </p>
              <ul>
                {bankAccounts.map((a) => (
                  <li key={a.id}>
                    <strong>{a.bankName}</strong> · {a.holder} — IBAN{" "}
                    <span className="mono">{a.iban}</span>
                    {a.swiftBic ? (
                      <>
                        {" "}
                        · SWIFT <span className="mono">{a.swiftBic}</span>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="muted">
              Hedef hesap bilgisi henüz tanımlı değil — platform yöneticisiyle iletişime geçin.
            </p>
          )
        ) : null}
        <p className="muted">
          Dekontun açıklama alanına TN- ile başlayan referans kodunu mutlaka yazın — eşleştirme bu
          kodla yapılır. USD hesabına TL gönderirseniz bankanın uyguladığı kur geçerli olur;
          bakiyenize geçen tutar kur farkı nedeniyle talep ettiğinizden farklı olabilir.
        </p>
      </div>
    </main>
  );
}
