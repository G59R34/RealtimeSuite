export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value.length <= 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

export function formatTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return '—';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatRange(start: string | null, end: string | null): string {
  if (!start && !end) return '—';
  return `${formatTime(start)} – ${formatTime(end)}`;
}

export function formatMoney(value: number | string | null | undefined): string {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return '—';
  return amount.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  });
}

export function formatNumber(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function formatHours(minutes: number): string {
  return `${formatNumber(minutes / 60, 1)}h`;
}

export function relativeTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return 'Never';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'Just now';
  const minutes = Math.round(abs / 60);
  if (minutes < 60) return seconds > 0 ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return seconds > 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return seconds > 0 ? `${days}d ago` : `in ${days}d`;
}

export function toDateInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function monthEnd(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

export function minutesBetween(start: string | null, end: string | null): number {
  const from = parseDate(start);
  const to = parseDate(end);
  if (!from || !to) return 0;
  return Math.max(0, (to.getTime() - from.getTime()) / 60000);
}

export function badgeTone(value: string | null | undefined): string {
  const key = (value ?? '').toLowerCase();
  if (['approved', 'done', 'completed', 'active', 'on_duty', 'ok', 'on_shift', 'scheduled'].includes(key)) {
    return 'good';
  }
  if (['pending', 'draft', 'break', 'in_progress', 'open', 'warn', 'paused'].includes(key)) {
    return 'warn';
  }
  if (['denied', 'cancelled', 'rejected', 'failed', 'error', 'archived', 'off_shift', 'closed'].includes(key)) {
    return 'bad';
  }
  return 'neutral';
}

export function humanize(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
