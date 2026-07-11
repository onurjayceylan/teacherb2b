"use client";

// Self-serve başlangıç sihirbazı — kuzey yıldızı: kayıt→ilk reçete <15 dk.
// Tek sayfa, adım göstergeli; yalnız MEVCUT tRPC uçlarını kullanır (yeni iş mantığı yok):
//   1 Okul   → onboarding.createSchool (okulu zaten olan bu adımı atlar)
//   2 Cüzdan → topup.createBank havale referansı (kart yapılandırılmışsa Stripe Checkout)
//   3 Sınıf  → roster.importStudents ("Ad Soyad;Sınıf" satırları)
//   4 Reçete → schedule.createPlan (pool satış fiyatı göstergeli)
// Her adım tamamlanınca me.trackFunnel ile audit_log'a funnel kaydı düşülür.
import { useCallback, useEffect, useState } from "react";
import { errorMessage, formatCents, trpc } from "../../lib/trpc";

type Step = 1 | 2 | 3 | 4 | 5;

interface Me {
  email: string;
  schools: { id: string; name: string }[];
  activeSchoolId: string | null;
  stripeConfigured: boolean;
}

interface BankAccount {
  id: string;
  label: string;
  rail: "eft_tr" | "swift_usd";
  holder: string;
  iban: string;
  bankName: string;
  swiftBic: string | null;
}

interface PoolOption {
  id: string;
  name: string;
  sellPerLessonCents: number;
  lessonMinutes: number;
}

interface ClassGroup {
  id: string;
  name: string;
}

const STEPS: { no: Step; title: string }[] = [
  { no: 1, title: "Okul" },
  { no: 2, title: "Cüzdan" },
  { no: 3, title: "Sınıflar" },
  { no: 4, title: "İlk reçete" },
  { no: 5, title: "Bitti" },
];

const WEEKDAYS = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];

type FunnelStep = "school_created" | "wallet_funded" | "roster_imported" | "first_plan" | "wizard_done";

/** Funnel kaydı ölçümdür — başarısız olursa sihirbazı ASLA bloke etmez. */
async function track(step: FunnelStep): Promise<void> {
  try {
    await trpc.me.trackFunnel.mutate({ step });
  } catch {
    // bilinçli sessiz: ölçüm düşmezse kullanıcı akışı yine de ilerler
  }
}

/** "Ad Soyad;Sınıf" satırlarını import satırlarına çevirir (siniflar sayfasıyla aynı biçim). */
function parseStudentLines(text: string): {
  rows: { fullName: string; className: string }[];
  invalid: number[];
} {
  const rows: { fullName: string; className: string }[] = [];
  const invalid: number[] = [];
  text.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed.split(";").map((p) => p.trim());
    const fullName = parts[0] ?? "";
    const className = parts[1] ?? "";
    if (fullName.length < 2 || className.length === 0) {
      invalid.push(i + 1);
      return;
    }
    rows.push({ fullName, className });
  });
  return { rows, invalid };
}

function hhmmToMinute(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  return minute >= 0 && minute <= 1439 ? minute : null;
}

/** Varsayılan reçete başlangıcı: yarın (bugün materialize edilemeyecek kadar geç olabilir). */
function tomorrowISO(): string {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export default function BaslangicPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Adım 1 — okul
  const [schoolName, setSchoolName] = useState("");
  const [country, setCountry] = useState("TR");

  // Adım 2 — cüzdan
  const [balanceCents, setBalanceCents] = useState<number | null>(null);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [amount, setAmount] = useState("100");
  const [bankRef, setBankRef] = useState<string | null>(null);

  // Adım 3 — roster
  const [importText, setImportText] = useState("");
  const [importedCount, setImportedCount] = useState(0);

  // Adım 4 — reçete
  const [pools, setPools] = useState<PoolOption[]>([]);
  const [classes, setClasses] = useState<ClassGroup[]>([]);
  const [plan, setPlan] = useState({
    classGroupId: "",
    poolId: "",
    weekday: "0",
    time: "10:00",
    startDate: tomorrowISO(),
    weeks: "4",
  });
  const [planSummary, setPlanSummary] = useState<{ created: number; blocked: number } | null>(null);

  /** Cüzdan+banka verilerini okul bağlamı gerektiği için ancak okul varken çeker. */
  const loadWallet = useCallback(async () => {
    const [bal, accounts] = await Promise.all([
      trpc.wallet.balance.query(),
      trpc.topup.listBankAccounts.query(),
    ]);
    setBalanceCents(bal.balanceCents);
    setBankAccounts(accounts);
  }, []);

  const loadPlanData = useCallback(async () => {
    const [poolsRes, classesRes] = await Promise.all([
      trpc.schedule.listPools.query(),
      trpc.roster.listClassGroups.query(),
    ]);
    setPools(poolsRes);
    setClasses(classesRes);
    return classesRes;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const meRes = await trpc.me.get.query();
        setMe(meRes);
        if (meRes.schools.length > 0) {
          // Okulu zaten var → adım 1 atlanır, sihirbaz cüzdandan başlar.
          setStep(2);
          await loadWallet();
        }
      } catch (err) {
        setAuthError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [loadWallet]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // --- Adım geçişleri ---

  function submitSchool(e: React.FormEvent) {
    e.preventDefault();
    void run(async () => {
      await trpc.onboarding.createSchool.mutate({ name: schoolName, country });
      await track("school_created");
      const meRes = await trpc.me.get.query();
      setMe(meRes);
      await loadWallet();
      setStep(2);
    });
  }

  function createBankRef(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number(amount.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Geçerli bir tutar girin");
      return;
    }
    void run(async () => {
      const res = await trpc.topup.createBank.mutate({ amountCents: Math.round(parsed * 100) });
      setBankRef(res.referenceCode);
    });
  }

  function startCardCheckout() {
    const parsed = Number(amount.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Geçerli bir tutar girin");
      return;
    }
    void run(async () => {
      const res = await trpc.topup.createCardCheckout.mutate({
        amountCents: Math.round(parsed * 100),
      });
      // Checkout'a gitmeden funnel düşülür — dönüş /okul'a olduğundan sihirbaza geri gelinmez.
      await track("wallet_funded");
      window.location.href = res.url;
    });
  }

  function finishWalletStep() {
    void run(async () => {
      await track("wallet_funded");
      setStep(3);
    });
  }

  function submitRoster(e: React.FormEvent) {
    e.preventDefault();
    const { rows, invalid } = parseStudentLines(importText);
    if (rows.length === 0) {
      setError("Geçerli satır bulunamadı — her satır: Ad Soyad;Sınıf");
      return;
    }
    void run(async () => {
      const res = await trpc.roster.importStudents.mutate({ rows });
      setImportedCount(res.created);
      await track("roster_imported");
      const classesRes = await loadPlanData();
      // İlk sınıf otomatik seçilir — reçete adımı tek tıka insin.
      setPlan((p) => ({ ...p, classGroupId: classesRes[0]?.id ?? "" }));
      if (invalid.length > 0) setError(`Bozuk satırlar atlandı: ${invalid.join(", ")}`);
      setStep(4);
    });
  }

  function submitPlan(e: React.FormEvent) {
    e.preventDefault();
    const startMinute = hhmmToMinute(plan.time);
    const weeks = Number(plan.weeks);
    if (!plan.classGroupId || !plan.poolId) {
      setError("Sınıf ve ders havuzu seçin");
      return;
    }
    if (startMinute === null) {
      setError("Geçerli bir saat girin (örn. 14:30)");
      return;
    }
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) {
      setError("Hafta sayısı 1-52 arasında olmalı");
      return;
    }
    void run(async () => {
      const res = await trpc.schedule.createPlan.mutate({
        classGroupId: plan.classGroupId,
        poolId: plan.poolId,
        weekday: Number(plan.weekday),
        startMinute,
        startDate: plan.startDate,
        weeks,
      });
      setPlanSummary({ created: res.materialize.created, blocked: res.materialize.blocked });
      await track("first_plan");
      await track("wizard_done");
      setStep(5);
    });
  }

  // --- Görünüm ---

  if (loading) return <main className="muted">Yükleniyor…</main>;

  if (authError || !me) {
    return (
      <main>
        <h1>Başlangıç sihirbazı</h1>
        <div className="card">
          <p className="error">{authError ?? "Oturum bulunamadı"}</p>
          <p className="muted">
            Sihirbaz için oturum gerekli — <a href="/">giriş yapın ya da kayıt olun</a>.
          </p>
        </div>
      </main>
    );
  }

  const school = me.schools.find((s) => s.id === me.activeSchoolId) ?? me.schools[0];
  const selectedPool = pools.find((p) => p.id === plan.poolId) ?? null;

  return (
    <main>
      <h1>Başlangıç sihirbazı</h1>
      <p className="muted">Hedef: 15 dakikadan kısa sürede ilk ders reçeteniz oluşsun.</p>

      {/* Adım göstergesi: tamamlanan ✓ yeşil, aktif adım mavi, gelecektekiler soluk */}
      <p aria-label="adımlar">
        {STEPS.map((s, i) => (
          <span key={s.no}>
            {i > 0 ? <span className="muted"> → </span> : null}
            <span
              className={s.no < step ? "badge ok" : s.no === step ? "badge info" : "badge"}
              style={s.no > step ? { background: "#eef1f5", color: "var(--muted)" } : undefined}
            >
              {s.no < step ? "✓ " : `${s.no}. `}
              {s.title}
            </span>
          </span>
        ))}
      </p>

      {error ? <p className="error">{error}</p> : null}

      {step === 1 ? (
        <div className="card">
          <h2>1. Okulunuzu oluşturun</h2>
          <form onSubmit={submitSchool}>
            <label htmlFor="wz-school-name">Okul adı</label>
            <input
              id="wz-school-name"
              value={schoolName}
              onChange={(e) => setSchoolName(e.target.value)}
              required
              minLength={2}
              placeholder="Örn. Bilge Koleji"
            />
            <label htmlFor="wz-country">Ülke</label>
            <select id="wz-country" value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="TR">Türkiye</option>
              <option value="US">ABD</option>
              <option value="DE">Almanya</option>
              <option value="GB">Birleşik Krallık</option>
              <option value="AE">BAE</option>
            </select>
            <button type="submit" disabled={busy}>
              {busy ? "Oluşturuluyor…" : "Okulu oluştur ve devam et"}
            </button>
          </form>
          <p className="muted">
            Kayıt; organizasyon, okul, sahiplik üyeliği ve okul cüzdanını birlikte oluşturur.
          </p>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="card">
          <h2>2. Cüzdanınıza bakiye yükleyin</h2>
          <p>
            Mevcut bakiye:{" "}
            <strong>{balanceCents !== null ? formatCents(balanceCents) : "—"}</strong>
            {school ? <span className="muted"> ({school.name})</span> : null}
          </p>

          {me.stripeConfigured ? (
            <div className="row">
              <div>
                <label htmlFor="wz-amount-card">Tutar (USD)</label>
                <input
                  id="wz-amount-card"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div>
                <button onClick={() => startCardCheckout()} disabled={busy}>
                  {busy ? "Yönlendiriliyor…" : "Kartla öde"}
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={createBankRef}>
              <p className="muted">
                Kart ödemesi henüz yapılandırılmadı — banka havalesiyle yükleyin: tutarı girin,
                referans kodunu alın ve havale açıklamasına yazın.
              </p>
              <div className="row">
                <div>
                  <label htmlFor="wz-amount">Tutar (USD)</label>
                  <input
                    id="wz-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
                <div>
                  <button type="submit" disabled={busy}>
                    {busy ? "Oluşturuluyor…" : "Havale referans kodu al"}
                  </button>
                </div>
              </div>
            </form>
          )}

          {bankRef ? (
            <div>
              <p className="success">
                Havale talebi oluşturuldu — açıklama alanına şu kodu yazın:{" "}
                <strong className="mono">{bankRef}</strong>
              </p>
              {bankAccounts.map((a) => (
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
              <p className="muted">
                Havale, platform yöneticisi onaylayınca bakiyenize yansır — sihirbaza şimdi devam
                edebilirsiniz.
              </p>
            </div>
          ) : null}

          <div className="actions" style={{ marginTop: "0.9rem" }}>
            {bankRef ? (
              <button onClick={() => finishWalletStep()} disabled={busy}>
                Devam et
              </button>
            ) : null}
            <button className="secondary" onClick={() => finishWalletStep()} disabled={busy}>
              Bakiyem hazır — bu adımı geç
            </button>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="card">
          <h2>3. Sınıflarınızı ve öğrencilerinizi ekleyin</h2>
          <p className="muted">
            Her satır: <span className="mono">Ad Soyad;Sınıf</span> — sınıf yoksa otomatik açılır.
          </p>
          <p className="muted">
            <strong>Veri minimizasyonu:</strong> yalnız ad-soyad girin; doğum tarihi, kimlik no,
            telefon veya veli iletişim bilgisi <strong>GİRMEYİN</strong>.
          </p>
          <form onSubmit={submitRoster}>
            <label htmlFor="wz-students">Öğrenci satırları</label>
            <textarea
              id="wz-students"
              rows={6}
              style={{ width: "100%", maxWidth: "40rem" }}
              placeholder={"Ayşe Yılmaz;5-A\nMehmet Demir;5-A\nZeynep Kaya;6-B"}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              required
            />
            <button type="submit" disabled={busy}>
              {busy ? "Aktarılıyor…" : "İçe aktar ve devam et"}
            </button>
          </form>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="card">
          <h2>4. İlk ders reçetenizi oluşturun</h2>
          <p className="muted">
            Reçeteyi kaydettiğiniz anda önümüzdeki haftaların dersleri planlanır, ücretler
            cüzdanınızdan bloke edilir ve eğitmen araması başlar.
          </p>
          <form onSubmit={submitPlan}>
            <div className="row">
              <div>
                <label htmlFor="wz-class">Sınıf</label>
                <select
                  id="wz-class"
                  value={plan.classGroupId}
                  onChange={(e) => setPlan({ ...plan, classGroupId: e.target.value })}
                  required
                >
                  <option value="">Seçin…</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="wz-pool">Ders havuzu (fiyat / ders)</label>
                <select
                  id="wz-pool"
                  value={plan.poolId}
                  onChange={(e) => setPlan({ ...plan, poolId: e.target.value })}
                  required
                >
                  <option value="">Seçin…</option>
                  {pools.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {formatCents(p.sellPerLessonCents)} / {p.lessonMinutes} dk
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row">
              <div>
                <label htmlFor="wz-weekday">Gün</label>
                <select
                  id="wz-weekday"
                  value={plan.weekday}
                  onChange={(e) => setPlan({ ...plan, weekday: e.target.value })}
                >
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={String(i)}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="wz-time">Saat (okul saatiyle)</label>
                <input
                  id="wz-time"
                  type="time"
                  value={plan.time}
                  onChange={(e) => setPlan({ ...plan, time: e.target.value })}
                  required
                />
              </div>
              <div>
                <label htmlFor="wz-start">Başlangıç tarihi</label>
                <input
                  id="wz-start"
                  type="date"
                  value={plan.startDate}
                  onChange={(e) => setPlan({ ...plan, startDate: e.target.value })}
                  required
                />
              </div>
              <div>
                <label htmlFor="wz-weeks">Hafta sayısı</label>
                <input
                  id="wz-weeks"
                  inputMode="numeric"
                  value={plan.weeks}
                  onChange={(e) => setPlan({ ...plan, weeks: e.target.value })}
                  required
                />
              </div>
            </div>
            {selectedPool ? (
              <p className="muted">
                Haftada 1 ders × {plan.weeks || "?"} hafta ≈{" "}
                <strong>
                  {Number.isInteger(Number(plan.weeks)) && Number(plan.weeks) > 0
                    ? formatCents(selectedPool.sellPerLessonCents * Number(plan.weeks))
                    : "—"}
                </strong>{" "}
                ({formatCents(selectedPool.sellPerLessonCents)} / ders)
              </p>
            ) : null}
            <button type="submit" disabled={busy}>
              {busy ? "Kaydediliyor…" : "Reçeteyi kaydet ve bitir"}
            </button>
          </form>
        </div>
      ) : null}

      {step === 5 ? (
        <div className="card">
          <h2>Hazırsınız!</h2>
          <p>
            <strong>{school?.name ?? "Okulunuz"}</strong> kuruldu ve ilk ders reçeteniz oluştu.
          </p>
          <div className="table-wrap">
            <table>
              <tbody>
              <tr>
                <th>Cüzdan</th>
                <td>
                  {bankRef ? (
                    <>
                      Havale referansı: <span className="mono">{bankRef}</span> (onay bekliyor)
                    </>
                  ) : (
                    "Bakiye hazır olarak işaretlendi"
                  )}
                </td>
              </tr>
              <tr>
                <th>Öğrenci</th>
                <td>{importedCount} öğrenci içe aktarıldı</td>
              </tr>
              <tr>
                <th>Reçete</th>
                <td>
                  {planSummary
                    ? `${planSummary.created} ders planlandı` +
                      (planSummary.blocked > 0
                        ? ` — ${planSummary.blocked} ders bakiye yetersizliğinden bloke (bakiye yükleyip onaylandığında ~10 dakika içinde otomatik yeniden denenir)`
                        : "")
                    : "—"}
                </td>
              </tr>
              </tbody>
            </table>
          </div>
          <p className="muted">
            Eğitmen araması başladı — atamaları ve ders linklerini programda izleyebilirsiniz.
          </p>
          <button onClick={() => (window.location.href = "/okul")}>Okul paneline git</button>
        </div>
      ) : null}
    </main>
  );
}
