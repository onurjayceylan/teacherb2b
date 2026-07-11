// Yeni 4 şablonun render'ı (DB'siz saf birim test): eğitmen-yüzlüler İNGİLİZCE
// (Türkçe karakter sızmaz), okul-yüzlüler TÜRKÇE. + platform_alert'in chargeback dalı.
import { describe, expect, test } from "vitest";
import { renderTemplate } from "../src/notification-dispatcher.js";

const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/;

describe("eğitmen-yüzlü şablonlar (İngilizce)", () => {
  test("teacher_slot_cancelled: erken iptal — %50 cümlesi YOK; Türkçe karakter yok", () => {
    const r = renderTemplate("teacher_slot_cancelled", {
      slotStartsAt: "2026-07-20T09:00:00Z",
      schoolName: "Acme School",
      teacherTimezone: "Europe/Istanbul",
      lateCancel: false,
    });
    expect(r.subject).toContain("Lesson cancelled");
    expect(r.html).toContain("Acme School");
    expect(r.html).toContain("cancelled by the school");
    expect(r.html).not.toContain("50%");
    expect(TURKISH_LETTERS.test(r.subject)).toBe(false);
    expect(TURKISH_LETTERS.test(r.html)).toBe(false);
  });

  test("teacher_slot_cancelled: geç iptal — '50%' ödeme bilgisi VAR", () => {
    const r = renderTemplate("teacher_slot_cancelled", {
      slotStartsAt: "2026-07-20T09:00:00Z",
      schoolName: "Acme School",
      teacherTimezone: "Europe/Istanbul",
      lateCancel: true,
    });
    expect(r.html).toContain("you are paid 50%");
    expect(TURKISH_LETTERS.test(r.subject)).toBe(false);
    expect(TURKISH_LETTERS.test(r.html)).toBe(false);
  });

  test("teacher_interview_scheduled: tarih + meetingUrl linki; URL yoksa link yok", () => {
    const withUrl = renderTemplate("teacher_interview_scheduled", {
      scheduledAt: "2026-08-01T09:00:00Z",
      teacherTimezone: "America/New_York",
      meetingUrl: "https://meet.example.com/abc",
    });
    expect(withUrl.subject).toContain("interview is scheduled");
    expect(withUrl.html).toContain("https://meet.example.com/abc");
    expect(TURKISH_LETTERS.test(withUrl.subject)).toBe(false);
    expect(TURKISH_LETTERS.test(withUrl.html)).toBe(false);

    const withoutUrl = renderTemplate("teacher_interview_scheduled", {
      scheduledAt: "2026-08-01T09:00:00Z",
      teacherTimezone: "America/New_York",
    });
    expect(withoutUrl.html).not.toContain("<a href");
    expect(TURKISH_LETTERS.test(withoutUrl.html)).toBe(false);
  });
});

describe("okul-yüzlü şablonlar (Türkçe)", () => {
  test("school_dispute_resolved: refunded → iade cümlesi + tutar", () => {
    const r = renderTemplate("school_dispute_resolved", {
      outcome: "refunded",
      slotStartsAt: "2026-07-20T09:00:00Z",
      schoolName: "Test Okul",
      refundedCents: 4_000,
    });
    expect(r.subject).toContain("itirazınız sonuçlandı");
    expect(r.html).toContain("kabul edildi");
    expect(r.html).toContain("$40.00");
    expect(r.html).toContain("iade edildi");
  });

  test("school_dispute_resolved: released → red cümlesi, iade yok", () => {
    const r = renderTemplate("school_dispute_resolved", {
      outcome: "released",
      slotStartsAt: "2026-07-20T09:00:00Z",
      schoolName: "Test Okul",
    });
    expect(r.html).toContain("reddedildi");
    expect(r.html).not.toContain("iade edildi");
  });

  test("school_topup_settled: tutar + referans kodu", () => {
    const r = renderTemplate("school_topup_settled", {
      schoolName: "Test Okul",
      amountCents: 75_000,
      referenceCode: "TN-AB12CD34",
    });
    expect(r.subject).toContain("$750.00");
    expect(r.html).toContain("TN-AB12CD34");
    expect(r.html).toContain("bakiyenize eklendi");

    // referans kodu yoksa (NULL) parantezli bölüm hiç girmez
    const noRef = renderTemplate("school_topup_settled", {
      schoolName: "Test Okul",
      amountCents: 75_000,
      referenceCode: null,
    });
    expect(noRef.html).not.toContain("referans");
  });
});

describe("platform_alert", () => {
  test("chargeback dalı: kill-switch dili YERİNE kart itirazı dili", () => {
    const r = renderTemplate("platform_alert", {
      kind: "chargeback",
      checks: ["chargeback_lost"],
      detail: "dispute=dp_1 amount_cents=50000 status=lost",
    });
    expect(r.subject).toContain("kart itirazı");
    expect(r.subject).not.toContain("kill-switch");
    expect(r.html).toContain("chargeback_lost");
    expect(r.html).toContain("dp_1");
  });

  test("sentinel dalı (kind'sız) değişmedi", () => {
    const r = renderTemplate("platform_alert", {
      checks: ["ledger_sum"],
      detail: "detay",
    });
    expect(r.subject).toContain("kill-switch");
  });
});
