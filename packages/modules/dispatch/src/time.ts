// Zaman matematiğinin TEK kaynağı: luxon. Occurrence kimliği okul-lokal DUVAR SAATİDİR;
// UTC'ye çeviri DST-güvenli yapılır (duvar saati sabit kalır, offset değişir).
import { DateTime } from "luxon";

export interface UtcWindow {
  startsAt: Date;
  endsAt: Date;
}

/**
 * Okul-lokal duvar saatini UTC pencereye çevirir.
 * dateISO 'YYYY-MM-DD' okul-lokal tarih; startMinute gün içi dakika (duvar saati).
 * DST geçişinde duvar saati korunur: 15:00 lokal her zaman 15:00 lokaldir,
 * UTC karşılığı offset'e göre kayar. Bitiş = başlangıç + durationMin GERÇEK dakika.
 */
export function occurrenceToUtc(
  dateISO: string,
  startMinute: number,
  durationMin: number,
  tz: string,
): UtcWindow {
  const parts = dateISO.split("-").map(Number);
  const [year, month, day] = parts;
  if (parts.length !== 3 || !year || !month || !day) {
    throw new Error(`occurrenceToUtc: geçersiz tarih: ${dateISO}`);
  }
  const start = DateTime.fromObject(
    {
      year,
      month,
      day,
      hour: Math.floor(startMinute / 60),
      minute: startMinute % 60,
    },
    { zone: tz },
  );
  if (!start.isValid) {
    throw new Error(`occurrenceToUtc: geçersiz zaman (${dateISO} ${startMinute} ${tz})`);
  }
  const end = start.plus({ minutes: durationMin });
  return { startsAt: start.toJSDate(), endsAt: end.toJSDate() };
}

export interface ZoneMinutes {
  /** 0=Pazartesi ... 6=Pazar (ISO) */
  weekday: number;
  /** Gün içi dakika (lokal duvar saati) */
  minute: number;
}

/** UTC anını verilen timezone'un duvar saatine çevirir (eğitmen müsaitlik kontrolü için). */
export function utcToZoneMinutes(dateUtc: Date, tz: string): ZoneMinutes {
  const dt = DateTime.fromJSDate(dateUtc, { zone: tz });
  if (!dt.isValid) {
    throw new Error(`utcToZoneMinutes: geçersiz timezone: ${tz}`);
  }
  // luxon weekday: 1=Pazartesi..7=Pazar → ISO-Pazartesi-0 tabanına indir
  return { weekday: dt.weekday - 1, minute: dt.hour * 60 + dt.minute };
}
