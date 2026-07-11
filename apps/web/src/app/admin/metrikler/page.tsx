"use client";

// Pilot go/no-go panosu: admin.metrics tek uçtan beslenir. Sayfa herkese yüklenir;
// admin olmayan aktörün çağrısı sunucuda FORBIDDEN ile düşer (admin sayfalarıyla aynı desen).
// Hedef eşikler renkli: yeşil = hedefte, kırmızı = hedef dışı; veri yoksa gri "—".
import { useEffect, useState } from "react";
import { errorMessage, formatCents, trpc } from "../../../lib/trpc";

interface FunnelDuration {
  fromAction: string;
  toAction: string;
  schoolCount: number;
  medianHours: number | null;
}

interface Metrics {
  activation: {
    schoolCount: number;
    medianDaysToFirstTopup: number | null;
    medianDaysToFirstSettledLesson: number | null;
    funnel: { action: string; schools: number; events: number }[];
    funnelDurations: FunnelDuration[];
  };
  dosage: {
    windowDays: number;
    slotCounts: Record<string, number>;
    realizationRate: number | null;
    plannedMinutes: number;
    settledMinutes: number;
    minuteRealizationRate: number | null;
  };
  backfill: { slaEscalatedCount: number; reofferCount: number };
  money: {
    settledLessonCount: number;
    settledVolumeCents: number;
    disputeCount: number;
    disputeRate: number | null;
    repeatTopupSchools: number;
    fundedSchools: number;
    repeatTopupRate: number | null;
  };
  teachers: {
    activeCount: number;
    payoutReadyCount: number;
    openPayoutCount: number;
    openPayoutTotalCents: number;
  };
}

/** Funnel adımlarının sunum sırası (audit action adlarıyla). */
const FUNNEL_ORDER = [
  "funnel_school_created",
  "funnel_wallet_funded",
  "funnel_roster_imported",
  "funnel_first_plan",
  "funnel_wizard_done",
];

const FUNNEL_LABELS: Record<string, string> = {
  funnel_school_created: "1. Okul oluşturuldu",
  funnel_wallet_funded: "2. Cüzdan adımı tamamlandı",
  funnel_roster_imported: "3. Roster içe aktarıldı",
  funnel_first_plan: "4. İlk reçete oluşturuldu",
  funnel_wizard_done: "5. Sihirbaz bitti",
};

const SLOT_LABELS: Record<string, string> = {
  scheduled: "Planlandı",
  completed: "Tamamlandı",
  escalated: "Eskalasyon (SLA)",
  no_show_teacher: "Eğitmen gelmedi",
  cancelled_school_early: "Okul iptali (erken)",
  cancelled_school_late: "Okul iptali (geç)",
  cancelled_teacher: "Eğitmen iptali",
  blocked_insufficient_funds: "Bakiye yetersiz (bloke)",
};

function pct(value: number | null): string {
  return value === null ? "—" : `%${(value * 100).toFixed(1)}`;
}

function days(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} gün`;
}

/** Medyan saat değeri okunur biçimde: <48 sa "X sa", üstü "X gün". */
function hours(value: number | null): string {
  if (value === null) return "—";
  if (value < 48) return `${value.toFixed(1)} sa`;
  return `${(value / 24).toFixed(1)} gün`;
}

/** Eşik rozeti: ok=true yeşil, ok=false kırmızı, ok=null gri (veri yok). */
function Gauge({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  if (ok === null) {
    return (
      <span className="badge" style={{ background: "#eef1f5", color: "var(--muted)" }}>
        {children}
      </span>
    );
  }
  return <span className={`badge ${ok ? "ok" : "warn"}`}>{children}</span>;
}

export default function MetriklerPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        setMetrics(await trpc.admin.metrics.query());
      } catch (err) {
        setLoadError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <main className="muted">Yükleniyor…</main>;

  if (loadError || !metrics) {
    return (
      <main>
        <h1>Pilot metrikleri</h1>
        <div className="card">
          <p className="error">{loadError ?? "Veri alınamadı"}</p>
          <p className="muted">Bu sayfa platform yöneticisi yetkisi ister.</p>
        </div>
      </main>
    );
  }

  const { activation, dosage, backfill, money, teachers } = metrics;
  const funnelByAction = new Map(activation.funnel.map((f) => [f.action, f]));
  const extraFunnel = activation.funnel.filter((f) => !FUNNEL_ORDER.includes(f.action));
  const slotStatuses = Object.keys(SLOT_LABELS).filter((s) => (dosage.slotCounts[s] ?? 0) > 0);

  return (
    <main>
      <h1>Pilot metrikleri (go / no-go)</h1>
      <p className="muted">
        <a href="/admin">← Admin paneline dön</a>
      </p>

      <div className="card">
        <h2>Aktivasyon</h2>
        <div className="table-wrap">
          <table>
            <tbody>
            <tr>
              <th>Okul sayısı</th>
              <td>
                <strong>{activation.schoolCount}</strong>
              </td>
            </tr>
            <tr>
              <th>Kayıt → ilk settled yükleme (medyan)</th>
              <td>
                <Gauge
                  ok={
                    activation.medianDaysToFirstTopup === null
                      ? null
                      : activation.medianDaysToFirstTopup <= 3
                  }
                >
                  {days(activation.medianDaysToFirstTopup)}
                </Gauge>{" "}
                <span className="muted">hedef ≤ 3 gün</span>
              </td>
            </tr>
            <tr>
              <th>Kayıt → ilk settled ders (medyan)</th>
              <td>
                <Gauge
                  ok={
                    activation.medianDaysToFirstSettledLesson === null
                      ? null
                      : activation.medianDaysToFirstSettledLesson <= 14
                  }
                >
                  {days(activation.medianDaysToFirstSettledLesson)}
                </Gauge>{" "}
                <span className="muted">hedef ≤ 14 gün</span>
              </td>
            </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Sihirbaz funnel'ı</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Adım</th>
                <th>Okul</th>
                <th>Olay</th>
              </tr>
            </thead>
            <tbody>
              {FUNNEL_ORDER.map((action) => {
                const row = funnelByAction.get(action);
                return (
                  <tr key={action}>
                    <td>{FUNNEL_LABELS[action] ?? action}</td>
                    <td>{row?.schools ?? 0}</td>
                    <td>{row?.events ?? 0}</td>
                  </tr>
                );
              })}
              {extraFunnel.map((f) => (
                <tr key={f.action}>
                  <td className="mono">{f.action}</td>
                  <td>{f.schools}</td>
                  <td>{f.events}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Funnel adım geçiş süreleri (medyan)</h2>
        <p className="muted">
          Okul başına adımın İLK olayı esas alınır; medyan yalnız iki adımı da yaşamış okullar
          üzerinden hesaplanır.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Geçiş</th>
                <th>Medyan süre</th>
                <th>Okul</th>
              </tr>
            </thead>
            <tbody>
              {activation.funnelDurations.map((d) => (
                <tr key={`${d.fromAction}->${d.toAction}`}>
                  <td>
                    {(FUNNEL_LABELS[d.fromAction] ?? d.fromAction).replace(/^\d+\. /, "")} →{" "}
                    {(FUNNEL_LABELS[d.toAction] ?? d.toAction).replace(/^\d+\. /, "")}
                  </td>
                  <td>{hours(d.medianHours)}</td>
                  <td>{d.schoolCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Dosaj — slot kırılımı (son {dosage.windowDays} gün + planlı ufuk)</h2>
        {slotStatuses.length === 0 ? (
          <div className="empty">Pencerede slot yok.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <tbody>
                {slotStatuses.map((s) => (
                  <tr key={s}>
                    <th>{SLOT_LABELS[s]}</th>
                    <td>{dosage.slotCounts[s]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ marginTop: "0.75rem" }}>
          Gerçekleşme oranı (ders sayısı):{" "}
          <Gauge ok={dosage.realizationRate === null ? null : dosage.realizationRate >= 0.9}>
            {pct(dosage.realizationRate)}
          </Gauge>{" "}
          <span className="muted">
            tamamlanan / (tamamlanan + eskalasyon + gelmedi) — hedef ≥ %90
          </span>
        </p>
        <p>
          Gerçekleşme (dakika bazında):{" "}
          <Gauge
            ok={dosage.minuteRealizationRate === null ? null : dosage.minuteRealizationRate >= 0.9}
          >
            {pct(dosage.minuteRealizationRate)}
          </Gauge>{" "}
          <span className="muted">
            settle edilmiş {dosage.settledMinutes} dk / planlanan {dosage.plannedMinutes} dk —
            kısa biten ders sayım oranında görünmez, burada görünür
          </span>
        </p>
      </div>

      <div className="card">
        <h2>Backfill vaka raporu (sayı — yüzde değil)</h2>
        <div className="table-wrap">
          <table>
            <tbody>
            <tr>
              <th>SLA eskalasyonu (sla_escalated)</th>
              <td>
                <Gauge ok={backfill.slaEscalatedCount === 0}>{backfill.slaEscalatedCount} vaka</Gauge>{" "}
                <span className="muted">hedef 0</span>
              </td>
            </tr>
            <tr>
              <th>Yeniden teklif (eğitmen düşmesi sonrası)</th>
              <td>{backfill.reofferCount} vaka</td>
            </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Para</h2>
        <div className="table-wrap">
          <table>
            <tbody>
            <tr>
              <th>Settled ders</th>
              <td>
                <strong>{money.settledLessonCount}</strong> ders ·{" "}
                {formatCents(money.settledVolumeCents)} hacim
              </td>
            </tr>
            <tr>
              <th>İtiraz</th>
              <td>
                <Gauge ok={money.disputeRate === null ? null : money.disputeRate < 0.02}>
                  {money.disputeCount} itiraz · {pct(money.disputeRate)}
                </Gauge>{" "}
                <span className="muted">hedef &lt; %2</span>
              </td>
            </tr>
            <tr>
              <th>Tekrar yükleme oranı (≥2 settled top-up)</th>
              <td>
                <Gauge ok={money.repeatTopupRate === null ? null : money.repeatTopupRate >= 0.5}>
                  {pct(money.repeatTopupRate)}
                </Gauge>{" "}
                <span className="muted">
                  {money.repeatTopupSchools} / {money.fundedSchools} yükleme yapmış okul
                </span>
              </td>
            </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2>Eğitmen</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              <tr>
                <th>Aktif eğitmen</th>
                <td>{teachers.activeCount}</td>
              </tr>
              <tr>
                <th>Payout'a hazır (evrak seti tam)</th>
                <td>{teachers.payoutReadyCount}</td>
              </tr>
              <tr>
                <th>Açık payout</th>
                <td>
                  {teachers.openPayoutCount} kayıt · {formatCents(teachers.openPayoutTotalCents)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
