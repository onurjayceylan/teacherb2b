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

const CONTRACT_PLACEHOLDER = `TEACHER SERVICES AGREEMENT (SUMMARY — PILOT PLACEHOLDER)

1. Parties: The Teachernow platform and the teacher named below.
2. Scope: The teacher delivers online lessons to schools through the platform as an
   independent contractor.
3. Pay: You are paid per lesson. Your per-lesson rate is shown on every offer you
   receive and in your teacher panel before you accept any lesson.
4. Payouts: Payouts run every 2 weeks via Wise. Payouts start only after your
   document set has been verified by our team.
5. Cancellations: If a school cancels a lesson less than 24 hours before its start
   time, you are paid 50% of your per-lesson rate for that lesson.
6. No-shows: Missing a confirmed lesson without notice is recorded as a no-show.
   Repeated no-shows may lead to suspension from the platform (3 strikes).
7. Confidentiality: Student and school data must not be shared with third parties.
8. Termination: Either party may end this agreement with 14 days written notice.

This is a pilot-period agreement; the final version is subject to legal review and
will replace this text. By typing your name and confirming below you accept this
agreement electronically.`;

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

  if (loading) return <main className="muted">Loading…</main>;

  if (!data) {
    return (
      <main>
        <h1>Teacher invitation</h1>
        <div className="card">
          <p className="error">This invitation link cannot be used.</p>
          <p className="muted">
            The link may be invalid, expired, or revoked. Please ask the Teachernow team member
            who invited you for a new link.
          </p>
          {loadError ? <p className="muted">Details: {loadError}</p> : null}
        </div>
      </main>
    );
  }

  const contract = data.documents.find((d) => d.kind === "contract");
  const contractDone =
    contract !== undefined && (contract.status === "submitted" || contract.status === "verified");

  return (
    <main>
      <h1>Welcome, {data.fullName}</h1>
      <p className="muted">
        Follow the steps below to complete your Teachernow teacher registration. Your progress is
        saved — you can return to this page anytime using the same link.
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
              {s.key === data.step ? " (current)" : ""}
            </span>
          ))}
        </div>
      </div>

      {actionError ? <p className="error">{actionError}</p> : null}
      {notice ? <p className="success">{notice}</p> : null}

      <div className="card">
        <h2>1. Profile details</h2>
        {data.step !== "profile" ? (
          <p className="success">Profile step completed. You can still update your details.</p>
        ) : (
          <p className="muted">Fill in your phone number, country, and time zone, then save.</p>
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
        <h2>2. Agreement</h2>
        {contractDone ? (
          <p className="success">
            Agreement accepted{" "}
            <span className={statusBadgeClass(contract.status)}>
              {DOC_STATUS_LABELS[contract.status]}
            </span>
          </p>
        ) : data.step === "profile" ? (
          <p className="muted">Please complete the profile step first.</p>
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
                  "Agreement accepted",
                );
              }}
            >
              <label htmlFor="ob-typed-name">I accept by typing my full name</label>
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
        <h2>3. Document declarations</h2>
        <p className="muted">
          For each document, declare that you have it ready ("I have uploaded / I declare"). Our
          team will review and verify your declarations. Payouts stay locked until verification
          is complete.
        </p>
        {data.step === "profile" || (!contractDone && data.step === "contract") ? (
          <p className="muted">Please complete the profile and agreement steps first.</p>
        ) : null}
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

      {data.step === "review" ? (
        <div className="card">
          <h2>4. Review</h2>
          <p className="success">
            All steps completed. Our team will verify your declarations and contact you to
            schedule an interview. You can close this page.
          </p>
        </div>
      ) : null}
    </main>
  );
}
