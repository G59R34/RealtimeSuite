import type { CorpData, Employee, Shift, Site } from '../types';
import { minutesBetween, parseDate } from './format';

export const ACTIVE_SHIFT_STATUSES = ['on_duty', 'break'];

export function shiftMinutes(shift: Shift): number {
  const worked = Number(shift.worked_minutes ?? 0);
  if (worked > 0) return worked;
  return minutesBetween(shift.start_at, shift.end_at);
}

export function isShiftActive(shift: Shift, now = new Date()): boolean {
  if (shift.status && ACTIVE_SHIFT_STATUSES.includes(shift.status)) return true;
  const start = parseDate(shift.start_at);
  const end = parseDate(shift.end_at);
  if (!start || !end) return false;
  return start <= now && now < end;
}

export function shiftsInRange(shifts: Shift[], from: Date, to: Date): Shift[] {
  return shifts.filter((shift) => {
    const start = parseDate(shift.start_at);
    if (!start) return false;
    return start >= from && start < to;
  });
}

export function monthShifts(shifts: Shift[], month: Date): Shift[] {
  const from = new Date(month.getFullYear(), month.getMonth(), 1);
  const to = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  return shiftsInRange(shifts, from, to);
}

export function dayBounds(day: string): { from: Date; to: Date } {
  const [year, month, date] = day.split('-').map(Number);
  const from = new Date(year, (month ?? 1) - 1, date ?? 1);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

export interface PayrollRow {
  employeeId: string;
  siteId: string;
  name: string;
  site: string;
  role: string;
  rate: number;
  shiftCount: number;
  minutes: number;
  gross: number;
}

export function payrollRows(
  data: CorpData,
  month: Date,
  siteFilter: string
): PayrollRow[] {
  const shifts = monthShifts(data.shifts, month).filter(
    (shift) => !siteFilter || shift.site_id === siteFilter
  );
  const employees = new Map<string, Employee>();
  for (const employee of data.employees) employees.set(employee.id, employee);
  const sites = new Map<string, Site>();
  for (const site of data.sites) sites.set(site.id, site);

  const rows = new Map<string, PayrollRow>();
  for (const shift of shifts) {
    const id = shift.employee_id ?? `unassigned-${shift.site_id}`;
    const employee = shift.employee_id ? employees.get(shift.employee_id) : undefined;
    const rate = Number(employee?.hourly_rate ?? 0);
    const row =
      rows.get(id) ??
      ({
        employeeId: id,
        siteId: employee?.site_id ?? shift.site_id,
        name: shift.employee_name ?? employee?.full_name ?? 'Unassigned shift',
        site: sites.get(shift.site_id)?.name ?? '—',
        role: employee?.role ?? 'employee',
        rate,
        shiftCount: 0,
        minutes: 0,
        gross: 0
      } satisfies PayrollRow);
    const minutes = shiftMinutes(shift);
    const multiplier = Number(shift.pay_multiplier ?? 1) || 1;
    row.shiftCount += 1;
    row.minutes += minutes;
    row.gross += (minutes / 60) * rate * multiplier;
    rows.set(id, row);
  }
  return [...rows.values()].sort((a, b) => b.gross - a.gross);
}

export interface PayrollTotals {
  minutes: number;
  gross: number;
  employees: number;
  shifts: number;
}

export function payrollTotals(rows: PayrollRow[]): PayrollTotals {
  return rows.reduce<PayrollTotals>(
    (totals, row) => ({
      minutes: totals.minutes + row.minutes,
      gross: totals.gross + row.gross,
      employees: totals.employees + (row.employeeId.startsWith('unassigned-') ? 0 : 1),
      shifts: totals.shifts + row.shiftCount
    }),
    { minutes: 0, gross: 0, employees: 0, shifts: 0 }
  );
}

export function pendingRequestCount(data: CorpData): number {
  const pending = (status: string | null) => (status ?? '').toLowerCase() === 'pending';
  return (
    data.timeOff.filter((row) => pending(row.status)).length +
    data.exceptions.filter((row) => pending(row.status)).length +
    data.overtime.filter((row) => pending(row.status)).length
  );
}

export function openTaskCount(data: CorpData): number {
  return data.tasks.filter((task) => {
    const status = (task.status ?? '').toLowerCase();
    return status !== 'done' && status !== 'cancelled';
  }).length;
}

export type SyncHealth = 'ok' | 'stale' | 'offline';

export function syncHealth(site: Site, now = Date.now()): SyncHealth {
  const last = parseDate(site.last_sync_at);
  if (!last) return 'offline';
  const minutes = (now - last.getTime()) / 60000;
  if (minutes <= 20) return 'ok';
  if (minutes <= 180) return 'stale';
  return 'offline';
}

export function unpaidTrainingCount(data: CorpData): number {
  return data.training.filter((row) => (row.status ?? '').toLowerCase() !== 'completed').length;
}
