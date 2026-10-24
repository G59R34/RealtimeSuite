function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Parse "HH:MM" to minutes since midnight (0–1439). */
export function parseHHMMToMinutes(hhmm: string): number {
  const [h, m] = hhmm.trim().split(':').map(Number);
  const hour = Number.isFinite(h) ? h : 0;
  const min = Number.isFinite(m) ? m : 0;
  return (hour * 60 + min) % (24 * 60);
}

/** Format minutes since midnight to "HH:MM". */
export function minutesToHHMM(totalMinutes: number): string {
  const normalized = ((Math.floor(totalMinutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function toTimeHHMM(value: string): string {
  const date = new Date(value);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function todayDateInputValue(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function localDayRange(dateValue: string): { startIso: string; endIso: string } {
  const [year, month, day] = dateValue.split('-').map(Number);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export function toReadableDate(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

/** Time only, e.g. "2:00 PM" — for same-day task ranges. */
export function toReadableTime(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}
