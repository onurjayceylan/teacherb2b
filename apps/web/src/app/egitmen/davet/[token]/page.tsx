"use client";

// Public eğitmen onboarding'i: davet token'ı URL'de taşınır, tüm yetki sunucuda
// (teacherOnboarding.* uçları token'ı her istekte doğrular). Login yok.
// Akış: profil → sözleşme (clickwrap) → evrak beyanı; durumlar get'ten çizilir.
// DİL: EĞİTMEN YÜZÜ İNGİLİZCE — hedef arz native ESL (Filipinler vb.), Türkçe anlamıyor.
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
type PayoutMethod = "wise_email" | "iban";

interface MaskedPayout {
  method: PayoutMethod;
  maskedValue: string;
  accountHolder: string;
}

interface OnboardingData {
  teacherId: string;
  fullName: string;
  status: string;
  country: string | null;
  timezone: string;
  phone: string | null;
  documents: { kind: DocumentKind; status: DocumentStatus }[];
  step: Step;
  payoutDetails: MaskedPayout | null;
}

const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  wise_email: "Wise e-mail",
  iban: "IBAN",
};

/** Client-side IANA check so the teacher sees an English error before submitting. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const STEPS: { key: Step; label: string }[] = [
  { key: "profile", label: "1. Profile" },
  { key: "contract", label: "2. Agreement" },
  { key: "documents", label: "3. Documents" },
  { key: "review", label: "4. Review" },
];

const DECLARABLE_KINDS: { kind: Exclude<DocumentKind, "contract">; label: string; hint: string }[] = [
  { kind: "id_verification", label: "ID verification", hint: "Confirm that you have your government-issued ID ready." },
  { kind: "country_clearance", label: "Background / police clearance", hint: "A clearance certificate valid in your country (e.g. NBI clearance)." },
  { kind: "tax_form", label: "Tax form", hint: "The tax form applicable in your country." },
  { kind: "payout_method", label: "Payout method", hint: "The account details where you want to receive payouts (e.g. Wise)." },
];

const DOC_STATUS_LABELS: Record<DocumentStatus, string> = {
  missing: "Missing",
  submitted: "Submitted",
  verified: "Verified",
  rejected: "Rejected",
  expired: "Expired",
};

// Yaygın eğitmen saat dilimleri — datalist önerisi (serbest IANA girişi de geçerli).
const COMMON_TIMEZONES = [
  "Asia/Manila",
  "Europe/Istanbul",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Africa/Johannesburg",
  "Africa/Lagos",
  "Asia/Kolkata",
  "Asia/Ho_Chi_Minh",
  "Asia/Jakarta",
  "Australia/Sydney",
];

// Sözleşme metni — içerik CONTRACT_PLACEHOLDER ile bire bir aynı; yalnız okunur
// tipografi (başlık + numaralı madde listesi) için yapılandırıldı.
const CONTRACT_TITLE = "Teacher Services Agreement (summary — pilot placeholder)";
const CONTRACT_CLAUSES: { term: string; text: string }[] = [
  { term: "Parties", text: "The Teachernow platform and the teacher named below." },
  {
    term: "Scope",
    text: "The teacher delivers online lessons to schools through the platform as an independent contractor.",
  },
  {
    term: "Pay",
    text: "You are paid per lesson. Your per-lesson rate is shown on every offer you receive and in your teacher panel before you accept any lesson.",
  },
  {
    term: "Payouts",
    text: "Payouts run every 2 weeks via Wise. Payouts start only after your document set has been verified by our team.",
  },
  {
    term: "Cancellations",
    text: "If a school cancels a lesson less than 24 hours before its start time, you are paid 50% of your per-lesson rate for that lesson.",
  },
  {
    term: "No-shows",
    text: "Missing a confirmed lesson without notice is recorded as a no-show. Repeated no-shows may lead to suspension from the platform (3 strikes).",
  },
  {
    term: "Confidentiality",
    text: "Student and school data must not be shared with third parties.",
  },
  {
    term: "Termination",
    text: "Either party may end this agreement with 14 days written notice.",
  },
];
const CONTRACT_FOOTNOTE =
  "This is a pilot-period agreement; the final version is subject to legal review and will " +
  "replace this text. By typing your name and confirming below you accept this agreement " +
  "electronically.";

function statusBadgeClass(status: DocumentStatus): string {
  return status === "submitted" || status === "verified" ? "badge ok" : "badge warn";
}

// Kart başlığı + tamamlandı rozeti aynı satırda (yalnız sunum).
const SECTION_HEAD: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.55rem",
  flexWrap: "wrap",
  marginBottom: "0.7rem",
};

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
  const [payoutMethod, setPayoutMethod] = useState<PayoutMethod>("wise_email");
  const [payoutValue, setPayoutValue] = useState("");
  const [payoutHolder, setPayoutHolder] = useState("");

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

  if (loading) return <main className="muted">Loading…</main>;

  if (!data) {
    return (
      <main>
        <h1>Teacher invitation</h1>
        <div className="card">
          <p className="muted">
            This invitation link cannot be used: it may be invalid, expired, or revoked. Please
            ask the Teachernow team member who invited you for a new link.
          </p>
          <p>
            <a href="/egitmen/link">Lost your link? Request a new one →</a>
          </p>
          {loadError ? <p className="muted">Details: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  const contract = data.documents.find((d) => d.kind === "contract");
  const contractDone =
    contract !== undefined && (contract.status === "submitted" || contract.status === "verified");
  const stepIndex = STEPS.findIndex((s) => s.key === data.step);
  const profileDone = stepIndex > 0;
  const documentsDone = data.step === "review";

  return (
    <main>
      <h1>Welcome, {data.fullName}</h1>
      <p className="muted">
        Follow the steps below to complete your Teachernow teacher registration. Your progress is
        saved — you can return to this page anytime using the same link.
      </p>

      <div className="card">
        <div className="actions" style={{ gap: "0.5rem" }}>
          {STEPS.map((s, i) => (
            <span
              key={s.key}
              className={i < stepIndex ? "badge ok" : s.key === data.step ? "badge info" : "badge"}
              style={
                i > stepIndex
                  ? { color: "var(--muted)", borderColor: "var(--hairline)" }
                  : undefined
              }
              aria-current={s.key === data.step ? "step" : undefined}
            >
              {i < stepIndex ? "✓ " : ""}
              {s.label}
              {s.key === data.step ? " (current)" : ""}
            </span>
          ))}
        </div>
      </div>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      <div className="card">
        <div style={SECTION_HEAD}>
          <h2 style={{ margin: 0 }}>1. Profile details</h2>
          {profileDone ? <span className="badge ok">Completed</span> : null}
        </div>
        {profileDone ? (
          <p className="muted">Profile step completed. You can still update your details.</p>
        ) : (
          <p className="muted">Fill in your phone number, country, and time zone, then save.</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (timezone.trim() && !isValidTimezone(timezone.trim())) {
              setActionError("Please enter a valid time zone, e.g. Asia/Manila.");
              return;
            }
            void run(
              () =>
                trpc.teacherOnboarding.submitProfile.mutate({
                  token,
                  ...(phone.trim() ? { phone: phone.trim() } : {}),
                  ...(country.trim().length === 2 ? { country: country.trim().toUpperCase() } : {}),
                  ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
                }),
              "Profile saved",
            );
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="ob-phone">Phone (with country code)</label>
              <input
                id="ob-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+63 917 123 4567"
              />
            </div>
            <div>
              <label htmlFor="ob-country">Country (2-letter code, e.g. PH)</label>
              <input
                id="ob-country"
                maxLength={2}
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                placeholder="PH"
              />
            </div>
            <div>
              <label htmlFor="ob-tz">Time zone</label>
              <input
                id="ob-tz"
                list="ob-tz-options"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Asia/Manila"
              />
              <datalist id="ob-tz-options">
                {COMMON_TIMEZONES.map((tz) => (
                  <option key={tz} value={tz} />
                ))}
              </datalist>
            </div>
          </div>
          <button type="submit" disabled={busy}>
            Save profile
          </button>
        </form>
      </div>

      <div className="card">
        <div style={SECTION_HEAD}>
          <h2 style={{ margin: 0 }}>2. Agreement</h2>
          {contractDone ? (
            <span className={statusBadgeClass(contract.status)}>
              ✓ {DOC_STATUS_LABELS[contract.status]}
            </span>
          ) : null}
        </div>
        {contractDone ? (
          <p className="success" style={{ marginBottom: 0 }}>
            Agreement accepted — nothing more to do in this step.
          </p>
        ) : data.step === "profile" ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Please complete the profile step first.
          </p>
        ) : (
          <>
            <div
              style={{
                maxHeight: "16rem",
                overflowY: "auto",
                border: "1px solid var(--hairline)",
                borderRadius: "var(--r-md)",
                padding: "1rem 1.2rem",
                background: "rgba(255, 255, 255, 0.5)",
                fontSize: "0.88rem",
              }}
            >
              <p style={{ marginTop: 0, fontWeight: 650 }}>{CONTRACT_TITLE}</p>
              <ol style={{ margin: 0, paddingLeft: "1.25rem" }}>
                {CONTRACT_CLAUSES.map((c) => (
                  <li key={c.term} style={{ marginBottom: "0.45rem" }}>
                    <strong>{c.term}.</strong> {c.text}
                  </li>
                ))}
              </ol>
              <p className="muted" style={{ marginBottom: 0 }}>{CONTRACT_FOOTNOTE}</p>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  () =>
                    trpc.teacherOnboarding.acceptContract.mutate({
                      token,
                      typedName: typedName.trim(),
                    }),
                  "Agreement accepted",
                );
              }}
              style={{
                marginTop: "0.9rem",
                padding: "0.9rem 1.1rem",
                border: "1px solid rgba(10, 124, 255, 0.3)",
                borderRadius: "var(--r-md)",
                background: "var(--info-tint)",
              }}
            >
              <label htmlFor="ob-typed-name" style={{ marginTop: 0 }}>
                I accept this agreement — type your full name to sign
              </label>
              <input
                id="ob-typed-name"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                placeholder={data.fullName}
                required
                minLength={2}
              />
              <button type="submit" disabled={busy || typedName.trim().length < 2}>
                Accept agreement
              </button>
            </form>
          </>
        )}
      </div>

      <div className="card">
        <div style={SECTION_HEAD}>
          <h2 style={{ margin: 0 }}>3. Document declarations</h2>
          {documentsDone ? <span className="badge ok">Completed</span> : null}
        </div>
        <p className="muted">
          For each document, declare that you have it ready ("I have uploaded / I declare"). Our
          team will review and verify your declarations. Payouts stay locked until verification
          is complete.
        </p>
        {data.step === "profile" || (!contractDone && data.step === "contract") ? (
          <p className="muted">Please complete the profile and agreement steps first.</p>
        ) : null}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Status</th>
                <th>Note (optional)</th>
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
                        aria-label={`${label} note`}
                        value={docNotes[kind] ?? ""}
                        onChange={(e) => setDocNotes({ ...docNotes, [kind]: e.target.value })}
                        placeholder="e.g. document reference"
                      />
                    </td>
                    <td>
                      <button
                        className="secondary"
                        style={{ marginTop: 0, padding: "0.3rem 0.75rem", fontSize: "0.8rem" }}
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
                            `${label}: declaration received`,
                          );
                        }}
                      >
                        {declared ? "Declare again" : "I have it / I declare"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div style={SECTION_HEAD}>
          <h2 style={{ margin: 0 }}>Payout details (Wise)</h2>
          {data.payoutDetails ? (
            <span className="badge ok">On file</span>
          ) : (
            <span className="badge warn">Not set</span>
          )}
        </div>
        <p className="muted">
          Optional — you can skip this step and add it later from your teacher panel. Add your
          payout details to receive payments.
        </p>
        {data.payoutDetails ? (
          <p>
            <span className="badge info">{PAYOUT_METHOD_LABELS[data.payoutDetails.method]}</span>{" "}
            <span className="mono">{data.payoutDetails.maskedValue}</span>{" "}
            <span className="muted">
              — account holder {data.payoutDetails.accountHolder}. You can update it below.
            </span>
          </p>
        ) : (
          <p className="muted">No payout details on file yet.</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await trpc.teacherOnboarding.setPayoutDetails.mutate({
                token,
                details: {
                  method: payoutMethod,
                  value: payoutValue.trim(),
                  accountHolder: payoutHolder.trim(),
                },
              });
              setPayoutValue("");
              setPayoutHolder("");
            }, "Payout details saved");
          }}
        >
          <div className="row">
            <div>
              <label htmlFor="po-method">Method</label>
              <select
                id="po-method"
                value={payoutMethod}
                onChange={(e) => setPayoutMethod(e.target.value as PayoutMethod)}
              >
                <option value="wise_email">Wise e-mail</option>
                <option value="iban">IBAN</option>
              </select>
            </div>
            <div>
              <label htmlFor="po-value">
                {payoutMethod === "wise_email" ? "Wise account e-mail" : "IBAN"}
              </label>
              <input
                id="po-value"
                value={payoutValue}
                onChange={(e) => setPayoutValue(e.target.value)}
                placeholder={payoutMethod === "wise_email" ? "you@example.com" : "TR00 0000 ..."}
                required
                minLength={5}
              />
            </div>
            <div>
              <label htmlFor="po-holder">Account holder (full legal name)</label>
              <input
                id="po-holder"
                value={payoutHolder}
                onChange={(e) => setPayoutHolder(e.target.value)}
                placeholder={data.fullName}
                required
                minLength={2}
              />
            </div>
          </div>
          <button type="submit" disabled={busy}>
            Save payout details
          </button>
        </form>
      </div>

      {data.step === "review" ? (
        <div className="card">
          <div style={SECTION_HEAD}>
            <h2 style={{ margin: 0 }}>4. Review</h2>
            <span className="badge ok">All steps completed</span>
          </div>
          <p className="success" style={{ marginBottom: 0 }}>
            All steps completed. Our team will verify your declarations and contact you to
            schedule an interview. You can close this page.
          </p>
        </div>
      ) : null}
    </main>
  );
}
