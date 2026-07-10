"use client";

// Okul sınıf/roster sayfası: sınıf oluştur + toplu öğrenci import + sınıf başına liste.
// Veri minimizasyonu (çocuk-PII v3): yalnız ad-soyad + sınıf adı; başka alan toplanmaz.
import { useCallback, useEffect, useState } from "react";
import { errorMessage, trpc } from "../../../lib/trpc";

interface ClassWithStudents {
  classGroupId: string;
  className: string;
  count: number;
  students: { id: string; fullName: string }[];
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
      </div>

      <div className="card">
        <h2>Sınıf listesi</h2>
        {classes.length === 0 ? (
          <p className="muted">Henüz sınıf yok.</p>
        ) : (
          classes.map((c) => (
            <div key={c.classGroupId} style={{ marginBottom: "1rem" }}>
              <p>
                <strong>{c.className}</strong>{" "}
                <span className="badge ok">{c.count} öğrenci</span>
              </p>
              {c.students.length === 0 ? (
                <p className="muted">Bu sınıfta öğrenci yok.</p>
              ) : (
                <p className="muted">{c.students.map((s) => s.fullName).join(", ")}</p>
              )}
            </div>
          ))
        )}
      </div>
    </main>
  );
}
