"use client";

// Payout operasyonları (platform admin): dönem batch'i oluştur → CSV'yi Wise'a elle yükle →
// "yükledim" beyanı → Wise sonuç CSV'sini yapıştır → import özeti (paid/failed/warnings).
// Para YALNIZ import'taki 'paid' satırlarında oynar; sayfa herkese yüklenir, admin olmayanın
// tüm çağrıları sunucuda FORBIDDEN ile düşer.
import { useCallback, useEffect, useState } from "react";
import { errorMessage, formatCents, trpc } from "../../../lib/trpc";

interface Batch {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  createdAt: Date;
  payoutCount: number;
  totalCents: number;
  paidCount: number;
  failedCount: number;
  openCount: number;
}

interface RecentPayout {
  id: string;
  batchId: string;
  teacherName: string;
  amountCents: number;
  currency: string;
  status: string;
  failureReason: string | null;
  externalRef: string | null;
  createdAt: Date;
  paidAt: Date | null;
}

interface HeldTeacher {
  teacherId: string;
  fullName: string;
  payableCents: number;
}

interface CreateResult {
  batchId: string;
  payoutCount: number;
  totalCents: number;
  heldTeachers: HeldTeacher[];
}

interface ImportSummary {
  paid: number;
  failed: number;
  warnings: string[];
}

interface SweepResult {
  offered: number;
  reoffered: number;
  escalated: number;
}

interface MissingPayoutTeacher {
  teacherId: string;
  name: string;
  email: string;
}

interface Chargeback {
  id: string;
  disputeId: string;
  paymentIntentId: string | null;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: Date;
  schoolName: string | null;
  open: boolean;
}

interface BalanceSnapshot {
  id: string;
  provider: "stripe" | "wise";
  balanceCents: number;
  currency: string;
  source: string;
  note: string | null;
  capturedAt: Date;
}

interface Reconciliation {
  provider: "stripe" | "wise";
  ledgerExpectedCents: number;
  snapshotCents: number | null;
  snapshotAt: Date | null;
  diffCents: number | null;
}

const CHARGEBACK_STATUS: Record<string, { label: string; ok: boolean }> = {
  needs_response: { label: "yanıt bekliyor", ok: false },
  under_review: { label: "incelemede", ok: false },
  won: { label: "kazanıldı", ok: true },
  lost: { label: "kaybedildi", ok: false },
};

const PROVIDER_LABELS: Record<string, string> = { stripe: "Stripe", wise: "Wise" };

const PAYOUT_STATUS: Record<string, { label: string; ok: boolean }> = {
  pending: { label: "bekliyor", ok: false },
  submitted: { label: "Wise'a yüklendi", ok: false },
  paid: { label: "ödendi", ok: true },
  failed: { label: "başarısız", ok: false },
  cancelled: { label: "iptal", ok: false },
};

const BATCH_STATUS: Record<string, string> = {
  draft: "taslak",
  exported: "export edildi",
  closed: "kapandı",
};

/** Ayın ilk ve son günü (dönem seçicinin varsayılanı: içinde bulunulan ay). */
function monthRange(d: Date): { start: string; end: string } {
  const y = d.getFullYear();
  const m = d.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(y, m + 1, 0).getDate();
  return { start: `${y}-${pad(m + 1)}-01`, end: `${y}-${pad(m + 1)}-${pad(lastDay)}` };
}

export default function OdemelerPage() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [recent, setRecent] = useState<RecentPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const initial = monthRange(new Date());
  const [periodStart, setPeriodStart] = useState(initial.start);
  const [periodEnd, setPeriodEnd] = useState(initial.end);
  const [createResult, setCreateResult] = useState<CreateResult | null>(null);

  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [resultCsv, setResultCsv] = useState("");
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [sweep, setSweep] = useState<SweepResult | null>(null);

  const [missingPayout, setMissingPayout] = useState<MissingPayoutTeacher[]>([]);
  const [chargebacks, setChargebacks] = useState<Chargeback[]>([]);
  const [snapshots, setSnapshots] = useState<BalanceSnapshot[]>([]);
  const [reconciliation, setReconciliation] = useState<Reconciliation[]>([]);
  const [wiseBalance, setWiseBalance] = useState("");
  const [wiseNote, setWiseNote] = useState("");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [batchesRes, recentRes, missingRes, chargebacksRes, balancesRes] = await Promise.all([
        trpc.payouts.listBatches.query(),
        trpc.payouts.listRecent.query(),
        trpc.payouts.missingPayoutDetails.query(),
        trpc.admin.listChargebacks.query(),
        trpc.admin.listExternalBalances.query(),
      ]);
      setBatches(batchesRes);
      setRecent(recentRes);
      setMissingPayout(missingRes);
      setChargebacks(chargebacksRes);
      setSnapshots(balancesRes.snapshots);
      setReconciliation(balancesRes.reconciliation);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, successMsg: string | null) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      if (successMsg) setNotice(successMsg);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function selectBatch(batchId: string | null) {
    setSelectedBatchId(batchId);
    setCsv(null);
    setImportSummary(null);
    setResultCsv("");
    if (!batchId) return;
    try {
      const res = await trpc.payouts.exportCsv.query({ batchId });
      setCsv(res.csv);
    } catch (err) {
      // Kapanmış batch export edilemez — CSV alanı yerine açıklama gösterilir.
      setCsv(null);
      setActionError(errorMessage(err));
    }
  }

  if (loading) return <main className="muted">Yükleniyor…</main>;

  if (loadError) {
    return (
      <main>
        <h1>Ödemeler (payout)</h1>
        <div className="card">
          <p className="error">{loadError}</p>
          <p className="muted">Bu sayfa yalnız platform yöneticileri içindir.</p>
        </div>
      </main>
    );
  }

  const selectedBatch = batches.find((b) => b.id === selectedBatchId) ?? null;
  const csvDataUrl = csv ? `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}` : null;

  return (
    <main>
      <h1>Ödemeler (payout)</h1>
      <p className="muted">
        <a href="/admin">← Platform yönetimine dön</a>
      </p>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      <div className="card">
        <h2>Yeni ödeme dönemi (batch)</h2>
        <p className="muted">
          Dönem içinde settle edilmiş ve daha önce ödenmemiş dersler eğitmen başına tek payout'ta
          toplanır. Evrak seti tamamlanmamış (hard-gate) eğitmenler tutulur ve aşağıda listelenir.
        </p>
        {missingPayout.length > 0 ? (
          <div>
            <p className="error">
              Şu eğitmenlerin ödeme bilgisi eksik; CSV&apos;de boş çıkacak:
            </p>
            <ul>
              {missingPayout.map((t) => (
                <li key={t.teacherId}>
                  {t.name} <span className="muted">({t.email})</span>
                </li>
              ))}
            </ul>
            <p className="muted">
              Eğitmen, panelindeki &quot;Payout details&quot; formundan Wise e-postasını / IBAN&apos;ını
              girebilir.
            </p>
          </div>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const res = await trpc.payouts.createBatch.mutate({ periodStart, periodEnd });
              setCreateResult(res);
              setNotice(
                `Batch oluştu — ${res.payoutCount} payout, toplam ${formatCents(res.totalCents)}`,
              );
              await selectBatch(res.batchId);
            }, null);
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="po-start">Dönem başı</label>
              <input
                id="po-start"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="po-end">Dönem sonu</label>
              <input
                id="po-end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                required
              />
            </div>
            <div>
              <button type="submit" disabled={busy}>
                Batch oluştur
              </button>
            </div>
          </div>
        </form>

        {createResult ? (
          <div style={{ marginTop: "0.75rem" }}>
            <p>
              <strong>{createResult.payoutCount}</strong> payout — toplam{" "}
              <strong>{formatCents(createResult.totalCents)}</strong>
            </p>
            {createResult.heldTeachers.length > 0 ? (
              <div>
                <p className="error">
                  Evrak seti eksik olduğu için ödemesi TUTULAN eğitmenler (hard-gate):
                </p>
                <ul>
                  {createResult.heldTeachers.map((t) => (
                    <li key={t.teacherId}>
                      {t.fullName} — bekleyen alacak {formatCents(t.payableCents)}
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  Evraklar tamamlanıp doğrulanınca alacak bir sonraki batch'te ödenir.
                </p>
              </div>
            ) : (
              <p className="muted">Hard-gate'te tutulan eğitmen yok.</p>
            )}
          </div>
        ) : null}
      </div>

      <div className="card">
        <h2>Batch listesi</h2>
        {batches.length === 0 ? (
          <div className="empty">Henüz batch yok.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dönem</th>
                  <th>Durum</th>
                  <th>Payout</th>
                  <th>Toplam</th>
                  <th>Sonuç</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.periodStart} → {b.periodEnd}
                    </td>
                    <td>
                      <span className={`badge ${b.status === "closed" ? "ok" : "warn"}`}>
                        {BATCH_STATUS[b.status] ?? b.status}
                      </span>
                    </td>
                    <td>{b.payoutCount}</td>
                    <td>{formatCents(b.totalCents)}</td>
                    <td>
                      {b.paidCount > 0 ? <span className="badge ok">{b.paidCount} ödendi</span> : null}{" "}
                      {b.failedCount > 0 ? (
                        <span className="badge warn">{b.failedCount} başarısız</span>
                      ) : null}{" "}
                      {b.openCount > 0 ? <span className="muted">{b.openCount} açık</span> : null}
                    </td>
                    <td>
                      <button
                        className="secondary"
                        style={{ marginTop: 0 }}
                        onClick={() => void selectBatch(b.id === selectedBatchId ? null : b.id)}
                      >
                        {b.id === selectedBatchId ? "Kapat" : "Aç"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedBatch ? (
        <div className="card">
          <h2>
            Batch — {selectedBatch.periodStart} → {selectedBatch.periodEnd}
          </h2>

          <h3>1) Wise CSV&apos;si</h3>
          {csv ? (
            <div>
              <textarea
                readOnly
                value={csv}
                rows={Math.min(10, csv.split("\n").length + 1)}
                style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8rem" }}
              />
              <div className="actions" style={{ marginTop: "0.6rem" }}>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    void navigator.clipboard.writeText(csv).then(
                      () => setNotice("CSV panoya kopyalandı"),
                      () => setActionError("Pano erişimi reddedildi — metni elle seçin"),
                    );
                  }}
                >
                  Kopyala
                </button>
                {csvDataUrl ? (
                  <a href={csvDataUrl} download={`payout-batch-${selectedBatch.id.slice(0, 8)}.csv`}>
                    CSV&apos;yi indir
                  </a>
                ) : null}
              </div>
            </div>
          ) : (
            <p className="muted">
              CSV alınamadı — batch kapanmış olabilir (kapanmış batch yeniden export edilmez).
            </p>
          )}

          <h3 style={{ marginTop: "1rem" }}>2) İnsan beyanı</h3>
          <p className="muted">
            Dosyayı Wise&apos;a yükledikten sonra işaretleyin. Bu adım parayı OYNATMAZ — payout&apos;lar
            yalnız &quot;gönderildi&quot; durumuna geçer.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const res = await trpc.payouts.markSubmitted.mutate({ batchId: selectedBatch.id });
                setNotice(`${res.submitted} payout 'gönderildi' olarak işaretlendi`);
              }, null)
            }
          >
            Wise&apos;a yükledim
          </button>

          <h3 style={{ marginTop: "1rem" }}>3) Wise sonuç dosyası</h3>
          <p className="muted">
            Sonuç CSV&apos;sini yapıştırın (başlık: idempotency_key, external_ref, status,
            failure_reason). Para yalnız &apos;paid&apos; satırlarında işler; aynı dosyanın tekrar
            importu çift ödeme YAPMAZ (uyarı üretir).
          </p>
          <textarea
            value={resultCsv}
            onChange={(e) => setResultCsv(e.target.value)}
            rows={6}
            placeholder={"idempotency_key,external_ref,status,failure_reason\npayout:...:...,TW-123,paid,"}
            style={{ width: "100%", fontFamily: "monospace", fontSize: "0.8rem" }}
          />
          <button
            disabled={busy || resultCsv.trim().length === 0}
            onClick={() =>
              void run(async () => {
                const res = await trpc.payouts.importResults.mutate({
                  batchId: selectedBatch.id,
                  csvText: resultCsv,
                });
                setImportSummary(res);
                setNotice(`Sonuç dosyası işlendi — ${res.paid} ödendi, ${res.failed} başarısız`);
              }, null)
            }
          >
            Sonuçları import et
          </button>

          {importSummary ? (
            <div style={{ marginTop: "0.75rem" }}>
              <p>
                <span className="badge ok">{importSummary.paid} ödendi</span>{" "}
                <span className="badge warn">{importSummary.failed} başarısız</span>
              </p>
              {importSummary.warnings.length > 0 ? (
                <div>
                  <p className="error">Uyarılar ({importSummary.warnings.length}):</p>
                  <ul>
                    {importSummary.warnings.map((w, i) => (
                      <li key={i} className="mono" style={{ fontSize: "0.8rem" }}>
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="muted">Uyarı yok.</p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <h2>Payout&apos;lar</h2>
        {recent.length === 0 ? (
          <div className="empty">Henüz payout yok.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Eğitmen</th>
                  <th>Tutar</th>
                  <th>Durum</th>
                  <th>Wise ref</th>
                  <th>Tarih</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((p) => {
                  const st = PAYOUT_STATUS[p.status] ?? { label: p.status, ok: false };
                  return (
                    <tr key={p.id}>
                      <td>{p.teacherName}</td>
                      <td>{formatCents(p.amountCents, p.currency)}</td>
                      <td>
                        <span className={`badge ${st.ok ? "ok" : "warn"}`}>{st.label}</span>
                        {p.status === "failed" && p.failureReason ? (
                          <span className="muted"> — {p.failureReason}</span>
                        ) : null}
                      </td>
                      <td className="mono">{p.externalRef ?? "—"}</td>
                      <td>
                        {new Date(p.paidAt ?? p.createdAt).toLocaleString("tr-TR")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Kart itirazları (chargeback)</h2>
        <p className="muted">
          Stripe&apos;tan gelen kart itirazları — salt görünürlük; para düzeltmesi mevcut
          iade/reversal yollarıyla yapılır. Açık itirazlar üstte.
        </p>
        {chargebacks.length === 0 ? (
          <div className="empty">Kart itirazı yok.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Tutar</th>
                  <th>Durum</th>
                  <th>Okul</th>
                  <th>Dispute ID</th>
                </tr>
              </thead>
              <tbody>
                {chargebacks.map((c) => {
                  const st = CHARGEBACK_STATUS[c.status] ?? { label: c.status, ok: false };
                  return (
                    <tr key={c.id}>
                      <td>{new Date(c.createdAt).toLocaleString("tr-TR")}</td>
                      <td>{formatCents(c.amountCents, c.currency)}</td>
                      <td>
                        <span className={`badge ${st.ok ? "ok" : "warn"}`}>{st.label}</span>
                      </td>
                      <td>{c.schoolName ?? <span className="muted">eşleşmedi</span>}</td>
                      <td className="mono">{c.disputeId}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Dış bakiye mutabakatı (Stripe / Wise)</h2>
        <p className="muted">
          Ledger&apos;daki clearing hesabına göre sağlayıcıda olması beklenen para ile son bildirilen
          gerçek bakiye karşılaştırılır; fark varsa satır kırmızı uyarı verir.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Sağlayıcı</th>
                <th>Ledger beklentisi</th>
                <th>Son bakiye bildirimi</th>
                <th>Fark</th>
              </tr>
            </thead>
            <tbody>
              {reconciliation.map((r) => (
                <tr key={r.provider}>
                  <td>{PROVIDER_LABELS[r.provider] ?? r.provider}</td>
                  <td>{formatCents(r.ledgerExpectedCents)}</td>
                  <td>
                    {r.snapshotCents === null ? (
                      <span className="muted">bildirim yok</span>
                    ) : (
                      <>
                        {formatCents(r.snapshotCents)}{" "}
                        <span className="muted">
                          ({r.snapshotAt ? new Date(r.snapshotAt).toLocaleString("tr-TR") : "—"})
                        </span>
                      </>
                    )}
                  </td>
                  <td>
                    {r.diffCents === null ? (
                      <span className="muted">—</span>
                    ) : r.diffCents === 0 ? (
                      <span className="badge ok">mutabık</span>
                    ) : (
                      <span className="error">
                        UYUŞMAZLIK: {formatCents(r.diffCents)} — kayıtları kontrol edin
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 style={{ marginTop: "1rem" }}>Manuel Wise bakiye girişi</h3>
        <p className="muted">
          Wise panosunda görünen güncel bakiyeyi girin (USD). Para OYNAMAZ — yalnız mutabakat
          kaydı oluşur.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = Number(wiseBalance.replace(",", "."));
            if (!Number.isFinite(parsed)) {
              setActionError("Geçerli bir tutar girin (örn. 1250.00)");
              return;
            }
            void run(async () => {
              await trpc.admin.recordExternalBalance.mutate({
                balanceCents: Math.round(parsed * 100),
                ...(wiseNote.trim() ? { note: wiseNote.trim() } : {}),
              });
              setWiseBalance("");
              setWiseNote("");
            }, "Wise bakiye kaydı alındı");
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="wb-amount">Bakiye (USD)</label>
              <input
                id="wb-amount"
                inputMode="decimal"
                value={wiseBalance}
                onChange={(e) => setWiseBalance(e.target.value)}
                placeholder="1250.00"
                required
              />
            </div>
            <div>
              <label htmlFor="wb-note">Not (opsiyonel)</label>
              <input
                id="wb-note"
                value={wiseNote}
                onChange={(e) => setWiseNote(e.target.value)}
                placeholder="örn. Wise panosu 11 Tem"
              />
            </div>
            <div>
              <button type="submit" disabled={busy}>
                Bakiyeyi kaydet
              </button>
            </div>
          </div>
        </form>

        <h3 style={{ marginTop: "1rem" }}>Son bakiye bildirimleri</h3>
        {snapshots.length === 0 ? (
          <div className="empty">Henüz bakiye bildirimi yok.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Sağlayıcı</th>
                  <th>Bakiye</th>
                  <th>Kaynak</th>
                  <th>Not</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id}>
                    <td>{new Date(s.capturedAt).toLocaleString("tr-TR")}</td>
                    <td>{PROVIDER_LABELS[s.provider] ?? s.provider}</td>
                    <td>{formatCents(s.balanceCents, s.currency)}</td>
                    <td>{s.source === "manual" ? "manuel" : "API"}</td>
                    <td className="muted">{s.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Backfill süpürücüsü</h2>
        <p className="muted">
          Eğitmeni düşmüş (cancelled_teacher) slotlara yeniden teklif açar; SLA aşılmışsa slotu
          eskalasyona alır ve ders ücretini okula iade eder. Normalde zamanlanmış iş; burası
          demo/test tetiğidir.
        </p>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const res = await trpc.payouts.runBackfillSweep.mutate();
              setSweep(res);
              setNotice(
                `Süpürme bitti — ${res.offered} yeni teklif, ${res.reoffered} yeniden teklif, ${res.escalated} eskalasyon`,
              );
            }, null)
          }
        >
          Backfill süpür
        </button>
        {sweep ? (
          <p style={{ marginTop: "0.5rem" }}>
            <span className="badge ok">{sweep.offered} teklif</span>{" "}
            <span className="badge ok">{sweep.reoffered} yeniden teklif</span>{" "}
            <span className="badge warn">{sweep.escalated} eskalasyon</span>
          </p>
        ) : null}
      </div>
    </main>
  );
}
