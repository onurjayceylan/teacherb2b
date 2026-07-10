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

export default function OkulPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
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

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const meData = await trpc.me.get.query();
      setMe(meData);
      if (meData.schools.length > 0) {
        const [bal, accounts] = await Promise.all([
          trpc.wallet.balance.query(),
          trpc.topup.listBankAccounts.query(),
        ]);
        setBalance(bal);
        setBankAccounts(accounts);
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
    </main>
  );
}
