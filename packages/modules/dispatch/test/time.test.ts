// Saf zaman matematiği testleri (DB'siz): DST duvar saati sabitliği ve weekday tabanı.
import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { occurrenceToUtc, utcToZoneMinutes } from "../src/index.js";

describe("occurrenceToUtc", () => {
  it("DST öncesi/sonrası duvar saati sabit, UTC offset kayar (America/New_York)", () => {
    // 2026 DST başlangıcı: 8 Mart Pazar. 2 Mart EST (UTC-5), 9 Mart EDT (UTC-4).
    const before = occurrenceToUtc("2026-03-02", 900, 60, "America/New_York");
    const after = occurrenceToUtc("2026-03-09", 900, 60, "America/New_York");

    expect(before.startsAt.toISOString()).toBe("2026-03-02T20:00:00.000Z");
    expect(after.startsAt.toISOString()).toBe("2026-03-09T19:00:00.000Z");

    // Her ikisi de lokal 15:00'te — duvar saati korunuyor
    for (const w of [before, after]) {
      const local = DateTime.fromJSDate(w.startsAt, { zone: "America/New_York" });
      expect(local.hour).toBe(15);
      expect(local.minute).toBe(0);
      // süre GERÇEK 60 dakika
      expect(w.endsAt.getTime() - w.startsAt.getTime()).toBe(60 * 60_000);
    }
  });

  it("geçersiz tarih/zone fırlatır", () => {
    expect(() => occurrenceToUtc("2026-13-40", 900, 60, "America/New_York")).toThrow();
    expect(() => occurrenceToUtc("2026-03-02", 900, 60, "Not/AZone")).toThrow();
  });
});

describe("utcToZoneMinutes", () => {
  it("weekday 0=Pazartesi (ISO) ve lokal dakika döner", () => {
    // 2026-03-02 20:00Z = Pazartesi 15:00 New York = Pazartesi 23:00 İstanbul
    const utc = new Date("2026-03-02T20:00:00.000Z");
    expect(utcToZoneMinutes(utc, "America/New_York")).toEqual({ weekday: 0, minute: 900 });
    expect(utcToZoneMinutes(utc, "Europe/Istanbul")).toEqual({ weekday: 0, minute: 1380 });

    // Pazar → 6; gün sınırı aşımı: İstanbul'da ertesi gün Pazartesi 02:00
    const sundayUtc = new Date("2026-03-08T23:00:00.000Z");
    expect(utcToZoneMinutes(sundayUtc, "America/New_York")).toEqual({ weekday: 6, minute: 1140 });
    expect(utcToZoneMinutes(sundayUtc, "Europe/Istanbul")).toEqual({ weekday: 0, minute: 120 });
  });
});
