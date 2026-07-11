"use client";

// Okul sınıf/roster sayfası: sınıf oluştur + toplu öğrenci import + sınıf başına liste.
// Veri minimizasyonu (çocuk-PII v3): yalnız ad-soyad + sınıf adı; başka alan toplanmaz.
import { useCallback, useEffect, useState } from "react";
import { errorMessage, trpc } from "../../../lib/trpc";
import { SUPPORT_EMAIL } from "../../../lib/support";

interface ClassWithStudents {
  classGroupId: string;
  className: string;
  count: number;
  students: { id: string; fullName: string }[];
}

interface AttendanceReport {
  completedLessons: number;
  markedLessons: number;
  unmarkedLessons: number;
  students: {
    studentId: string;
    fullName: string;
    attended: number;
    rate: number | null;
  }[];
}

/** "Ad Soyad;Sınıf" satırlarını import satırlarına çevirir; bozuk satırları raporlar. */
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

export default function SiniflarPage() {
  const [classes, setClasses] = useState<ClassWithStudents[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [className, setClassName] = useState("");
  const [classLevel, setClassLevel] = useState("");
  const [importText, setImportText] = useState("");
  // Sınıf bazlı devam raporu (okul kendi öğrencisini TAM ADLA görür — okul-scoped ekran).
  const [reports, setReports] = useState<Record<string, AttendanceReport>>({});
  // P1-E: son import'ta zaten var olduğu için atlanan mükerrer satırlar.
  const [skipped, setSkipped] = useState<{ fullName: string; className: string }[]>([]);

  function toggleReport(classGroupId: string) {
    if (reports[classGroupId]) {
      setReports((prev) => {
        const next = { ...prev };
        delete next[classGroupId];
        return next;
      });
      return;
    }
    void (async () => {
      setActionError(null);
      try {
        const res = await trpc.roster.attendanceReport.query({ classGroupId });
        setReports((prev) => ({ ...prev, [classGroupId]: res }));
      } catch (err) {
        setActionError(errorMessage(err));
      }
    })();
  }

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setClasses(await trpc.roster.listStudents.query());
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

  // P1-E: öğrenci roster'dan çıkarılır (soft-delete) — geçmiş kayıtlar korunur, devam
  // raporundan düşer. Ders/eğitmen yüzüne bağlı değil, yalnız okul-scoped.
  function archiveStudent(student: { id: string; fullName: string }) {
    const confirmed = window.confirm(
      `${student.fullName} roster'dan çıkarılsın mı? Geçmiş kayıtlar korunur, devam raporundan düşer.`,
    );
    if (!confirmed) return;
    void run(async () => {
      await trpc.roster.archiveStudent.mutate({ studentId: student.id });
    }, "Öğrenci roster'dan çıkarıldı.");
  }

  if (loading) return <main className="muted">Yükleniyor…</main>;

  if (loadError) {
    return (
      <main>
        <h1>Sınıflar</h1>
        <div className="card">
          <p className="error">{loadError}</p>
          <p className="muted">
            Okul üyeliğiniz yoksa önce <a href="/kayit">okul kaydını</a> tamamlayın.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Sınıflar ve öğrenciler</h1>
      <p className="muted">
        <a href="/okul">← Okul paneline dön</a>
      </p>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      <div className="card">
        <h2>Yeni sınıf</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await trpc.roster.createClassGroup.mutate({
                name: className,
                ...(classLevel ? { level: classLevel } : {}),
              });
              setClassName("");
              setClassLevel("");
            }, "Sınıf oluşturuldu");
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="cg-name">Sınıf adı</label>
              <input
                id="cg-name"
                value={className}
                onChange={(e) => setClassName(e.target.value)}
                placeholder="örn. 5-A"
                required
              />
            </div>
            <div>
              <label htmlFor="cg-level">Seviye (opsiyonel)</label>
              <input
                id="cg-level"
                value={classLevel}
                onChange={(e) => setClassLevel(e.target.value)}
                placeholder="örn. A2"
              />
            </div>
            <div>
              <button type="submit" disabled={busy}>
                Sınıf oluştur
              </button>
            </div>
          </div>
        </form>
      </div>

      <div className="card">
        <h2>Öğrenci import</h2>
        <p className="muted">
          Her satır: <span className="mono">Ad Soyad;Sınıf</span> — sınıf yoksa otomatik açılır.
        </p>
        <p className="muted">
          <strong>Veri minimizasyonu:</strong> yalnız ad-soyad girin; doğum tarihi, T.C. kimlik no,
          telefon, e-posta veya veli iletişim bilgisi <strong>GİRMEYİN</strong>. Bu alanlar
          toplanmaz ve saklanmaz.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const { rows, invalid } = parseStudentLines(importText);
            if (rows.length === 0) {
              setActionError("Geçerli satır bulunamadı");
              return;
            }
            void run(async () => {
              const res = await trpc.roster.importStudents.mutate({ rows });
              setImportText("");
              setSkipped(res.skipped);
              setNotice(
                `${res.created} öğrenci eklendi (${res.classGroups} sınıf)` +
                  (invalid.length > 0 ? ` — bozuk satırlar: ${invalid.join(", ")}` : ""),
              );
            }, "Öğrenciler eklendi");
          }}
        >
          <label htmlFor="st-rows">Satırlar</label>
          <textarea
            id="st-rows"
            rows={6}
            style={{ width: "100%", maxWidth: "40rem" }}
            placeholder={"Ayşe Yılmaz;5-A\nMehmet Demir;5-A\nZeynep Kaya;6-B"}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            required
          />
          <button type="submit" disabled={busy}>
            İçe aktar
          </button>
        </form>
        {skipped.length > 0 ? (
          <div style={{ marginTop: "0.75rem" }}>
            <span className="badge warn">
              {skipped.length} kayıt zaten var, atlandı
            </span>
            <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
              {skipped.map((s, i) => (
                <li key={`${s.fullName}-${s.className}-${i}`} className="muted">
                  {s.fullName} — {s.className}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h2>Sınıf listesi</h2>
        {classes.length === 0 ? (
          <div className="empty">Henüz sınıf yok.</div>
        ) : (
          classes.map((c) => {
            const report = reports[c.classGroupId];
            return (
              <div key={c.classGroupId} style={{ marginBottom: "1rem" }}>
                <p>
                  <strong>{c.className}</strong>{" "}
                  <span className="badge ok">{c.count} öğrenci</span>{" "}
                  <button
                    className="secondary"
                    style={{ marginTop: 0 }}
                    disabled={busy}
                    onClick={() => toggleReport(c.classGroupId)}
                  >
                    {report ? "Devam raporunu gizle" : "Devam raporu"}
                  </button>
                </p>
                {c.students.length === 0 ? (
                  <p className="muted">Bu sınıfta öğrenci yok.</p>
                ) : (
                  <ul style={{ listStyle: "none", margin: "0.3rem 0 0", padding: 0 }}>
                    {c.students.map((s) => (
                      <li
                        key={s.id}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.35rem",
                          marginRight: "0.7rem",
                          marginBottom: "0.35rem",
                        }}
                      >
                        <span className="muted">{s.fullName}</span>
                        <button
                          className="danger"
                          style={{ marginTop: 0, padding: "0.15rem 0.5rem", fontSize: "0.72rem" }}
                          disabled={busy}
                          onClick={() => archiveStudent(s)}
                        >
                          Çıkar
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {report ? (
                  <div style={{ marginTop: "0.5rem" }}>
                    {report.markedLessons === 0 ? (
                      <div className="empty">
                        Bu sınıfta yoklaması işaretlenmiş tamamlanmış ders yok.
                      </div>
                    ) : (
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Öğrenci</th>
                              <th>Katıldı</th>
                              <th>İşaretli ders</th>
                              <th>Devam %</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.students.map((s) => (
                              <tr key={s.studentId}>
                                <td>{s.fullName}</td>
                                <td>{s.attended}</td>
                                <td>{report.markedLessons}</td>
                                <td>
                                  {s.rate === null ? "—" : `%${Math.round(s.rate * 100)}`}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {report.unmarkedLessons > 0 ? (
                      <p className="muted">
                        Yoklama girilmemiş {report.unmarkedLessons} ders (orana dahil değil).
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <p className="muted">Sorularınız için: {SUPPORT_EMAIL}</p>
    </main>
  );
}
