import type { Shift } from '../types';
import { addDays, minutesBetween, parseDate, shiftMinutes, startOfLocalDay } from './format';

/** Monday at local midnight — the week the schedule and payroll screens use. */
export function startOfWeek(value: Date): Date {
  const day = startOfLocalDay(value);
  // getDay() is Sunday-first; shift it so Monday is day 0.
  return addDays(day, -((day.getDay() + 6) % 7));
}

/** Minutes payroll counts for a shift: the site's own worked minutes when it sent
 *  them, otherwise the clock-in/clock-out span minus the unpaid break. */
export function workedMinutes(shift: Shift): number {
  if (typeof shift.worked_minutes === 'number' && shift.worked_minutes > 0) {
    return shift.worked_minutes;
  }
  const from = parseDate(shift.clocked_in_at);
  const to = parseDate(shift.clocked_out_at);
  if (!from || !to) return 0;
  return Math.max(0, minutesBetween(from, to) - Math.max(0, shift.break_minutes));
}

/** Paid minutes the shift was booked for. */
export function plannedMinutes(shift: Shift): number {
  return shiftMinutes(shift.start_at, shift.end_at, shift.break_minutes);
}

export interface HoursTotals {
  planned: number;
  worked: number;
  shifts: number;
}

/** Totals for shifts that start inside [from, to). */
export function totalsBetween(shifts: Shift[], from: Date, to: Date): HoursTotals {
  let planned = 0;
  let worked = 0;
  let count = 0;
  for (const shift of shifts) {
    const start = parseDate(shift.start_at);
    if (!start || start < from || start >= to) continue;
    planned += plannedMinutes(shift);
    worked += workedMinutes(shift);
    count += 1;
  }
  return { planned, worked, shifts: count };
}

const money = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
});

/** Base-rate estimate only: multipliers, overtime and deductions live in RealtimeSuite. */
export function estimatePay(minutes: number, rate: number | null | undefined): number | null {
  if (!rate || rate <= 0 || minutes <= 0) return null;
  return (minutes / 60) * rate;
}

export function formatMoney(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? money.format(value) : '—';
}
