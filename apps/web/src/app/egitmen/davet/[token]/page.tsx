"use client";

// Public eğitmen onboarding'i: davet token'ı URL'de taşınır, tüm yetki sunucuda
// (teacherOnboarding.* uçları token'ı her istekte doğrular). Login yok.
// Akış: profil → sözleşme (clickwrap) → evrak beyanı; durumlar get'ten çizilir.
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { errorMessage, trpc } from "../../../../lib/trpc";

type DocumentKind =
  | "contract"
  | "id_verification"
  | "country_clearance"
  | "tax_form"
  | "payout_method";
type DocumentStatus = "missing" | "submitted" | "verified" | "rejected" | "expired";
type Step = "profile" | "contract" | "documents" | "review";

interface OnboardingData {
  teacherId: string;
  fullName: string;
  status: string;
  country: string | null;
  timezone: string;
  phone: string | null;
  documents: { kind: DocumentKind; status: DocumentStatus }[];
  step: Step;
}

const STEPS: { key: Step; label: string }[] = [
  { key: "profile", label: "1. Profil" },
  { key: "contract", label: "2. Sözleşme" },
  { key: "documents", label: "3. Evrak beyanı" },
  { key: "review", label: "4. İnceleme" },
];

const DECLARABLE_KINDS: { kind: Exclude<DocumentKind, "contract">; label: string; hint: string }[] = [
  { kind: "id_verification", label: "Kimlik doğrulama", hint: "Kimlik belgenizi hazırladıysanız beyan edin." },
  { kind: "country_clearance", label: "Ülke izni", hint: "Çalışma/öğretme izni belgeniz." },
  { kind: "tax_form", label: "Vergi formu", hint: "Ülkenize uygun vergi formu." },
  { kind: "payout_method", label: "Ödeme yöntemi", hint: "Ödeme alacağınız hesap bilgisi." },
];

const DOC_STATUS_LABELS: Record<DocumentStatus, string> = {
  missing: "Eksik",
  submitted: "İletildi",
  verified: "Doğrulandı",
  rejected: "Reddedildi",
  expired: "Süresi geçti",
};

const CONTRACT_PLACEHOLDER = `EĞİTMEN HİZMET SÖZLEŞMESİ (ÖZET — YER TUTUCU)

1. Taraflar: Teachernow platformu ile aşağıda adı yazılı eğitmen.
2. Konu: Eğitmen, platform üzerinden okullara çevrimiçi ders verir.
3. Ödeme: Ders başına ücret, evrak seti tamamlanıp doğrulanmadan ödeme yapılmaz.
4. Gizlilik: Öğrenci ve okul verileri üçüncü kişilerle paylaşılamaz.
5. Fesih: Taraflar 14 gün önceden bildirimle sözleşmeyi sonlandırabilir.

Bu metin pilot dönem yer tutucusudur; nihai sözleşme metni hukuk onayıyla güncellenecektir.
Adınızı yazıp onaylayarak sözleşmeyi elektronik olarak kabul etmiş olursunuz.`;

function statusBadgeClass(status: DocumentStatus): string {
  return status === "submitted" || status === "verified" ? "badge ok" : "badge warn";
}

export default function EgitmenDavetPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [data, setData] = useState<OnboardingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [timezone, setTimezone] = useState("");
  const [typedName, setTypedName] = useState("");
  const [docNotes, setDocNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!token) return;
    setLoadError(null);
    try {
      const res = await trpc.teacherOnboarding.get.query({ token });
      setData(res as OnboardingData);
      setPhone(res.phone ?? "");
      setCountry(res.country ?? "");
      setTimezone(res.timezone ?? "");
    } catch (err) {
      setData(null);
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

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

  if (!data) {
    return (
      <main>
        <h1>Eğitmen daveti</h1>
        <div className="card">
          <p className="error">Bu davet bağlantısı kullanılamıyor.</p>
          <p className="muted">
            Bağlantı geçersiz, süresi dolmuş ya da iptal edilmiş olabilir. Sizi davet eden
            Teachernow yetkilisinden yeni bir bağlantı isteyebilirsiniz.
          </p>
          {loadError ? <p className="muted">Ayrıntı: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  const contract = data.documents.find((d) => d.kind === "contract");
  const contractDone =
    contract !== undefined && (contract.status === "submitted" || contract.status === "verified");

  return (
    <main>
      <h1>Hoş geldiniz, {data.fullName}</h1>
      <p className="muted">
        Teachernow eğitmen kaydınızı tamamlamak için aşağıdaki adımları izleyin. İlerlemeniz
        kaydedilir; bu sayfaya aynı bağlantıyla geri dönebilirsiniz.
      </p>

      <div className="card">
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          {STEPS.map((s) => (
            <span
              key={s.key}
              className={s.key === data.step ? "badge ok" : "badge"}
              aria-current={s.key === data.step ? "step" : undefined}
            >
              {s.label}
              {s.key === data.step ? " (şu an)" : ""}
            </span>
          ))}
        </div>
      </div>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      <div className="card">
        <h2>1. Profil bilgileri</h2>
        {data.step !== "profile" ? (
          <p className="success">Profil adımı tamamlandı. Bilgilerinizi yine de güncelleyebilirsiniz.</p>
        ) : (
          <p className="muted">Telefon, ülke ve saat dilimi bilgilerinizi doldurup kaydedin.</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                trpc.teacherOnboarding.submitProfile.mutate({
                  token,
                  ...(phone.trim() ? { phone: phone.trim() } : {}),
                  ...(country.trim().length === 2 ? { country: country.trim().toUpperCase() } : {}),
                  ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
                }),
              "Profil kaydedildi",
            );
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="ob-phone">Telefon</label>
              <input
                id="ob-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+90 5xx xxx xx xx"
              />
            </div>
            <div>
              <label htmlFor="ob-country">Ülke (2 harf, örn. TR)</label>
              <input
                id="ob-country"
                maxLength={2}
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                placeholder="TR"
              />
            </div>
            <div>
              <label htmlFor="ob-tz">Saat dilimi</label>
              <input
                id="ob-tz"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Europe/Istanbul"
              />
            </div>
          </div>
          <button type="submit" disabled={busy}>
            Profili kaydet
          </button>
        </form>
      </div>

      <div className="card">
        <h2>2. Sözleşme</h2>
        {contractDone ? (
          <p className="success">
            Sözleşme kabul edildi{" "}
            <span className={statusBadgeClass(contract.status)}>
              {DOC_STATUS_LABELS[contract.status]}
            </span>
          </p>
        ) : data.step === "profile" ? (
          <p className="muted">Önce profil adımını tamamlayın.</p>
        ) : (
          <>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                maxHeight: "14rem",
                overflowY: "auto",
                border: "1px solid var(--muted)",
                borderRadius: "6px",
                padding: "0.75rem",
                fontSize: "0.85rem",
              }}
            >
              {CONTRACT_PLACEHOLDER}
            </pre>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  () =>
                    trpc.teacherOnboarding.acceptContract.mutate({
                      token,
                      typedName: typedName.trim(),
                    }),
                  "Sözleşme kabul edildi",
                );
              }}
            >
              <label htmlFor="ob-typed-name">Adımı yazarak kabul ediyorum</label>
              <input
                id="ob-typed-name"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                placeholder={data.fullName}
                required
                minLength={2}
              />
              <button type="submit" disabled={busy || typedName.trim().length < 2}>
                Sözleşmeyi kabul et
              </button>
            </form>
          </>
        )}
      </div>

      <div className="card">
        <h2>3. Evrak beyanı</h2>
        <p className="muted">
          Her evrak için &quot;yükledim / beyan ediyorum&quot; deyin; ekibimiz beyanınızı
          inceleyip doğrular. Doğrulama tamamlanmadan ödeme açılmaz.
        </p>
        {data.step === "profile" || (!contractDone && data.step === "contract") ? (
          <p className="muted">Önce profil ve sözleşme adımlarını tamamlayın.</p>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>Evrak</th>
              <th>Durum</th>
              <th>Not (opsiyonel)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {DECLARABLE_KINDS.map(({ kind, label, hint }) => {
              const doc = data.documents.find((d) => d.kind === kind);
              const status: DocumentStatus = doc?.status ?? "missing";
              const declared = status === "submitted" || status === "verified";
              return (
                <tr key={kind}>
                  <td>
                    {label}
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      {hint}
                    </div>
                  </td>
                  <td>
                    <span className={statusBadgeClass(status)}>{DOC_STATUS_LABELS[status]}</span>
                  </td>
                  <td>
                    <input
                      aria-label={`${label} notu`}
                      value={docNotes[kind] ?? ""}
                      onChange={(e) => setDocNotes({ ...docNotes, [kind]: e.target.value })}
                      placeholder="örn. belge referansı"
                    />
                  </td>
                  <td>
                    <button
                      className="secondary"
                      style={{ marginTop: 0 }}
                      disabled={busy || !contractDone}
                      onClick={() => {
                        const note = (docNotes[kind] ?? "").trim();
                        void run(
                          () =>
                            trpc.teacherOnboarding.declareDocument.mutate({
                              token,
                              kind,
                              ...(note ? { note } : {}),
                            }),
                          `${label}: beyan alındı`,
                        );
                      }}
                    >
                      {declared ? "Tekrar beyan et" : "Yükledim / beyan ediyorum"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data.step === "review" ? (
        <div className="card">
          <h2>4. İnceleme</h2>
          <p className="success">
            Tüm adımlar tamamlandı. Ekibimiz beyanlarınızı doğrulayacak ve görüşme için sizinle
            iletişime geçecek. Bu sayfayı kapatabilirsiniz.
          </p>
        </div>
      ) : null}
    </main>
  );
}
