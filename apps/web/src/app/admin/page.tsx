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

interface SchoolOption {
  id: string;
  name: string;
}

interface TeacherOption {
  id: string;
  fullName: string;
}

const EMPTY_LESSON = {
  schoolId: "",
  teacherId: "",
  lessonDate: "",
  minutes: "40",
  chargeUsd: "",
  teacherPayUsd: "",
  note: "",
};

interface PoolPricing {
  id: string;
  key: string;
  name: string;
  active: boolean;
  sellPerLessonCents: number;
  payPerLessonCents: number;
  lessonMinutes: number;
}

const EMPTY_PRICING = { poolId: "", sellUsd: "", payUsd: "", minutes: "" };

interface Dispute {
  id: string;
  sessionId: string;
  reason: string;
  createdAt: Date;
  schoolName: string;
  className: string;
  lessonDate: string;
  dosageMin: number | null;
  priceCents: number;
}

interface NotificationItem {
  id: string;
  recipient: string; // maskeli: a***@dom.com
  template: string;
  status: string;
  attempt: number;
  createdAt: Date;
}

interface NotificationsView {
  resendConfigured: boolean;
  items: NotificationItem[];
}

interface OpenOffer {
  assignmentId: string;
  slotId: string;
  startsAt: Date;
  endsAt: Date;
  expiresAt: Date;
  expired: boolean;
  schoolName: string;
  className: string;
  poolName: string;
  teacherName: string;
  teacherEmail: string; // maskesiz — admin linki eğitmene elle iletir
}

// reissueOffer yanıtından satır altında gösterilen link (ham token yalnız bu state'te yaşar).
interface OfferLink {
  url: string;
  teacherName: string;
  teacherEmail: string;
  expiresAt: Date;
}

interface SettleReview {
  sessionId: string;
  schoolName: string;
  className: string;
  teacherName: string;
  plannedStartsAt: Date;
  plannedEndsAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  dosageMin: number | null;
  reason: string | null;
}

interface WorkerHealth {
  job: string;
  lastRunAt: Date | null;
  stale: boolean;
}

interface HealthStrip {
  todayLessonCount: number;
  liveLessonCount: number;
  oldestPendingTopupDays: number | null;
  failedPayoutCount: number;
  pendingNotificationCount: number;
  workers: WorkerHealth[];
}

/** "3 sa önce" tarzı kısa görece zaman (sağlık şeridi worker rozeti). */
function timeAgo(at: Date): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60_000));
  if (mins < 60) return `${mins} dk önce`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} sa önce`;
  return `${Math.round(hours / 24)} gün önce`;
}

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
  const [schools, setSchools] = useState<SchoolOption[]>([]);
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [lesson, setLesson] = useState(EMPTY_LESSON);
  const [poolPricing, setPoolPricing] = useState<PoolPricing[]>([]);
  const [pricing, setPricing] = useState(EMPTY_PRICING);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [notifications, setNotifications] = useState<NotificationsView | null>(null);
  const [pendingNotifications, setPendingNotifications] = useState(0);
  const [openOffers, setOpenOffers] = useState<OpenOffer[]>([]);
  const [offerLinks, setOfferLinks] = useState<Record<string, OfferLink>>({});
  const [settleReviews, setSettleReviews] = useState<SettleReview[]>([]);
  const [health, setHealth] = useState<HealthStrip | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [
        pendingRes,
        accountsRes,
        frozenRes,
        schoolsRes,
        teachersRes,
        poolsRes,
        disputesRes,
        notificationsRes,
        pendingNotifRes,
        openOffersRes,
        settleReviewsRes,
        healthRes,
      ] = await Promise.all([
        trpc.admin.listPendingTopups.query(),
        trpc.admin.listBankAccounts.query(),
        trpc.admin.paymentsFrozen.query(),
        trpc.lessons.listSchools.query(),
        trpc.lessons.listActiveTeachers.query(),
        trpc.admin.listPoolPricing.query(),
        trpc.admin.listDisputes.query(),
        trpc.admin.listNotifications.query(),
        trpc.admin.pendingNotificationCount.query(),
        trpc.admin.listOpenOffers.query(),
        trpc.admin.listSettleReviews.query(),
        trpc.admin.healthStrip.query(),
      ]);
      setPending(pendingRes);
      setAccounts(accountsRes);
      setFrozen(frozenRes.frozen);
      setSchools(schoolsRes);
      setTeachers(teachersRes);
      setPoolPricing(poolsRes);
      setDisputes(disputesRes);
      setNotifications(notificationsRes);
      setPendingNotifications(pendingNotifRes.pending);
      setOpenOffers(openOffersRes);
      setSettleReviews(settleReviewsRes);
      setHealth(healthRes);
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

  function parseUsdCents(value: string): number | null {
    const amount = Number(value.replace(",", "."));
    if (!Number.isFinite(amount) || amount < 0) return null;
    return Math.round(amount * 100);
  }

  return (
    <main>
      <h1>Platform yönetimi</h1>
      <p className="muted">
        <a href="/admin/egitmenler">Eğitmen yönetimi (pipeline, davet, evrak, görüşme) →</a>
        {" · "}
        <a href="/admin/odemeler">Ödemeler (payout batch, Wise CSV, backfill) →</a>
        {" · "}
        <a href="/admin/metrikler">Pilot metrikleri (go/no-go) →</a>
      </p>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      {health ? (
        <div className="card">
          <h2>Sağlık şeridi</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {[
              { label: "Bugünkü ders", value: String(health.todayLessonCount), warn: false },
              { label: "Şu an canlı ders", value: String(health.liveLessonCount), warn: false },
              {
                label: "En eski bekleyen havale",
                value:
                  health.oldestPendingTopupDays === null
                    ? "—"
                    : `${health.oldestPendingTopupDays.toFixed(1)} gün`,
                warn: (health.oldestPendingTopupDays ?? 0) > 2,
              },
              {
                label: "Başarısız payout",
                value: String(health.failedPayoutCount),
                warn: health.failedPayoutCount > 0,
              },
              {
                label: "Bekleyen bildirim",
                value: String(health.pendingNotificationCount),
                warn: health.pendingNotificationCount > 20,
              },
            ].map((tile) => (
              <div
                key={tile.label}
                style={{
                  border: "1px solid #e2e6ec",
                  borderRadius: "8px",
                  padding: "0.5rem 0.9rem",
                  minWidth: "9rem",
                }}
              >
                <div className="muted" style={{ fontSize: "0.75rem" }}>
                  {tile.label}
                </div>
                <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>
                  {tile.warn ? <span className="badge warn">{tile.value}</span> : tile.value}
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginTop: "0.75rem" }}>
            {health.workers.map((w) => (
              <span key={w.job} className={`badge ${w.stale ? "warn" : "ok"}`}>
                {w.job}: {w.lastRunAt ? timeAgo(w.lastRunAt) : "hiç koşmadı"}
              </span>
            ))}
          </div>
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            Kırmızı worker rozeti: heartbeat eşik süresinden eski (cron aralığı + pay) — worker
            loglarına bakın.
          </p>
        </div>
      ) : null}

      <div className="card">
        <h2>Bekleyen teklifler</h2>
        <p className="muted">
          offered durumundaki atamalar. E-posta altyapısı devreye girene kadar teklif linki
          eğitmene buradan iletilir: &quot;Linki üret / yenile&quot; mevcut teklifi geri çekip
          YENİ token&apos;lı teklif açar (sıradaki uygun adaya — aynı eğitmen dahil) ve tam
          URL&apos;yi gösterir.
        </p>
        {openOffers.length === 0 ? (
          <p className="muted">Bekleyen teklif yok.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Ders saati</th>
                  <th>Okul / sınıf / havuz</th>
                  <th>Eğitmen</th>
                  <th>Son geçerlilik</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {openOffers.map((o) => {
                  const link = offerLinks[o.slotId];
                  return (
                  <tr key={o.assignmentId}>
                    <td>{new Date(o.startsAt).toLocaleString("tr-TR")}</td>
                    <td>
                      {o.schoolName} — {o.className}
                      <div className="muted" style={{ fontSize: "0.8rem" }}>
                        {o.poolName}
                      </div>
                    </td>
                    <td>
                      {o.teacherName}
                      <div className="mono" style={{ fontSize: "0.75rem" }}>
                        {o.teacherEmail}
                      </div>
                    </td>
                    <td>
                      {new Date(o.expiresAt).toLocaleString("tr-TR")}{" "}
                      {o.expired ? <span className="badge warn">süresi doldu</span> : null}
                    </td>
                    <td>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const res = await trpc.admin.reissueOffer.mutate({ slotId: o.slotId });
                            if (!res.ok) {
                              setOfferLinks((prev) => {
                                const next = { ...prev };
                                delete next[o.slotId];
                                return next;
                              });
                              throw new Error(`Teklif yenilenemedi: ${res.reason}`);
                            }
                            setOfferLinks((prev) => ({
                              ...prev,
                              [o.slotId]: {
                                url: res.url,
                                teacherName: res.teacherName,
                                teacherEmail: res.teacherEmail,
                                expiresAt: res.expiresAt,
                              },
                            }));
                          }, "Teklif linki üretildi — linki kopyalayıp eğitmene iletin")
                        }
                      >
                        Linki üret / yenile
                      </button>
                      {link ? (
                        <div style={{ marginTop: "0.35rem", maxWidth: "22rem" }}>
                          <div
                            className="mono"
                            style={{
                              wordBreak: "break-all",
                              userSelect: "all",
                              fontSize: "0.75rem",
                            }}
                          >
                            {link.url}
                          </div>
                          <div className="muted" style={{ fontSize: "0.75rem" }}>
                            {link.teacherName} ({link.teacherEmail}) — son geçerlilik:{" "}
                            {new Date(link.expiresAt).toLocaleString("tr-TR")}
                          </div>
                        </div>
                      ) : null}
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
        <h2>Settle onayı bekleyenler</h2>
        <p className="muted">
          Kısa/erken biten dersler otomatik settle edilmez; karar burada verilir. Onay parayı
          işler (hold bölüşülür). Ret PARA İŞLEMEZ: oturum &quot;ended&quot;, slot
          &quot;scheduled&quot; kalır — slot hold-aging uyarısına düşer ve nihai karar (iptal /
          iade / manuel düzeltme) o kuyrukta verilir.
        </p>
        {settleReviews.length === 0 ? (
          <p className="muted">Onay bekleyen ders yok.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Okul / sınıf</th>
                  <th>Eğitmen</th>
                  <th>Planlı saat</th>
                  <th>Gerçekleşen</th>
                  <th>Süre</th>
                  <th>Gerekçe</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {settleReviews.map((r) => (
                  <tr key={r.sessionId}>
                    <td>
                      {r.schoolName} — {r.className}
                    </td>
                    <td>{r.teacherName}</td>
                    <td>{new Date(r.plannedStartsAt).toLocaleString("tr-TR")}</td>
                    <td>
                      {r.startedAt ? new Date(r.startedAt).toLocaleTimeString("tr-TR") : "—"}
                      {" → "}
                      {r.endedAt ? new Date(r.endedAt).toLocaleTimeString("tr-TR") : "—"}
                    </td>
                    <td>{r.dosageMin !== null ? `${r.dosageMin} dk` : "—"}</td>
                    <td style={{ maxWidth: "14rem" }} className="muted">
                      {r.reason ?? "—"}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: "0.35rem" }}>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => trpc.admin.approveSettle.mutate({ sessionId: r.sessionId }),
                              "Settle onaylandı — eğitmen alacağı işlendi",
                            )
                          }
                        >
                          Onayla
                        </button>
                        <button
                          className="secondary"
                          style={{ marginTop: 0 }}
                          disabled={busy}
                          onClick={() => {
                            const note = window.prompt(
                              "Ret notu (para işlenmez; slot scheduled kaldığı için hold-aging uyarısına düşer — nihai karar orada):",
                              "ders süresi doğrulanamadı — hold-aging kuyruğunda karar verilecek",
                            );
                            if (!note) return;
                            void run(
                              () =>
                                trpc.admin.rejectSettle.mutate({ sessionId: r.sessionId, note }),
                              "Settle reddedildi — para işlenmedi; slot hold-aging uyarısına düşecek",
                            );
                          }}
                        >
                          Reddet
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Manuel ders kaydı (Wizard-of-Oz)</h2>
        <p className="muted">
          Satış tutarı okulun cüzdanından düşer; eğitmen ücreti maliyet olarak ledger&apos;a işlenir.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const chargeCents = parseUsdCents(lesson.chargeUsd);
            const teacherPayCents = parseUsdCents(lesson.teacherPayUsd);
            const minutes = Number(lesson.minutes);
            if (!chargeCents || chargeCents <= 0 || teacherPayCents === null) {
              setActionError("Geçerli tutarlar girin");
              return;
            }
            if (!Number.isInteger(minutes) || minutes <= 0) {
              setActionError("Geçerli dakika girin");
              return;
            }
            void run(async () => {
              const res = await trpc.lessons.chargeManual.mutate({
                schoolId: lesson.schoolId,
                teacherId: lesson.teacherId,
                lessonDate: lesson.lessonDate,
                minutes,
                chargeCents,
                teacherPayCents,
                ...(lesson.note ? { note: lesson.note } : {}),
              });
              setLesson(EMPTY_LESSON);
              setNotice(`Ders kaydedildi — işlem (txn): ${res.txnId}`);
            }, "Ders kaydedildi");
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="ml-school">Okul</label>
              <select
                id="ml-school"
                value={lesson.schoolId}
                onChange={(e) => setLesson({ ...lesson, schoolId: e.target.value })}
                required
              >
                <option value="">Seçin…</option>
                {schools.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ml-teacher">Eğitmen (aktif)</label>
              <select
                id="ml-teacher"
                value={lesson.teacherId}
                onChange={(e) => setLesson({ ...lesson, teacherId: e.target.value })}
                required
              >
                <option value="">Seçin…</option>
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="ml-date">Ders tarihi</label>
              <input
                id="ml-date"
                type="date"
                value={lesson.lessonDate}
                onChange={(e) => setLesson({ ...lesson, lessonDate: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="ml-minutes">Dakika</label>
              <input
                id="ml-minutes"
                inputMode="numeric"
                value={lesson.minutes}
                onChange={(e) => setLesson({ ...lesson, minutes: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="ml-charge">Satış (USD)</label>
              <input
                id="ml-charge"
                inputMode="decimal"
                value={lesson.chargeUsd}
                onChange={(e) => setLesson({ ...lesson, chargeUsd: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="ml-pay">Eğitmen ücreti (USD)</label>
              <input
                id="ml-pay"
                inputMode="decimal"
                value={lesson.teacherPayUsd}
                onChange={(e) => setLesson({ ...lesson, teacherPayUsd: e.target.value })}
                required
              />
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="ml-note">Not (opsiyonel)</label>
              <input
                id="ml-note"
                value={lesson.note}
                onChange={(e) => setLesson({ ...lesson, note: e.target.value })}
              />
            </div>
          </div>
          <button type="submit" disabled={busy || teachers.length === 0 || schools.length === 0}>
            Dersi kaydet
          </button>
          {teachers.length === 0 ? (
            <p className="muted">Aktif eğitmen yok — önce eğitmen pipeline&apos;ını tamamlayın.</p>
          ) : null}
        </form>
      </div>

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
        <h2>Dispatch materializer</h2>
        <p className="muted">
          Aktif reçeteleri 4 haftalık ufukta slota döker (idempotent): hold alır ve eğitmen
          tekliflerini başlatır. Normalde zamanlanmış iş; burası demo/test tetiğidir.
        </p>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const res = await trpc.admin.runMaterializer.mutate();
              setNotice(
                `Materializer bitti — ${res.created} slot oluştu, ${res.blocked} bloke (bakiye), ${res.skipped} zaten vardı`,
              );
            }, "Materializer bitti")
          }
        >
          Materializer&apos;ı çalıştır
        </button>
      </div>

      <div className="card">
        <h2>Pool fiyat kartı</h2>
        <p className="muted">
          Değişiklik yalnız YENİ reçeteleri etkiler; mevcut planlar oluşturulma anındaki fiyat
          snapshot&apos;ını taşır.
        </p>
        {poolPricing.length === 0 ? (
          <p className="muted">Tanımlı havuz yok.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Havuz</th>
                <th>Satış / ders</th>
                <th>Eğitmen maliyeti / ders</th>
                <th>Süre</th>
              </tr>
            </thead>
            <tbody>
              {poolPricing.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name} {p.active ? null : <span className="badge warn">pasif</span>}
                  </td>
                  <td>{formatCents(p.sellPerLessonCents)}</td>
                  <td>{formatCents(p.payPerLessonCents)}</td>
                  <td>{p.lessonMinutes} dk</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const sellCents = parseUsdCents(pricing.sellUsd);
            const payCents = parseUsdCents(pricing.payUsd);
            const minutes = Number(pricing.minutes);
            if (!pricing.poolId) {
              setActionError("Havuz seçin");
              return;
            }
            if (!sellCents || sellCents <= 0 || payCents === null) {
              setActionError("Geçerli tutarlar girin");
              return;
            }
            if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240) {
              setActionError("Ders süresi 15-240 dk arasında olmalı");
              return;
            }
            void run(async () => {
              await trpc.admin.updatePoolPricing.mutate({
                poolId: pricing.poolId,
                sellPerLessonCents: sellCents,
                payPerLessonCents: payCents,
                lessonMinutes: minutes,
              });
              setPricing(EMPTY_PRICING);
            }, "Fiyat kartı güncellendi — yeni reçetelerde geçerli");
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="pp-pool">Havuz</label>
              <select
                id="pp-pool"
                value={pricing.poolId}
                onChange={(e) => {
                  const pool = poolPricing.find((p) => p.id === e.target.value);
                  setPricing(
                    pool
                      ? {
                          poolId: pool.id,
                          sellUsd: (pool.sellPerLessonCents / 100).toFixed(2),
                          payUsd: (pool.payPerLessonCents / 100).toFixed(2),
                          minutes: String(pool.lessonMinutes),
                        }
                      : EMPTY_PRICING,
                  );
                }}
                required
              >
                <option value="">Seçin…</option>
                {poolPricing.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="pp-sell">Satış (USD / ders)</label>
              <input
                id="pp-sell"
                inputMode="decimal"
                value={pricing.sellUsd}
                onChange={(e) => setPricing({ ...pricing, sellUsd: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="pp-pay">Eğitmen maliyeti (USD / ders)</label>
              <input
                id="pp-pay"
                inputMode="decimal"
                value={pricing.payUsd}
                onChange={(e) => setPricing({ ...pricing, payUsd: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="pp-min">Süre (dk)</label>
              <input
                id="pp-min"
                inputMode="numeric"
                value={pricing.minutes}
                onChange={(e) => setPricing({ ...pricing, minutes: e.target.value })}
                required
              />
            </div>
          </div>
          <button type="submit" disabled={busy || !pricing.poolId}>
            Fiyatı güncelle
          </button>
        </form>
      </div>

      <div className="card">
        <h2>İtirazlar</h2>
        <p className="muted">
          Okul itirazları: karar Faz-1&apos;de insanda. İade daima ters ledger kaydıyla yapılır
          (tarihçe değişmez).
        </p>
        {disputes.length === 0 ? (
          <p className="muted">Açık itiraz yok.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Okul</th>
                  <th>Ders</th>
                  <th>Tutar</th>
                  <th>Gerekçe</th>
                  <th>Tarih</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {disputes.map((d) => (
                  <tr key={d.id}>
                    <td>{d.schoolName}</td>
                    <td>
                      {d.className} — {d.lessonDate}
                      {d.dosageMin !== null ? ` (${d.dosageMin} dk)` : ""}
                    </td>
                    <td>{formatCents(d.priceCents)}</td>
                    <td style={{ maxWidth: "16rem" }}>{d.reason}</td>
                    <td>{new Date(d.createdAt).toLocaleString("tr-TR")}</td>
                    <td>
                      <div style={{ display: "flex", gap: "0.35rem" }}>
                        <button
                          disabled={busy}
                          onClick={() => {
                            const note = window.prompt("İade karar notu:", "itiraz haklı — iade");
                            if (!note) return;
                            void run(
                              () =>
                                trpc.admin.resolveDispute.mutate({
                                  disputeId: d.id,
                                  decision: "refund",
                                  note,
                                }),
                              "İtiraz sonuçlandı — tutar okula iade edildi",
                            );
                          }}
                        >
                          İade et
                        </button>
                        <button
                          className="secondary"
                          style={{ marginTop: 0 }}
                          disabled={busy}
                          onClick={() => {
                            const note = window.prompt("Ret karar notu:", "kayıtlar dersi doğruluyor");
                            if (!note) return;
                            void run(
                              () =>
                                trpc.admin.resolveDispute.mutate({
                                  disputeId: d.id,
                                  decision: "rejected",
                                  note,
                                }),
                              "İtiraz reddedildi",
                            );
                          }}
                        >
                          Reddet
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Bildirimler</h2>
        <p>
          Bekleyen e-posta: <strong>{pendingNotifications}</strong>
        </p>
        {notifications && !notifications.resendConfigured ? (
          <p className="muted">
            e-posta anahtarı bekleniyor (RESEND_API_KEY) — kayıtlar birikiyor, anahtar girilince
            gönderilecek.
          </p>
        ) : null}
        {!notifications || notifications.items.length === 0 ? (
          <p className="muted">Henüz bildirim kaydı yok.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Şablon</th>
                  <th>Alıcı</th>
                  <th>Durum</th>
                  <th>Deneme</th>
                  <th>Tarih</th>
                </tr>
              </thead>
              <tbody>
                {notifications.items.map((n) => (
                  <tr key={n.id}>
                    <td className="mono">{n.template}</td>
                    <td className="mono">{n.recipient}</td>
                    <td>
                      {n.status === "sent" ? (
                        <span className="badge ok">sent</span>
                      ) : n.status === "pending" ? (
                        <span className="badge warn">pending</span>
                      ) : (
                        <span className="badge warn">{n.status}</span>
                      )}
                    </td>
                    <td>{n.attempt}</td>
                    <td>{new Date(n.createdAt).toLocaleString("tr-TR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
