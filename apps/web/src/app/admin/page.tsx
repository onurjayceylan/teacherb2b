"use client";

// Platform admin paneli: bekleyen havaleler + settle, banka hesapları, payments_frozen anahtarı.
// Sayfa herkese yüklenir; admin olmayan aktörün tüm çağrıları sunucuda FORBIDDEN ile düşer.
import { useCallback, useEffect, useState } from "react";
import { errorMessage, formatCents, trpc } from "../../lib/trpc";

interface PendingTopup {
  id: string;
  schoolName: string;
  amountCents: number;
  currency: string;
  referenceCode: string | null;
  createdAt: Date;
}

interface AdminBankAccount {
  id: string;
  label: string;
  rail: "eft_tr" | "swift_usd";
  currency: string;
  holder: string;
  iban: string;
  bankName: string;
  swiftBic: string | null;
  active: boolean;
}

const EMPTY_FORM = {
  label: "",
  rail: "eft_tr" as "eft_tr" | "swift_usd",
  currency: "TRY",
  holder: "",
  iban: "",
  bank_name: "",
  swift_bic: "",
};

export default function AdminPage() {
  const [pending, setPending] = useState<PendingTopup[]>([]);
  const [accounts, setAccounts] = useState<AdminBankAccount[]>([]);
  const [frozen, setFrozen] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [pendingRes, accountsRes, frozenRes] = await Promise.all([
        trpc.admin.listPendingTopups.query(),
        trpc.admin.listBankAccounts.query(),
        trpc.admin.paymentsFrozen.query(),
      ]);
      setPending(pendingRes);
      setAccounts(accountsRes);
      setFrozen(frozenRes.frozen);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, successMsg: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      setNotice(successMsg);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="muted">Yükleniyor…</main>;

  if (loadError) {
    return (
      <main>
        <h1>Platform yönetimi</h1>
        <div className="card">
          <p className="error">{loadError}</p>
          <p className="muted">Bu sayfa yalnız platform yöneticileri içindir.</p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Platform yönetimi</h1>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      <div className="card">
        <h2>Ödeme kill-switch</h2>
        <p>
          payments_frozen:{" "}
          {frozen ? (
            <span className="badge warn">DONDURULDU</span>
          ) : (
            <span className="badge ok">akış açık</span>
          )}
        </p>
        <button
          disabled={busy || frozen === null}
          onClick={() =>
            void run(
              () => trpc.admin.setPaymentsFrozen.mutate({ frozen: !frozen }),
              !frozen ? "Para akışı donduruldu" : "Para akışı yeniden açıldı",
            )
          }
        >
          {frozen ? "Akışı yeniden aç" : "Para akışını dondur"}
        </button>
      </div>

      <div className="card">
        <h2>Bekleyen havale top-up&apos;ları</h2>
        {pending.length === 0 ? (
          <p className="muted">Bekleyen havale yok.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Okul</th>
                <th>Tutar</th>
                <th>Referans</th>
                <th>Tarih</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((t) => (
                <tr key={t.id}>
                  <td>{t.schoolName}</td>
                  <td>{formatCents(t.amountCents, t.currency)}</td>
                  <td className="mono">{t.referenceCode ?? "—"}</td>
                  <td>{new Date(t.createdAt).toLocaleString("tr-TR")}</td>
                  <td>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => trpc.admin.settleBankTopup.mutate({ topupId: t.id }),
                          "Havale settle edildi — bakiye güncellendi",
                        )
                      }
                    >
                      Settle
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Banka hesapları</h2>
        {accounts.length === 0 ? (
          <p className="muted">Tanımlı banka hesabı yok.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Etiket</th>
                <th>Ray</th>
                <th>IBAN</th>
                <th>Durum</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.label}</td>
                  <td>{a.rail === "eft_tr" ? "EFT / TL" : "SWIFT / USD"}</td>
                  <td className="mono">{a.iban}</td>
                  <td>
                    {a.active ? (
                      <span className="badge ok">aktif</span>
                    ) : (
                      <span className="badge warn">pasif</span>
                    )}
                  </td>
                  <td>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            trpc.admin.setBankAccountActive.mutate({
                              id: a.id,
                              active: !a.active,
                            }),
                          a.active ? "Hesap pasifleştirildi" : "Hesap aktifleştirildi",
                        )
                      }
                    >
                      {a.active ? "Pasifleştir" : "Aktifleştir"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2 style={{ marginTop: "1.25rem" }}>Yeni banka hesabı</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await trpc.admin.createBankAccount.mutate({
                label: form.label,
                rail: form.rail,
                currency: form.currency,
                holder: form.holder,
                iban: form.iban,
                bank_name: form.bank_name,
                ...(form.swift_bic ? { swift_bic: form.swift_bic } : {}),
              });
              setForm(EMPTY_FORM);
            }, "Banka hesabı eklendi");
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="ba-label">Etiket</label>
              <input
                id="ba-label"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="ba-rail">Ray</label>
              <select
                id="ba-rail"
                value={form.rail}
                onChange={(e) => {
                  const rail = e.target.value === "swift_usd" ? "swift_usd" : "eft_tr";
                  setForm({ ...form, rail, currency: rail === "eft_tr" ? "TRY" : "USD" });
                }}
              >
                <option value="eft_tr">EFT / TL</option>
                <option value="swift_usd">SWIFT / USD</option>
              </select>
            </div>
            <div>
              <label htmlFor="ba-currency">Para birimi</label>
              <input
                id="ba-currency"
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                required
                maxLength={3}
              />
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="ba-holder">Hesap sahibi</label>
              <input
                id="ba-holder"
                value={form.holder}
                onChange={(e) => setForm({ ...form, holder: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="ba-iban">IBAN</label>
              <input
                id="ba-iban"
                value={form.iban}
                onChange={(e) => setForm({ ...form, iban: e.target.value })}
                required
              />
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="ba-bank">Banka adı</label>
              <input
                id="ba-bank"
                value={form.bank_name}
                onChange={(e) => setForm({ ...form, bank_name: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="ba-swift">SWIFT/BIC (opsiyonel)</label>
              <input
                id="ba-swift"
                value={form.swift_bic}
                onChange={(e) => setForm({ ...form, swift_bic: e.target.value })}
              />
            </div>
          </div>
          <button type="submit" disabled={busy}>
            Hesap ekle
          </button>
        </form>
      </div>
    </main>
  );
}
