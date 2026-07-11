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

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [pendingRes, accountsRes, frozenRes, schoolsRes, teachersRes, poolsRes, disputesRes] =
        await Promise.all([
          trpc.admin.listPendingTopups.query(),
          trpc.admin.listBankAccounts.query(),
          trpc.admin.paymentsFrozen.query(),
          trpc.lessons.listSchools.query(),
          trpc.lessons.listActiveTeachers.query(),
          trpc.admin.listPoolPricing.query(),
          trpc.admin.listDisputes.query(),
        ]);
      setPending(pendingRes);
      setAccounts(accountsRes);
      setFrozen(frozenRes.frozen);
      setSchools(schoolsRes);
      setTeachers(teachersRes);
      setPoolPricing(poolsRes);
      setDisputes(disputesRes);
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
      </p>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

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
