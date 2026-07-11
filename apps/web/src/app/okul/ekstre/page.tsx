"use client";

// Okul ekstresi: seçilen ayın ledger hareketleri (nakit + rezerv) tarih sıralı,
// akan bakiye ve dönem toplamlarıyla. Satır etiketi hesap türü + tutar işaretinden
// türetilir — okul, işlem tipi ayrıntısına (ledger_transaction) bilinçli olarak erişmez.
import { useCallback, useEffect, useState } from "react";
import { errorMessage, formatCents, trpc } from "../../../lib/trpc";

interface StatementRow {
  id: string;
  txnId: string;
  createdAt: Date;
  kind: string;
  label: string;
  amountCents: number;
  currency: string;
  balanceCents: number;
}

interface Statement {
  from: string;
  to: string;
  openingBalanceCents: number;
  closingBalanceCents: number;
  totals: { inflowCents: number; outflowCents: number; reserveNetCents: number };
  rows: StatementRow[];
}

/** "YYYY-AA" ay değerini [ilk gün, son gün] aralığına çevirir. */
function monthToRange(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const lastDay = new Date(y, mo, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { from: `${y}-${pad(mo)}-01`, to: `${y}-${pad(mo)}-${pad(lastDay)}` };
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function EkstrePage() {
  const [month, setMonth] = useState(currentMonth());
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (m: string) => {
    const range = monthToRange(m);
    if (!range) return;
    setLoading(true);
    setLoadError(null);
    try {
      setStatement(await trpc.wallet.statement.query(range));
    } catch (err) {
      setStatement(null);
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(month);
  }, [month, load]);

  return (
    <main>
      <h1>Hesap ekstresi</h1>
      <p className="muted">
        <a href="/okul">← Okul paneline dön</a>
      </p>

      <div className="card">
        <div className="row">
          <div>
            <label htmlFor="ek-month">Ay</label>
            <input
              id="ek-month"
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </div>
        </div>
      </div>

      {loading ? <p className="muted">Yükleniyor…</p> : null}
      {loadError ? (
        <div className="card">
          <p className="error">{loadError}</p>
          <p className="muted">
            Okul üyeliğiniz yoksa önce <a href="/kayit">okul kaydını</a> tamamlayın.
          </p>
        </div>
      ) : null}

      {statement ? (
        <>
          <div className="card">
            <h2>
              Dönem toplamları — {statement.from} → {statement.to}
            </h2>
            <table>
              <tbody>
                <tr>
                  <th>Dönem başı bakiye</th>
                  <td>{formatCents(statement.openingBalanceCents)}</td>
                </tr>
                <tr>
                  <th>Yüklemeler + iadeler</th>
                  <td>+{formatCents(statement.totals.inflowCents)}</td>
                </tr>
                <tr>
                  <th>Ders düşümleri / kesintiler</th>
                  <td>-{formatCents(statement.totals.outflowCents)}</td>
                </tr>
                <tr>
                  <th>Rezerv net değişimi</th>
                  <td>
                    {statement.totals.reserveNetCents >= 0 ? "+" : "-"}
                    {formatCents(Math.abs(statement.totals.reserveNetCents))}
                  </td>
                </tr>
                <tr>
                  <th>Dönem sonu bakiye</th>
                  <td>
                    <strong>{formatCents(statement.closingBalanceCents)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="muted">
              Rezerv: planlanan derslerin ücretleri ders yapılana (ya da iptal edilene) kadar
              bakiyenizden ayrılır; akan bakiye yalnız nakit hesabınızı izler.
            </p>
          </div>

          <div className="card">
            <h2>Hareketler</h2>
            {statement.rows.length === 0 ? (
              <p className="muted">Bu dönemde hareket yok.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Tarih</th>
                      <th>İşlem</th>
                      <th>Tutar</th>
                      <th>Bakiye</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.rows.map((r) => (
                      <tr key={r.id}>
                        <td>{new Date(r.createdAt).toLocaleString("tr-TR")}</td>
                        <td>
                          <span className={`badge ${r.kind === "wallet_hold" ? "warn" : "ok"}`}>
                            {r.label}
                          </span>
                        </td>
                        <td>
                          {r.amountCents >= 0 ? "+" : "-"}
                          {formatCents(Math.abs(r.amountCents), r.currency)}
                        </td>
                        <td>{formatCents(r.balanceCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </main>
  );
}
