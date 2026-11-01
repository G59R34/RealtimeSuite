import { useMemo, useState, type CSSProperties } from 'react';
import {
  addDays,
  dayKey,
  formatDay,
  formatDuration,
  formatRange,
  formatShortDay,
  sameLocalDay,
  shiftMinutes
} from '../lib/format';
import { startOfWeek } from '../lib/hours';
import type { ActionKind, Shift, Workspace } from '../types';
import { Card, Empty, Field, Pill } from './ui';

type Submit = (kind: ActionKind, payload: Record<string, unknown>) => Promise<void>;

interface Props {
  workspace: Workspace;
  onSubmit: Submit;
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** "9a", "5:33p" — small enough to sit under a date in a 44px cell. */
function compactTime(value: string): string {
  const parsed = new Date(value);
  const hours = parsed.getHours();
  const minutes = parsed.getMinutes();
  const suffix = hours < 12 ? 'a' : 'p';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return minutes ? `${hour12}:${`${minutes}`.padStart(2, '0')}${suffix}` : `${hour12}${suffix}`;
}

function monthStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

export function ScheduleView({ workspace, onSubmit }: Props) {
  const { employee, shifts, directory, workAreas } = workspace;
  const now = new Date();
  const [month, setMonth] = useState<Date>(() => monthStart(now));
  const [selected, setSelected] = useState<string>(() => dayKey(now));
  const [swapFor, setSwapFor] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [swapNote, setSwapNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mine = useMemo(
    () => shifts.filter((shift) => shift.employee_id === employee.id),
    [shifts, employee.id]
  );

  // Bucket by the day a shift starts, which is where employees look for it.
  const byDay = useMemo(() => {
    const buckets = new Map<string, Shift[]>();
    for (const shift of mine) {
      const key = dayKey(new Date(shift.start_at));
      buckets.set(key, [...(buckets.get(key) ?? []), shift]);
    }
    for (const list of buckets.values()) {
      list.sort((a, b) => a.start_at.localeCompare(b.start_at));
    }
    return buckets;
  }, [mine]);

  const pool = shifts
    .filter((shift) => shift.is_shift_pool && !shift.employee_id && new Date(shift.end_at) >= now)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));

  const monthShifts = mine.filter((shift) => {
    const start = new Date(shift.start_at);
    return start.getFullYear() === month.getFullYear() && start.getMonth() === month.getMonth();
  });
  const monthMinutes = monthShifts.reduce(
    (total, shift) => total + shiftMinutes(shift.start_at, shift.end_at, shift.break_minutes),
    0
  );

  // Six weeks from the Monday on or before the 1st: a stable grid that never
  // reflows as the month changes.
  const cells = Array.from({ length: 42 }, (_, index) => addDays(startOfWeek(month), index));

  const selectedDate = new Date(`${selected}T00:00:00`);
  const selectedShifts = byDay.get(selected) ?? [];
  const selectedMinutes = selectedShifts.reduce(
    (total, shift) => total + shiftMinutes(shift.start_at, shift.end_at, shift.break_minutes),
    0
  );
  const viewingThisMonth =
    month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth();

  const colorFor = (shift: Shift) =>
    workAreas.find((area) => area.id === shift.work_area_id)?.color ?? '#4c7bd9';

  function shiftMonth(delta: number) {
    const next = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    setMonth(next);
    setSwapFor(null);
    const today = new Date();
    const sameMonth =
      next.getFullYear() === today.getFullYear() && next.getMonth() === today.getMonth();
    setSelected(dayKey(sameMonth ? today : next));
  }

  function goToday() {
    setMonth(monthStart(now));
    setSelected(dayKey(now));
    setSwapFor(null);
  }

  async function submit(kind: ActionKind, payload: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      await onSubmit(kind, payload);
      setSwapFor(null);
      setTarget('');
      setSwapNote('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not go through. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <Card
        title={month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        hint={
          monthShifts.length
            ? `${monthShifts.length} shift${monthShifts.length === 1 ? '' : 's'} · ${formatDuration(monthMinutes)}`
            : 'Nothing scheduled this month'
        }
        action={
          <div className="calendar-nav">
            {!viewingThisMonth && (
              <button className="calendar-today" type="button" onClick={goToday}>
                Today
              </button>
            )}
            <button type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month">
              ‹
            </button>
            <button type="button" onClick={() => shiftMonth(1)} aria-label="Next month">
              ›
            </button>
          </div>
        }
      >
        <div className="calendar-head" aria-hidden="true">
          {WEEKDAYS.map((day, index) => (
            <span key={`${day}-${index}`}>{day}</span>
          ))}
        </div>
        <div className="calendar-grid" role="group" aria-label="Days of the month">
          {cells.map((day) => {
            const key = dayKey(day);
            const list = byDay.get(key) ?? [];
            const outside = day.getMonth() !== month.getMonth();
            const classes = [
              'calendar-cell',
              outside ? 'is-outside' : '',
              sameLocalDay(day, now) ? 'is-today' : '',
              key === selected ? 'is-selected' : '',
              // Neighbouring months keep a dot but not the scheduled tint, so a
              // shift that belongs to another month does not look like this one's.
              list.length && !outside ? 'has-shift' : ''
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                className={classes}
                key={key}
                type="button"
                aria-pressed={key === selected}
                aria-label={`${formatDay(day)}${
                  list.length
                    ? `, ${list.length} shift${list.length === 1 ? '' : 's'} from ${formatRange(
                        list[0].start_at,
                        list[0].end_at
                      )}`
                    : ', no shifts'
                }`}
                onClick={() => {
                  setSelected(key);
                  setSwapFor(null);
                  if (outside) setMonth(monthStart(day));
                }}
              >
                <span>{day.getDate()}</span>
                {list.length > 0 && (
                  <span
                    className="calendar-preview"
                    style={outside ? undefined : ({ '--area': colorFor(list[0]) } as CSSProperties)}
                  >
                    {compactTime(list[0].start_at)}
                    {list.length > 1 ? ` +${list.length - 1}` : ''}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="calendar-day">
          <div className="day-label">
            <strong>{sameLocalDay(selectedDate, now) ? 'Today' : formatDay(selectedDate)}</strong>
            {selectedShifts.length > 0 && (
              <span className="count-chip">{formatDuration(selectedMinutes)}</span>
            )}
          </div>

          {selectedShifts.length ? (
            selectedShifts.map((shift) => (
              <div className="shift-card" key={shift.id} style={{ borderLeftColor: colorFor(shift) }}>
                <div className="shift-card-main">
                  <strong>{formatRange(shift.start_at, shift.end_at)}</strong>
                  <span>{shift.work_area_name ?? 'Shift'}</span>
                  <span className="muted small">
                    {formatDuration(shiftMinutes(shift.start_at, shift.end_at, shift.break_minutes))} paid
                    {shift.break_minutes ? ` · ${shift.break_minutes}m break` : ''}
                    {shift.notes ? ` · ${shift.notes}` : ''}
                  </span>
                </div>
                <div className="shift-card-side">
                  <Pill status={shift.status} />
                  {shift.status === 'scheduled' && new Date(shift.start_at) > now && (
                    <button
                      className="btn ghost small"
                      type="button"
                      onClick={() => setSwapFor(swapFor === shift.id ? null : shift.id)}
                    >
                      {swapFor === shift.id ? 'Cancel' : 'Swap'}
                    </button>
                  )}
                </div>
                {swapFor === shift.id && (
                  <div className="swap-composer">
                    <Field label="Swap with" hint="Optional — leave blank to post to the whole team">
                      <select value={target} onChange={(event) => setTarget(event.target.value)}>
                        <option value="">Anyone available</option>
                        {directory
                          .filter((person) => person.id !== employee.id)
                          .map((person) => (
                            <option key={person.id} value={person.id}>
                              {person.full_name ?? 'Teammate'}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <Field label="Note">
                      <input
                        value={swapNote}
                        onChange={(event) => setSwapNote(event.target.value)}
                        placeholder="Why you need the swap"
                      />
                    </Field>
                    <button
                      className="btn primary"
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void submit(
                          'swap.create',
                          {
                            shift_id: shift.id,
                            requested_employee_id: target || null,
                            request_note: swapNote
                          },
                          `swap-${shift.id}`
                        )
                      }
                    >
                      {busy === `swap-${shift.id}` ? 'Posting…' : 'Post swap request'}
                    </button>
                  </div>
                )}
              </div>
            ))
          ) : (
            <Empty
              title="Nothing scheduled"
              body="Tap another day, or claim an open shift from the list below."
            />
          )}
        </div>
      </Card>

      <Card
        title="Open shifts"
        hint="First come, first served — your site checks overlap and weekly hours"
        action={pool.length ? <span className="count-chip">{pool.length}</span> : undefined}
      >
        {pool.length ? (
          <div className="list">
            {pool.map((shift) => (
              <div className="shift-row" key={shift.id}>
                <div className="shift-time">
                  <strong>{formatShortDay(shift.start_at)}</strong>
                  <span>{formatRange(shift.start_at, shift.end_at)}</span>
                </div>
                <div className="shift-body">
                  <span className="shift-area">{shift.work_area_name ?? 'Open shift'}</span>
                  <span className="muted small">
                    {formatDuration(shiftMinutes(shift.start_at, shift.end_at, shift.break_minutes))} ·{' '}
                    {shift.break_minutes}m break
                  </span>
                </div>
                <button
                  className="btn primary small"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void submit('shift.claim', { shift_id: shift.id }, `claim-${shift.id}`)}
                >
                  {busy === `claim-${shift.id}` ? 'Claiming…' : 'Claim'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No open shifts right now" body="Check back after the next schedule update." />
        )}
      </Card>

      <p className="fine-print">
        Dates use this device's time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Today is{' '}
        {dayKey(now)}.
      </p>
    </div>
  );
}
