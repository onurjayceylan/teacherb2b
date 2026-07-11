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
}

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
  escalated: { label: "eskalasyon", ok: false },
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
          (m.blocked > 0 ? ". Bakiye yükledikten sonra materializer yeniden dener." : "."),
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
          <p className="muted">Henüz reçete yok.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
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
                        <span className="badge warn" style={{ marginLeft: "0.35rem" }}>
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
                      <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                        <button
                          className="secondary"
                          style={{ marginTop: 0 }}
                          onClick={() => setSelectedPlanId(p.id === selectedPlanId ? null : p.id)}
                        >
                          {p.id === selectedPlanId ? "Slotları gizle" : "Slotlar"}
                        </button>
                        {p.status === "active" ? (
                          <button
                            className="secondary"
                            style={{ marginTop: 0 }}
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
                            style={{ marginTop: 0 }}
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
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
            <p className="muted">Bu planda henüz slot yok.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Tarih</th>
                    <th>Yerel saat</th>
                    <th>Durum</th>
                    <th>Eğitmen</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map((s) => {
                    const st = SLOT_STATUS[s.status] ?? { label: s.status, ok: false };
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
                          {s.status === "scheduled" ? (
                            <button
                              className="secondary"
                              style={{ marginTop: 0 }}
                              disabled={busy}
                              onClick={() => cancelSlot(s)}
                            >
                              İptal
                            </button>
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
