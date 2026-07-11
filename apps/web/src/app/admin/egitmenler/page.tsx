"use client";

// Eğitmen/HR paneli (yalnız platform admin): pipeline, davet, toplu import,
// evrak durumu (satır içi), görüşme planla/sonuçlandır, eksik evrak kuyruğu.
// Sayfa herkese yüklenir; admin olmayan aktörün tüm çağrıları sunucuda FORBIDDEN ile düşer.
import { useCallback, useEffect, useState } from "react";
import { errorMessage, trpc } from "../../../lib/trpc";

type TeacherSource = "site" | "ilan" | "hrmasterz";
type TeacherStatus =
  | "invited"
  | "profile"
  | "docs_pending"
  | "interview"
  | "active"
  | "rejected"
  | "suspended";
type DocumentKind =
  | "contract"
  | "id_verification"
  | "country_clearance"
  | "tax_form"
  | "payout_method";
type DocumentStatus = "missing" | "submitted" | "verified" | "rejected" | "expired";

interface PipelineTeacher {
  id: string;
  fullName: string;
  email: string;
  source: TeacherSource;
  status: TeacherStatus;
  dispatchReady: boolean;
  payoutReady: boolean;
  createdAt: Date;
}

interface MissingDoc {
  teacherId: string;
  fullName: string;
  kind: DocumentKind;
  status: DocumentStatus;
}

interface OpenInterview {
  id: string;
  teacherId: string;
  teacherName: string;
  scheduledAt: Date | null;
}

interface Pool {
  id: string;
  key: string;
  name: string;
}

interface AvailabilityWindow {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  timezone: string;
}

const WEEKDAYS = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];

function minuteToHHMM(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function hhmmToMinute(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const minute = Number(m[1]) * 60 + Number(m[2]);
  return minute >= 0 && minute <= 1440 ? minute : null;
}

const EMPTY_AVAIL = { weekday: "0", start: "09:00", end: "18:00", timezone: "Europe/Istanbul" };

const SOURCE_LABELS: Record<TeacherSource, string> = {
  site: "Site",
  ilan: "İlan",
  hrmasterz: "HRMasterz",
};

const STATUS_LABELS: Record<TeacherStatus, string> = {
  invited: "Davetli",
  profile: "Profil",
  docs_pending: "Evrak bekliyor",
  interview: "Görüşme",
  active: "Aktif",
  rejected: "Reddedildi",
  suspended: "Askıda",
};

// DB trigger whitelist'iyle birebir: satır içi ilerletme yalnız geçerli hedefleri sunar.
const NEXT_STATUSES: Record<TeacherStatus, TeacherStatus[]> = {
  invited: ["profile", "active", "rejected"],
  profile: ["docs_pending", "rejected"],
  docs_pending: ["interview", "rejected"],
  interview: ["active", "rejected"],
  active: ["suspended"],
  suspended: ["active"],
  rejected: [],
};

const DOC_KINDS: { value: DocumentKind; label: string }[] = [
  { value: "contract", label: "Sözleşme" },
  { value: "id_verification", label: "Kimlik doğrulama" },
  { value: "country_clearance", label: "Ülke izni" },
  { value: "tax_form", label: "Vergi formu" },
  { value: "payout_method", label: "Ödeme yöntemi" },
];

const DOC_STATUSES: { value: DocumentStatus; label: string }[] = [
  { value: "missing", label: "Eksik" },
  { value: "submitted", label: "İletildi" },
  { value: "verified", label: "Doğrulandı" },
  { value: "rejected", label: "Reddedildi" },
  { value: "expired", label: "Süresi geçti" },
];

const DOC_KIND_LABELS = Object.fromEntries(DOC_KINDS.map((k) => [k.value, k.label])) as Record<
  DocumentKind,
  string
>;
const DOC_STATUS_LABELS = Object.fromEntries(DOC_STATUSES.map((s) => [s.value, s.label])) as Record<
  DocumentStatus,
  string
>;

const EMPTY_INVITE = {
  fullName: "",
  email: "",
  phone: "",
  country: "",
  source: "site" as TeacherSource,
};

interface DocDraft {
  kind: DocumentKind;
  status: DocumentStatus;
}

/** "Ad Soyad;email;TR" satırlarını import satırlarına çevirir; bozuk satırları raporlar. */
function parseImportLines(text: string): {
  rows: { fullName: string; email: string; country?: string }[];
  invalid: number[];
} {
  const rows: { fullName: string; email: string; country?: string }[] = [];
  const invalid: number[] = [];
  text.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed.split(";").map((p) => p.trim());
    const fullName = parts[0] ?? "";
    const email = parts[1] ?? "";
    const country = (parts[2] ?? "").toUpperCase();
    if (fullName.length < 2 || !email.includes("@")) {
      invalid.push(i + 1);
      return;
    }
    rows.push({ fullName, email, ...(country.length === 2 ? { country } : {}) });
  });
  return { rows, invalid };
}

export default function EgitmenlerPage() {
  const [teachers, setTeachers] = useState<PipelineTeacher[]>([]);
  const [missing, setMissing] = useState<MissingDoc[]>([]);
  const [interviews, setInterviews] = useState<OpenInterview[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [statusFilter, setStatusFilter] = useState<TeacherStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [invite, setInvite] = useState(EMPTY_INVITE);

  const [importText, setImportText] = useState("");
  const [importSource, setImportSource] = useState<TeacherSource>("hrmasterz");
  const [importDispatchReady, setImportDispatchReady] = useState(true);

  const [docDrafts, setDocDrafts] = useState<Record<string, DocDraft>>({});

  // Üretilen davet linkleri satır bazında gösterilir; ham token yalnız bu state'te yaşar.
  const [inviteLinks, setInviteLinks] = useState<Record<string, string>>({});

  // Eğitmen paneli linkleri (login'siz kalıcı panel) — aynı desen: ham token yalnız burada.
  const [panelLinks, setPanelLinks] = useState<Record<string, string>>({});

  const [schedTeacherId, setSchedTeacherId] = useState("");
  const [schedAt, setSchedAt] = useState("");

  const [ivId, setIvId] = useState("");
  const [ivExperience, setIvExperience] = useState("3");
  const [ivEnergy, setIvEnergy] = useState("3");
  const [ivDecision, setIvDecision] = useState<"accept" | "reject" | "hold">("accept");
  const [ivPoolId, setIvPoolId] = useState("");
  const [ivNotes, setIvNotes] = useState("");

  const [availTeacherId, setAvailTeacherId] = useState("");
  const [availability, setAvailability] = useState<AvailabilityWindow[]>([]);
  const [availForm, setAvailForm] = useState(EMPTY_AVAIL);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [pipelineRes, missingRes, interviewsRes, poolsRes] = await Promise.all([
        trpc.hr.pipeline.query(statusFilter ? { status: statusFilter } : undefined),
        trpc.hr.listMissingDocuments.query(),
        trpc.hr.listOpenInterviews.query(),
        trpc.hr.listPools.query(),
      ]);
      setTeachers(pipelineRes);
      setMissing(missingRes);
      setInterviews(interviewsRes);
      setPools(poolsRes);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAvailability = useCallback(async (teacherId: string) => {
    if (!teacherId) {
      setAvailability([]);
      return;
    }
    try {
      setAvailability(await trpc.admin.listAvailability.query({ teacherId }));
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadAvailability(availTeacherId);
  }, [availTeacherId, loadAvailability]);

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

  function docDraft(teacherId: string): DocDraft {
    return docDrafts[teacherId] ?? { kind: "contract", status: "submitted" };
  }

  if (loading) return <main className="muted">Yükleniyor…</main>;

  if (loadError) {
    return (
      <main>
        <h1>Eğitmen yönetimi</h1>
        <div className="card">
          <p className="error">{loadError}</p>
          <p className="muted">Bu sayfa yalnız platform yöneticileri içindir.</p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Eğitmen yönetimi</h1>
      <p className="muted">
        <a href="/admin">← Platform yönetimine dön</a>
      </p>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      <div className="card">
        <h2>Pipeline</h2>
        <div className="row">
          <div>
            <label htmlFor="status-filter">Durum filtresi</label>
            <select
              id="status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as TeacherStatus | "")}
            >
              <option value="">Tümü</option>
              {(Object.keys(STATUS_LABELS) as TeacherStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {teachers.length === 0 ? (
          <p className="muted">Kayıtlı eğitmen yok.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>E-posta</th>
                  <th>Durum</th>
                  <th>Kaynak</th>
                  <th>Dispatch</th>
                  <th>Payout</th>
                  <th>Durum ilerlet</th>
                  <th>Evrak güncelle</th>
                  <th>Davet linki</th>
                  <th>Panel linki</th>
                </tr>
              </thead>
              <tbody>
                {teachers.map((t) => {
                  const draft = docDraft(t.id);
                  const nexts = NEXT_STATUSES[t.status];
                  return (
                    <tr key={t.id}>
                      <td>{t.fullName}</td>
                      <td className="mono">{t.email}</td>
                      <td>
                        <span className={`badge ${t.status === "active" ? "ok" : "warn"}`}>
                          {STATUS_LABELS[t.status]}
                        </span>
                      </td>
                      <td>{SOURCE_LABELS[t.source]}</td>
                      <td>
                        {t.dispatchReady ? (
                          <span className="badge ok">hazır</span>
                        ) : (
                          <span className="badge warn">kapalı</span>
                        )}
                      </td>
                      <td>
                        {t.payoutReady ? (
                          <span className="badge ok">hazır</span>
                        ) : (
                          <span className="badge warn">kapalı</span>
                        )}
                      </td>
                      <td>
                        {nexts.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          <select
                            aria-label={`${t.fullName} durum ilerlet`}
                            value=""
                            disabled={busy}
                            onChange={(e) => {
                              const to = e.target.value as TeacherStatus;
                              if (!to) return;
                              void run(
                                () => trpc.hr.advanceStatus.mutate({ teacherId: t.id, to }),
                                `Durum güncellendi: ${STATUS_LABELS[to]}`,
                              );
                            }}
                          >
                            <option value="">Seç…</option>
                            {nexts.map((s) => (
                              <option key={s} value={s}>
                                {STATUS_LABELS[s]}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                          <select
                            aria-label={`${t.fullName} evrak türü`}
                            value={draft.kind}
                            disabled={busy}
                            onChange={(e) =>
                              setDocDrafts({
                                ...docDrafts,
                                [t.id]: { ...draft, kind: e.target.value as DocumentKind },
                              })
                            }
                          >
                            {DOC_KINDS.map((k) => (
                              <option key={k.value} value={k.value}>
                                {k.label}
                              </option>
                            ))}
                          </select>
                          <select
                            aria-label={`${t.fullName} evrak durumu`}
                            value={draft.status}
                            disabled={busy}
                            onChange={(e) =>
                              setDocDrafts({
                                ...docDrafts,
                                [t.id]: { ...draft, status: e.target.value as DocumentStatus },
                              })
                            }
                          >
                            {DOC_STATUSES.map((s) => (
                              <option key={s.value} value={s.value}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                          <button
                            className="secondary"
                            style={{ marginTop: 0 }}
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () =>
                                  trpc.hr.setDocument.mutate({
                                    teacherId: t.id,
                                    kind: draft.kind,
                                    status: draft.status,
                                  }),
                                "Evrak durumu güncellendi",
                              )
                            }
                          >
                            Kaydet
                          </button>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                          <button
                            className="secondary"
                            style={{ marginTop: 0 }}
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const res = await trpc.hr.createInvite.mutate({ teacherId: t.id });
                                setInviteLinks((prev) => ({ ...prev, [t.id]: res.url }));
                              }, "Davet linki üretildi — linki kopyalayıp eğitmene iletin")
                            }
                          >
                            Davet linki
                          </button>
                          <button
                            className="secondary"
                            style={{ marginTop: 0 }}
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await trpc.hr.revokeInvites.mutate({ teacherId: t.id });
                                setInviteLinks((prev) => {
                                  const next = { ...prev };
                                  delete next[t.id];
                                  return next;
                                });
                              }, "Açık davet linkleri iptal edildi")
                            }
                          >
                            İptal et
                          </button>
                        </div>
                        {inviteLinks[t.id] ? (
                          <div
                            className="mono"
                            style={{
                              marginTop: "0.35rem",
                              maxWidth: "18rem",
                              wordBreak: "break-all",
                              userSelect: "all",
                              fontSize: "0.75rem",
                            }}
                          >
                            {inviteLinks[t.id]}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
                          <button
                            className="secondary"
                            style={{ marginTop: 0 }}
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const res = await trpc.teacherPortal.createLink.mutate({
                                  teacherId: t.id,
                                });
                                setPanelLinks((prev) => ({ ...prev, [t.id]: res.url }));
                              }, "Panel linki üretildi — linki kopyalayıp eğitmene iletin")
                            }
                          >
                            Panel linki üret
                          </button>
                          <button
                            className="secondary"
                            style={{ marginTop: 0 }}
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await trpc.teacherPortal.revokeLinks.mutate({ teacherId: t.id });
                                setPanelLinks((prev) => {
                                  const next = { ...prev };
                                  delete next[t.id];
                                  return next;
                                });
                              }, "Panel linkleri iptal edildi")
                            }
                          >
                            İptal et
                          </button>
                        </div>
                        {panelLinks[t.id] ? (
                          <div
                            className="mono"
                            style={{
                              marginTop: "0.35rem",
                              maxWidth: "18rem",
                              wordBreak: "break-all",
                              userSelect: "all",
                              fontSize: "0.75rem",
                            }}
                          >
                            {panelLinks[t.id]}
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
        <h2>Eğitmen davet et</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await trpc.hr.invite.mutate({
                fullName: invite.fullName,
                email: invite.email,
                source: invite.source,
                ...(invite.phone ? { phone: invite.phone } : {}),
                ...(invite.country ? { country: invite.country.toUpperCase() } : {}),
              });
              setInvite(EMPTY_INVITE);
            }, "Davet oluşturuldu — eğitmen pipeline'a eklendi");
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="inv-name">Ad Soyad</label>
              <input
                id="inv-name"
                value={invite.fullName}
                onChange={(e) => setInvite({ ...invite, fullName: e.target.value })}
                required
              />
            </div>
            <div>
              <label htmlFor="inv-email">E-posta</label>
              <input
                id="inv-email"
                type="email"
                value={invite.email}
                onChange={(e) => setInvite({ ...invite, email: e.target.value })}
                required
              />
            </div>
          </div>
          <div className="row">
            <div>
              <label htmlFor="inv-phone">Telefon (opsiyonel)</label>
              <input
                id="inv-phone"
                value={invite.phone}
                onChange={(e) => setInvite({ ...invite, phone: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="inv-country">Ülke (opsiyonel, örn. TR)</label>
              <input
                id="inv-country"
                maxLength={2}
                value={invite.country}
                onChange={(e) => setInvite({ ...invite, country: e.target.value.toUpperCase() })}
              />
            </div>
            <div>
              <label htmlFor="inv-source">Kaynak</label>
              <select
                id="inv-source"
                value={invite.source}
                onChange={(e) => setInvite({ ...invite, source: e.target.value as TeacherSource })}
              >
                {(Object.keys(SOURCE_LABELS) as TeacherSource[]).map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="submit" disabled={busy}>
            Davet gönder
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Toplu import</h2>
        <p className="muted">
          Her satır: <span className="mono">Ad Soyad;email;TR</span> (ülke opsiyonel). E-postası
          kayıtlı olanlar atlanır.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const { rows, invalid } = parseImportLines(importText);
            if (rows.length === 0) {
              setActionError("Geçerli satır bulunamadı");
              return;
            }
            void run(async () => {
              const res = await trpc.hr.import.mutate({
                rows,
                source: importSource,
                dispatchReady: importDispatchReady,
              });
              setImportText("");
              setNotice(
                `Import tamam: ${res.created} eklendi, ${res.skipped} atlandı` +
                  (invalid.length > 0 ? ` (bozuk satırlar: ${invalid.join(", ")})` : ""),
              );
            }, "Import tamam");
          }}
        >
          <label htmlFor="imp-rows">Satırlar</label>
          <textarea
            id="imp-rows"
            rows={5}
            style={{ width: "100%", maxWidth: "40rem" }}
            placeholder={"Jane Doe;jane@example.com;US\nAli Veli;ali@example.com;TR"}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            required
          />
          <div className="row">
            <div>
              <label htmlFor="imp-source">Kaynak</label>
              <select
                id="imp-source"
                value={importSource}
                onChange={(e) => setImportSource(e.target.value as TeacherSource)}
              >
                {(Object.keys(SOURCE_LABELS) as TeacherSource[]).map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="imp-dispatch">
                <input
                  id="imp-dispatch"
                  type="checkbox"
                  style={{ width: "auto", marginRight: "0.4rem" }}
                  checked={importDispatchReady}
                  onChange={(e) => setImportDispatchReady(e.target.checked)}
                />
                Derse çıkmaya hazır (dispatch)
              </label>
              <p className="muted">Payout kapısı evrak seti tamamlanmadan açılmaz.</p>
            </div>
          </div>
          <button type="submit" disabled={busy}>
            İçe aktar
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Görüşme planla</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!schedTeacherId || !schedAt) {
              setActionError("Eğitmen ve tarih seçin");
              return;
            }
            void run(async () => {
              await trpc.hr.scheduleInterview.mutate({
                teacherId: schedTeacherId,
                scheduledAt: new Date(schedAt).toISOString(),
              });
              setSchedTeacherId("");
              setSchedAt("");
            }, "Görüşme planlandı");
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="sched-teacher">Eğitmen</label>
              <select
                id="sched-teacher"
                value={schedTeacherId}
                onChange={(e) => setSchedTeacherId(e.target.value)}
                required
              >
                <option value="">Seçin…</option>
                {teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName} ({STATUS_LABELS[t.status]})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="sched-at">Tarih / saat</label>
              <input
                id="sched-at"
                type="datetime-local"
                value={schedAt}
                onChange={(e) => setSchedAt(e.target.value)}
                required
              />
            </div>
            <div>
              <button type="submit" disabled={busy}>
                Planla
              </button>
            </div>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Görüşme sonuçlandır</h2>
        {interviews.length === 0 ? (
          <p className="muted">Açık görüşme yok.</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!ivId) {
                setActionError("Görüşme seçin");
                return;
              }
              void run(async () => {
                await trpc.hr.completeInterview.mutate({
                  interviewId: ivId,
                  experienceScore: Number(ivExperience),
                  energyScore: Number(ivEnergy),
                  decision: ivDecision,
                  ...(ivPoolId ? { decidedPoolId: ivPoolId } : {}),
                  ...(ivNotes ? { notes: ivNotes } : {}),
                });
                setIvId("");
                setIvNotes("");
                setIvPoolId("");
              }, "Görüşme sonuçlandırıldı");
            }}
          >
            <div className="row">
              <div>
                <label htmlFor="iv-id">Görüşme</label>
                <select id="iv-id" value={ivId} onChange={(e) => setIvId(e.target.value)} required>
                  <option value="">Seçin…</option>
                  {interviews.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.teacherName}
                      {i.scheduledAt ? ` — ${new Date(i.scheduledAt).toLocaleString("tr-TR")}` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="iv-exp">Deneyim (1-5)</label>
                <select id="iv-exp" value={ivExperience} onChange={(e) => setIvExperience(e.target.value)}>
                  {["1", "2", "3", "4", "5"].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="iv-energy">Enerji (1-5)</label>
                <select id="iv-energy" value={ivEnergy} onChange={(e) => setIvEnergy(e.target.value)}>
                  {["1", "2", "3", "4", "5"].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row">
              <div>
                <label htmlFor="iv-decision">Karar</label>
                <select
                  id="iv-decision"
                  value={ivDecision}
                  onChange={(e) => setIvDecision(e.target.value as "accept" | "reject" | "hold")}
                >
                  <option value="accept">Kabul</option>
                  <option value="reject">Ret</option>
                  <option value="hold">Beklet</option>
                </select>
              </div>
              <div>
                <label htmlFor="iv-pool">Havuz (kabulde)</label>
                <select id="iv-pool" value={ivPoolId} onChange={(e) => setIvPoolId(e.target.value)}>
                  <option value="">Seçim yok</option>
                  {pools.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="iv-notes">Not (opsiyonel)</label>
                <input id="iv-notes" value={ivNotes} onChange={(e) => setIvNotes(e.target.value)} />
              </div>
            </div>
            <button type="submit" disabled={busy}>
              Sonuçlandır
            </button>
          </form>
        )}
      </div>

      <div className="card">
        <h2>Müsaitlik (dispatch)</h2>
        <p className="muted">
          Eğitmen yalnız penceresi slotu TAM kapsıyorsa aday olur; pencere kendi saat dilimini
          taşır. 0=Pazartesi.
        </p>
        <div className="row">
          <div>
            <label htmlFor="av-teacher">Eğitmen</label>
            <select
              id="av-teacher"
              value={availTeacherId}
              onChange={(e) => setAvailTeacherId(e.target.value)}
            >
              <option value="">Seçin…</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.fullName} ({STATUS_LABELS[t.status]})
                </option>
              ))}
            </select>
          </div>
        </div>

        {availTeacherId ? (
          <>
            {availability.length === 0 ? (
              <p className="muted">Bu eğitmenin aktif müsaitlik penceresi yok.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Gün</th>
                    <th>Aralık</th>
                    <th>Saat dilimi</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {availability.map((w) => (
                    <tr key={w.id}>
                      <td>{WEEKDAYS[w.weekday]}</td>
                      <td className="mono">
                        {minuteToHHMM(w.startMinute)}–{minuteToHHMM(w.endMinute)}
                      </td>
                      <td>{w.timezone}</td>
                      <td>
                        <button
                          className="secondary"
                          style={{ marginTop: 0 }}
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await trpc.admin.removeAvailability.mutate({ id: w.id });
                              await loadAvailability(availTeacherId);
                            }, "Müsaitlik penceresi kaldırıldı")
                          }
                        >
                          Kaldır
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const startMinute = hhmmToMinute(availForm.start);
                const endMinute = hhmmToMinute(availForm.end);
                if (startMinute === null || endMinute === null || endMinute <= startMinute) {
                  setActionError("Geçerli bir saat aralığı girin (bitiş başlangıçtan sonra)");
                  return;
                }
                void run(async () => {
                  await trpc.admin.addAvailability.mutate({
                    teacherId: availTeacherId,
                    weekday: Number(availForm.weekday),
                    startMinute,
                    endMinute,
                    timezone: availForm.timezone.trim(),
                  });
                  await loadAvailability(availTeacherId);
                }, "Müsaitlik penceresi eklendi");
              }}
            >
              <div className="row">
                <div>
                  <label htmlFor="av-weekday">Gün</label>
                  <select
                    id="av-weekday"
                    value={availForm.weekday}
                    onChange={(e) => setAvailForm({ ...availForm, weekday: e.target.value })}
                  >
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={String(i)}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="av-start">Başlangıç</label>
                  <input
                    id="av-start"
                    type="time"
                    value={availForm.start}
                    onChange={(e) => setAvailForm({ ...availForm, start: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="av-end">Bitiş</label>
                  <input
                    id="av-end"
                    type="time"
                    value={availForm.end}
                    onChange={(e) => setAvailForm({ ...availForm, end: e.target.value })}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="av-tz">Saat dilimi</label>
                  <input
                    id="av-tz"
                    value={availForm.timezone}
                    onChange={(e) => setAvailForm({ ...availForm, timezone: e.target.value })}
                    placeholder="Europe/Istanbul"
                    required
                  />
                </div>
                <div>
                  <button type="submit" disabled={busy}>
                    Pencere ekle
                  </button>
                </div>
              </div>
            </form>
          </>
        ) : (
          <p className="muted">Müsaitlik pencerelerini görmek için eğitmen seçin.</p>
        )}
      </div>

      <div className="card">
        <h2>Eksik evrak kuyruğu</h2>
        <p className="muted">
          Payout kapısı: 5 evrakın tamamı doğrulanmadan eğitmen ödemesi açılmaz.
        </p>
        {missing.length === 0 ? (
          <p className="muted">Eksik evrak yok.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Eğitmen</th>
                <th>Evrak</th>
                <th>Durum</th>
              </tr>
            </thead>
            <tbody>
              {missing.map((m) => (
                <tr key={`${m.teacherId}-${m.kind}`}>
                  <td>{m.fullName}</td>
                  <td>{DOC_KIND_LABELS[m.kind]}</td>
                  <td>
                    <span className="badge warn">{DOC_STATUS_LABELS[m.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
