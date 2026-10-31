const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'short',
  day: 'numeric'
});

const shortDayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric'
});

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit'
});

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  // Date-only values ("2026-04-30") must stay on that calendar day locally;
  // new Date() would read them as UTC midnight and shift the day in the west.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = dateOnly ? new Date(`${value}T00:00:00`) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatTime(value: string | null | undefined): string {
  const parsed = parseDate(value);
  return parsed ? timeFormat.format(parsed) : '—';
}

export function formatDay(value: string | Date | null | undefined): string {
  const parsed = value instanceof Date ? value : parseDate(value ?? null);
  return parsed ? dayFormat.format(parsed) : '—';
}

export function formatShortDay(value: string | Date | null | undefined): string {
  const parsed = value instanceof Date ? value : parseDate(value ?? null);
  return parsed ? shortDayFormat.format(parsed) : '—';
}

export function formatRange(
  start: string | null | undefined,
  end: string | null | undefined
): string {
  const from = parseDate(start);
  const to = parseDate(end);
  if (!from || !to) return '—';
  return `${timeFormat.format(from)} – ${timeFormat.format(to)}`;
}

export function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

export function dayKey(value: Date): string {
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/** "Today", "Tomorrow", "in 4 days" — the label employees scan for first. */
export function relativeDay(value: string | null | undefined): string {
  const parsed = parseDate(value);
  if (!parsed) return '';
  const today = startOfLocalDay(new Date());
  const target = startOfLocalDay(parsed);
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return `In ${diff} days`;
  if (diff < 0) return `${Math.abs(diff)} days ago`;
  return formatShortDay(parsed);
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

export function formatDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (!hours) return `${rest}m`;
  if (!rest) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/** Hours between a shift's start/end, minus its unpaid break. */
export function shiftMinutes(start: string, end: string, breakMinutes: number): number {
  const from = parseDate(start);
  const to = parseDate(end);
  if (!from || !to) return 0;
  return Math.max(0, minutesBetween(from, to) - Math.max(0, breakMinutes));
}

export function formatDateInput(value: Date): string {
  return dayKey(value);
}

export function formatDateTimeInput(value: Date): string {
  const hours = `${value.getHours()}`.padStart(2, '0');
  const minutes = `${value.getMinutes()}`.padStart(2, '0');
  return `${dayKey(value)}T${hours}:${minutes}`;
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  on_duty: 'On the clock',
  break: 'On break',
  off_shift: 'Complete',
  pending: 'Pending',
  submitted: 'Submitted',
  under_review: 'In review',
  approved: 'Approved',
  denied: 'Denied',
  open: 'Open',
  pending_admin: 'Waiting on manager',
  cancelled: 'Cancelled',
  failed: 'Needs attention',
  applied: 'Sent',
  assigned: 'Assigned',
  in_progress: 'In progress',
  completed: 'Complete',
  done: 'Done'
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

/** Tone used by pills and dots across the app. */
export function statusTone(status: string | null | undefined): string {
  switch (status) {
    case 'approved':
    case 'done':
    case 'completed':
    case 'applied':
      return 'good';
    case 'denied':
    case 'failed':
    case 'cancelled':
      return 'bad';
    case 'pending':
    case 'submitted':
    case 'under_review':
    case 'open':
    case 'pending_admin':
    case 'in_progress':
      return 'warm';
    case 'on_duty':
    case 'break':
      return 'live';
    default:
      return 'neutral';
  }
}
