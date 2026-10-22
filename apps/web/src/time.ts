// Every time the app shows is in the owner's own time zone (the browser's), in a friendly format, and never
// says "UTC": "2:14 AM" today, "Tomorrow 2:14 AM", "Oct 24, 2:14 AM". Pure apart from reading the zone, and
// `now` is a parameter so each rule is easy to test.

const clockOf = (d: Date): string => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "2:14 AM": the time of day, in the owner's time zone. */
export const clock = (ms: number): string => clockOf(new Date(ms));

/** A time of day and, when it is not today, which day: "2:14 AM", "Tomorrow 2:14 AM", "Oct 24, 2:14 AM", "Yesterday 9:05 PM". */
export function friendlyWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now);
  if (sameDay(d, today)) return clockOf(d);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (sameDay(d, tomorrow)) return `Tomorrow ${clockOf(d)}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${clockOf(d)}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clockOf(d)}`;
}

/** An hour of the day from a working-hours setting ("22" or 22), as a clock time: "10 PM". */
export function hourLabel(hour: number): string {
  const d = new Date(2000, 0, 1, hour, 0);
  return d.toLocaleTimeString([], { hour: "numeric", ...(hour % 1 ? { minute: "2-digit" } : {}) });
}

/** What a status line says once it has a resume time: "Waiting for tokens" becomes "Waiting for tokens until 2:14 AM". */
export function withResume(live: string, resumesAt: number | undefined | null, now = Date.now()): string {
  return resumesAt ? `${live} until ${friendlyWhen(resumesAt, now)}` : live;
}

/** A date without a time, in the owner's zone: "Oct 22" (with the year when it is not this year). */
export function dayLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" as const };
  return d.toLocaleDateString([], { month: "short", day: "numeric", ...year });
}
