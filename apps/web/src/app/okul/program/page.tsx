"use client";

// Okul ders programı: dosaj reçetesi oluşturma (sınıf + havuz + gün/saat + hafta),
// plan listesi (pause/resume + skip-week) ve seçili planın slot tablosu (iptal matrisiyle).
// Fiyat yüzü: yalnız satış fiyatı görünür; eğitmen maliyeti sunucudan hiç gelmez.
import { useCallback, useEffect, useState } from "react";
import { errorMessage, formatCents, trpc } from "../../../lib/trpc";

interface PoolOption {
  id: string;
  key: string;
  name: string;
  sellPerLessonCents: number;
  lessonMinutes: number;
}

interface ClassGroup {
  id: string;
  name: string;
  level: string | null;
}

interface Plan {
  id: string;
  classGroupId: string;
  poolId: string;
  weekday: number;
  startMinute: number;
  durationMin: number;
  schoolTz: string;
  priceCents: number;
  startDate: string;
  weeks: number;
  status: string;
  className: string;
  poolName: string;
  totalSlots: number;
  scheduledCount: number;
  blockedCount: number;
}

interface ApplyResult {
  classGroupId: string;
  className: string;
  planId: string | null;
  error: string | null;
  scheduledCount: number;
  blockedCount: number;
}

interface Slot {
  id: string;
  planId: string;
  occurrenceKey: string;
  startsAt: Date;
  endsAt: Date;
  priceCents: number;
  status: string;
  className: string;
  schoolTz: string;
  teacherName: string | null;
  offerPending: boolean;
  sessionId: string | null;
  sessionStatus: string | null;
  dosageMin: number | null;
  settled: boolean;
}

interface JoinLinks {
  teacherUrl: string;
  classUrl: string;
}

interface AttendanceEntry {
  studentId: string;
  fullName: string;
  present: boolean;
  markedAt: Date;
}

interface SlotAttendance {
  sessionId: string;
  sessionStatus: string;
  entries: AttendanceEntry[];
}

const SESSION_STATUS_LABELS: Record<string, string> = {
  created: "oda açıldı",
  started: "ders sürüyor",
  ended: "ders bitti",
  settled: "tamamlandı (ödendi)",
};

const WEEKDAYS = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];

const PLAN_STATUS_LABELS: Record<string, string> = {
  active: "aktif",
  paused: "duraklatıldı",
  cancelled: "iptal",
  completed: "tamamlandı",
};

const SLOT_STATUS: Record<string, { label: string; ok: boolean }> = {
  scheduled: { label: "planlandı", ok: true },
  blocked_insufficient_funds: { label: "bakiye yetersiz", ok: false },
  cancelled_school_early: { label: "iptal (tam iade)", ok: false },
  cancelled_school_late: { label: "iptal (%50 kesinti)", ok: false },
  cancelled_teacher: { label: "eğitmen düştü", ok: false },
  no_show_teacher: { label: "eğitmen gelmedi (iade)", ok: false },
  completed: { label: "tamamlandı", ok: true },
  escalated: { label: "SLA — ücret iade edildi", ok: false },
  // Tur-2 P1-B: settle'ı reddedilen ders admin kararıyla kapatıldı — ücret alınmadı.
  voided_review: { label: "inceleme sonucu iptal (tam iade)", ok: false },
};

function minuteToHHMM(minute: number): string {
  const h = String(Math.floor(minute / 60)).padStart(2, "0");
  const m = String(minute % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function hhmmToMinute(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  return minute >= 0 && minute <= 1439 ? minute : null;
}

function formatLocal(at: Date, tz: string): string {
  try {
    return new Date(at).toLocaleString("tr-TR", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: tz,
    });
  } catch {
    return new Date(at).toLocaleString("tr-TR");
  }
}

const EMPTY_FORM = {
  classGroupId: "",
  poolId: "",
  weekday: "0",
  time: "10:00",
  startDate: "",
  weeks: "4",
};

export default function ProgramPage() {
  const [pools, setPools] = useState<PoolOption[]>([]);
  const [classes, setClasses] = useState<ClassGroup[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);
  const [skipDate, setSkipDate] = useState("");
  const [skipReason, setSkipReason] = useState("");
  // "Başka sınıflara uygula": açık panelin plan id'si + seçili sınıflar + son sonuçlar.
  const [applyPlanId, setApplyPlanId] = useState<string | null>(null);
  const [applyClassIds, setApplyClassIds] = useState<string[]>([]);
  const [applyResults, setApplyResults] = useState<ApplyResult[] | null>(null);
  // Üretilen katılım linkleri slot bazında gösterilir; ham token yalnız bu state'te yaşar.
  const [joinLinks, setJoinLinks] = useState<Record<string, JoinLinks>>({});
  // Slot bazlı yoklama görünümü (okul kendi öğrencisini TAM ADLA görür — okul-scoped ekran).
  const [attendance, setAttendance] = useState<Record<string, SlotAttendance>>({});

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [poolsRes, classesRes, plansRes] = await Promise.all([
        trpc.schedule.listPools.query(),
        trpc.roster.listClassGroups.query(),
        trpc.schedule.listPlans.query(),
      ]);
      setPools(poolsRes);
      setClasses(classesRes);
      setPlans(plansRes);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSlots = useCallback(async (planId: string | null) => {
    if (!planId) {
      setSlots([]);
      return;
    }
    try {
      setSlots(await trpc.schedule.listSlots.query({ planId }));
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadSlots(selectedPlanId);
  }, [selectedPlanId, loadSlots]);

  async function run(action: () => Promise<unknown>, successMsg: string | null) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      if (successMsg) setNotice(successMsg);
      await load();
      await loadSlots(selectedPlanId);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submitPlan(e: React.FormEvent) {
    e.preventDefault();
    const startMinute = hhmmToMinute(form.time);
    const weeks = Number(form.weeks);
    if (!form.classGroupId || !form.poolId) {
      setActionError("Sınıf ve havuz seçin");
      return;
    }
    if (startMinute === null) {
      setActionError("Geçerli bir saat girin (örn. 14:30)");
      return;
    }
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) {
      setActionError("Hafta sayısı 1-52 arasında olmalı");
      return;
    }
    void run(async () => {
      const res = await trpc.schedule.createPlan.mutate({
        classGroupId: form.classGroupId,
        poolId: form.poolId,
        weekday: Number(form.weekday),
        startMinute,
        startDate: form.startDate,
        weeks,
      });
      setForm(EMPTY_FORM);
      setSelectedPlanId(res.planId);
      const m = res.materialize;
      setNotice(
        `Reçete kaydedildi — ${m.created} slot oluştu` +
          (m.blocked > 0 ? `, ${m.blocked} tanesi bakiye yetersizliğinden bloke` : "") +
          (m.blocked > 0
            ? ". Bakiye yükleyip onaylandığında bloke dersler ~10 dakika içinde otomatik yeniden denenir."
            : "."),
      );
    }, null);
  }

  function cancelSlot(slot: Slot) {
    const hoursLeft = (new Date(slot.startsAt).getTime() - Date.now()) / 3_600_000;
    const message =
      hoursLeft >= 24
        ? "Derse 24 saatten fazla var: iptal ücretsizdir, tutar cüzdanınıza tam iade edilir. Devam edilsin mi?"
        : "DİKKAT: Derse 24 saatten az kaldı. İptal ederseniz tutarın yalnız %50'si iade edilir. Devam edilsin mi?";
    if (!window.confirm(message)) return;
    void run(async () => {
      const res = await trpc.schedule.cancelSlot.mutate({ slotId: slot.id });
      setNotice(
        res.status === "cancelled_school_early"
          ? "Ders iptal edildi — tutar cüzdanınıza tam iade edildi."
          : "Ders iptal edildi — geç iptal: tutarın %50'si iade edildi.",
      );
    }, null);
  }

  function fetchJoinLinks(slot: Slot) {
    void run(async () => {
      const links = await trpc.schedule.joinLinks.mutate({ slotId: slot.id });
      setJoinLinks((prev) => ({ ...prev, [slot.id]: links }));
      setNotice("Katılım linkleri üretildi — kopyalayıp eğitmene/sınıfa iletin.");
    }, null);
  }

  function toggleAttendance(slot: Slot) {
    if (attendance[slot.id]) {
      setAttendance((prev) => {
        const next = { ...prev };
        delete next[slot.id];
        return next;
      });
      return;
    }
    void run(async () => {
      const res = await trpc.schedule.slotAttendance.query({ slotId: slot.id });
      setAttendance((prev) => ({ ...prev, [slot.id]: res }));
    }, null);
  }

  function openDispute(slot: Slot) {
    if (!slot.sessionId) return;
    const reason = window.prompt(
      "İtiraz gerekçenizi yazın (örn. ders yapılmadı, süre hatalı):",
    );
    if (!reason || reason.trim().length < 3) return;
    void run(async () => {
      await trpc.schedule.openDispute.mutate({ sessionId: slot.sessionId!, reason: reason.trim() });
      setNotice("İtirazınız alındı — platform ekibi inceleyip sonucu bildirecek.");
    }, null);
  }

  function toggleApplyPanel(plan: Plan) {
    if (applyPlanId === plan.id) {
      setApplyPlanId(null);
      setApplyClassIds([]);
      setApplyResults(null);
      return;
    }
    setApplyPlanId(plan.id);
    setApplyClassIds([]);
    setApplyResults(null);
  }

  function submitApply(plan: Plan) {
    if (applyClassIds.length === 0) {
      setActionError("En az bir sınıf seçin");
      return;
    }
    void run(async () => {
      const res = await trpc.schedule.applyPlanToClasses.mutate({
        planId: plan.id,
        classGroupIds: applyClassIds,
      });
      setApplyResults(res.results);
      setApplyClassIds([]);
      const okCount = res.results.filter((r) => r.planId && !r.error).length;
      setNotice(`Plan ${okCount} sınıfa uygulandı — sınıf başına sonuç aşağıda.`);
    }, null);
  }

  function cancelPlan(plan: Plan) {
    const confirmed = window.confirm(
      "Gelecek dersler iptal edilir: 24 saatten uzak olanlar ücretsiz, yakın olanlar %50 kesintili. Plan iptal edilsin mi?",
    );
    if (!confirmed) return;
    void run(async () => {
      const res = await trpc.schedule.cancelPlan.mutate({ planId: plan.id });
      const parts = [
        `${res.cancelledFree} ders ücretsiz iptal edildi`,
        `${res.cancelledLate} ders %50 kesintiyle iptal edildi`,
      ];
      if (res.failedCount > 0) {
        parts.push(`${res.failedCount} ders iptal edilemedi (takvimden kontrol edin)`);
      }
      setNotice(`Plan iptal edildi — ${parts.join(", ")}.`);
    }, null);
  }

  function addSkip(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPlanId) return;
    void run(async () => {
      const res = await trpc.schedule.addSkipWeek.mutate({
        planId: selectedPlanId,
        skipDate,
        ...(skipReason.trim() ? { reason: skipReason.trim() } : {}),
      });
      setSkipDate("");
      setSkipReason("");
      setNotice(
        (res.created ? "Atlama haftası kaydedildi" : "Bu tarih zaten atlanıyor") +
          (res.note ? ` — ${res.note}` : "."),
      );
    }, null);
  }

  if (loading) return <main className="muted">Yükleniyor…</main>;

  if (loadError) {
    return (
      <main>
        <h1>Ders programı</h1>
        <div className="card">
          <p className="error">{loadError}</p>
          <p className="muted">
            Okul üyeliğiniz yoksa önce <a href="/kayit">okul kaydını</a> tamamlayın.
          </p>
        </div>
      </main>
    );
  }

  const selectedPlan = plans.find((p) => p.id === selectedPlanId) ?? null;

  return (
    <main>
      <h1>Ders programı</h1>
      <p className="muted">
        <a href="/okul">← Okul paneline dön</a>
      </p>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      <div className="card">
        <h2>Yeni reçete (haftalık ders planı)</h2>
        <p className="muted">
          Reçeteyi kaydettiğiniz anda önümüzdeki 4 haftanın dersleri planlanır, ders ücretleri
          cüzdanınızdan bloke edilir ve eğitmen araması başlar.
        </p>
        <form onSubmit={submitPlan}>
          <div className="row">
            <div>
              <label htmlFor="pl-class">Sınıf</label>
              <select
                id="pl-class"
                value={form.classGroupId}
                onChange={(e) => setForm({ ...form, classGroupId: e.target.value })}
                required
              >
                <option value="">Seçin…</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {classes.length === 0 ? (
                <p className="muted">
                  Önce <a href="/okul/siniflar">sınıf oluşturun</a>.
                </p>
              ) : null}
            </div>
            <div>
              <label htmlFor="pl-pool">Ders havuzu</label>
              <select
                id="pl-pool"
                value={form.poolId}
                onChange={(e) => setForm({ ...form, poolId: e.target.value })}
                required
              >
                <option value="">Seçin…</option>
                {pools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatCents(p.sellPerLessonCents)} / {p.lessonMinutes} dk ders
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="pl-weekday">Gün</label>
              <select
                id="pl-weekday"
                value={form.weekday}
                onChange={(e) => setForm({ ...form, weekday: e.target.value })}
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={String(i)}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="pl-time">Saat (okul saatiyle)</label>
              <input
                id="pl-time"
                type="time"
                value={form.time}
                onChange={(e) => setForm({ ...form, time: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="pl-start">Başlangıç tarihi</label>
              <input
                id="pl-start"
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="pl-weeks">Hafta sayısı</label>
              <input
                id="pl-weeks"
                inputMode="numeric"
                value={form.weeks}
                onChange={(e) => setForm({ ...form, weeks: e.target.value })}
                required
              />
            </div>
          </div>
          <button type="submit" disabled={busy || classes.length === 0}>
            Reçeteyi kaydet
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Reçeteler</h2>
        {plans.length === 0 ? (
          <div className="empty">Henüz reçete yok.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sınıf</th>
                  <th>Havuz</th>
                  <th>Gün / saat</th>
                  <th>Hafta</th>
                  <th>Slot</th>
                  <th>Durum</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id}>
                    <td>{p.className}</td>
                    <td>{p.poolName}</td>
                    <td>
                      {WEEKDAYS[p.weekday]} {minuteToHHMM(p.startMinute)} ({p.durationMin} dk)
                    </td>
                    <td>
                      {p.startDate} +{p.weeks}h
                    </td>
                    <td>
                      {p.scheduledCount}/{p.totalSlots}
                      {p.blockedCount > 0 ? (
                        <span
                          className="badge warn"
                          style={{ marginLeft: "0.35rem" }}
                          title="Bakiye yükleyip onaylandığında bloke dersler ~10 dakika içinde otomatik yeniden denenir."
                        >
                          {p.blockedCount} bloke
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <span className={`badge ${p.status === "active" ? "ok" : "warn"}`}>
                        {PLAN_STATUS_LABELS[p.status] ?? p.status}
                      </span>
                    </td>
                    <td>
                      <div className="actions">
                        <button
                          className="secondary"
                          onClick={() => setSelectedPlanId(p.id === selectedPlanId ? null : p.id)}
                        >
                          {p.id === selectedPlanId ? "Slotları gizle" : "Slotlar"}
                        </button>
                        {p.status === "active" ? (
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => trpc.schedule.pausePlan.mutate({ planId: p.id }),
                                "Plan duraklatıldı — yeni haftalar materialize edilmez",
                              )
                            }
                          >
                            Duraklat
                          </button>
                        ) : null}
                        {p.status === "paused" ? (
                          <button
                            className="secondary"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => trpc.schedule.resumePlan.mutate({ planId: p.id }),
                                "Plan yeniden aktif",
                              )
                            }
                          >
                            Devam ettir
                          </button>
                        ) : null}
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => toggleApplyPanel(p)}
                        >
                          {applyPlanId === p.id ? "Uygulamayı kapat" : "Başka sınıflara uygula"}
                        </button>
                        {p.status === "active" || p.status === "paused" ? (
                          <button
                            className="danger"
                            disabled={busy}
                            onClick={() => cancelPlan(p)}
                          >
                            Planı iptal et
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {applyPlanId
          ? (() => {
              const plan = plans.find((p) => p.id === applyPlanId);
              if (!plan) return null;
              const targets = classes.filter((c) => c.id !== plan.classGroupId);
              return (
                <div style={{ marginTop: "1rem" }}>
                  <h3>
                    &quot;{plan.className} — {WEEKDAYS[plan.weekday]} {minuteToHHMM(plan.startMinute)}
                    &quot; planını başka sınıflara uygula
                  </h3>
                  <p className="muted">
                    Seçilen her sınıf için aynı havuz, gün/saat ve hafta sayısıyla yeni reçete
                    oluşturulur; ders ücretleri cüzdanınızdan bloke edilir.
                  </p>
                  {targets.length === 0 ? (
                    <p className="muted">
                      Uygulanacak başka sınıf yok — önce <a href="/okul/siniflar">sınıf ekleyin</a>.
                    </p>
                  ) : (
                    <>
                      <ul style={{ listStyle: "none", padding: 0 }}>
                        {targets.map((c) => (
                          <li key={c.id} style={{ marginBottom: "0.35rem" }}>
                            <label>
                              <input
                                type="checkbox"
                                style={{ width: "auto", marginRight: "0.5rem" }}
                                checked={applyClassIds.includes(c.id)}
                                onChange={(e) =>
                                  setApplyClassIds((prev) =>
                                    e.target.checked
                                      ? [...prev, c.id]
                                      : prev.filter((id) => id !== c.id),
                                  )
                                }
                              />
                              {c.name}
                            </label>
                          </li>
                        ))}
                      </ul>
                      <button disabled={busy || applyClassIds.length === 0} onClick={() => submitApply(plan)}>
                        Seçili {applyClassIds.length} sınıfa uygula
                      </button>
                    </>
                  )}
                  {applyResults ? (
                    <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Sınıf</th>
                          <th>Sonuç</th>
                        </tr>
                      </thead>
                      <tbody>
                        {applyResults.map((r) => (
                          <tr key={r.classGroupId}>
                            <td>{r.className}</td>
                            <td>
                              {r.error ? (
                                <span className="badge warn">hata: {r.error}</span>
                              ) : (
                                <>
                                  <span className="badge ok">{r.scheduledCount} slot planlandı</span>
                                  {r.blockedCount > 0 ? (
                                    <span
                                      className="badge warn"
                                      style={{ marginLeft: "0.35rem" }}
                                      title="Bakiye yükleyip onaylandığında bloke dersler ~10 dakika içinde otomatik yeniden denenir."
                                    >
                                      bakiye yetersiz — {r.blockedCount} slot bloke
                                    </span>
                                  ) : null}
                                </>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  ) : null}
                </div>
              );
            })()
          : null}
      </div>

      {selectedPlan ? (
        <div className="card">
          <h2>
            Slotlar — {selectedPlan.className} / {selectedPlan.poolName}
          </h2>

          <form onSubmit={addSkip}>
            <div className="row">
              <div>
                <label htmlFor="skip-date">Hafta atla (tatil/sınav — ders tarihi)</label>
                <input
                  id="skip-date"
                  type="date"
                  value={skipDate}
                  onChange={(e) => setSkipDate(e.target.value)}
                  required
                />
              </div>
              <div>
                <label htmlFor="skip-reason">Gerekçe (opsiyonel)</label>
                <input
                  id="skip-reason"
                  value={skipReason}
                  onChange={(e) => setSkipReason(e.target.value)}
                  placeholder="örn. ara tatil"
                />
              </div>
              <div>
                <button type="submit" className="secondary" disabled={busy}>
                  Haftayı atla
                </button>
              </div>
            </div>
          </form>

          {slots.length === 0 ? (
            <div className="empty">Bu planda henüz slot yok.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tarih</th>
                    <th>Yerel saat</th>
                    <th>Durum</th>
                    <th>Eğitmen</th>
                    <th>Ders</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map((s) => {
                    const st = SLOT_STATUS[s.status] ?? { label: s.status, ok: false };
                    const links = joinLinks[s.id];
                    return (
                      <tr key={s.id}>
                        <td>{s.occurrenceKey}</td>
                        <td>{formatLocal(s.startsAt, s.schoolTz)}</td>
                        <td>
                          <span className={`badge ${st.ok ? "ok" : "warn"}`}>{st.label}</span>
                        </td>
                        <td>
                          {s.teacherName ?? (
                            <span className="muted">
                              {s.offerPending ? "teklif bekliyor" : "eğitmen aranıyor"}
                            </span>
                          )}
                        </td>
                        <td>
                          {s.sessionStatus ? (
                            <span className={`badge ${s.settled ? "ok" : "warn"}`}>
                              {SESSION_STATUS_LABELS[s.sessionStatus] ?? s.sessionStatus}
                              {s.dosageMin !== null ? ` · ${s.dosageMin} dk` : ""}
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <div className="actions">
                            {s.status === "scheduled" && s.teacherName ? (
                              <button
                                className="secondary"
                                disabled={busy}
                                onClick={() => fetchJoinLinks(s)}
                              >
                                Linkler
                              </button>
                            ) : null}
                            {s.status === "scheduled" ? (
                              <button
                                className="danger"
                                disabled={busy}
                                onClick={() => cancelSlot(s)}
                              >
                                İptal
                              </button>
                            ) : null}
                            {s.sessionId && s.settled ? (
                              <button
                                className="secondary"
                                disabled={busy}
                                onClick={() => openDispute(s)}
                              >
                                İtiraz et
                              </button>
                            ) : null}
                            {s.sessionId &&
                            (s.sessionStatus === "ended" || s.sessionStatus === "settled") ? (
                              <button
                                className="secondary"
                                disabled={busy}
                                onClick={() => toggleAttendance(s)}
                              >
                                {attendance[s.id] ? "Yoklamayı gizle" : "Yoklama"}
                              </button>
                            ) : null}
                          </div>
                          {attendance[s.id] ? (
                            <div style={{ marginTop: "0.35rem", fontSize: "0.85rem" }}>
                              {attendance[s.id]!.entries.length === 0 ? (
                                <span className="muted">Bu ders için yoklama girilmemiş.</span>
                              ) : (
                                <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
                                  {attendance[s.id]!.entries.map((a) => (
                                    <li key={a.studentId}>
                                      {a.fullName}{" "}
                                      <span className={`badge ${a.present ? "ok" : "warn"}`}>
                                        {a.present ? "katıldı" : "gelmedi"}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ) : null}
                          {links ? (
                            <div
                              className="mono"
                              style={{
                                marginTop: "0.35rem",
                                maxWidth: "24rem",
                                wordBreak: "break-all",
                                fontSize: "0.75rem",
                              }}
                            >
                              <div>
                                Eğitmen: <span style={{ userSelect: "all" }}>{links.teacherUrl}</span>
                              </div>
                              <div>
                                Sınıf: <span style={{ userSelect: "all" }}>{links.classUrl}</span>
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
      ) : null}
    </main>
  );
}
