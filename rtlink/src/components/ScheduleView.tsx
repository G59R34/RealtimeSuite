import { useMemo, useState } from 'react';
import {
  addDays,
  dayKey,
  formatDateInput,
  formatDay,
  formatDuration,
  formatRange,
  formatShortDay,
  sameLocalDay,
  shiftMinutes
} from '../lib/format';
import type { ActionKind, Shift, Workspace } from '../types';
import { Card, Empty, Field, Pill } from './ui';

type Submit = (kind: ActionKind, payload: Record<string, unknown>) => Promise<void>;

interface Props {
  workspace: Workspace;
  onSubmit: Submit;
}

export function ScheduleView({ workspace, onSubmit }: Props) {
  const { employee, shifts, directory, workAreas } = workspace;
  const [swapFor, setSwapFor] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [swapNote, setSwapNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const now = new Date();
  const mine = shifts.filter((shift) => shift.employee_id === employee.id);
  const upcoming = mine
    .filter((shift) => new Date(shift.end_at) >= now && shift.status !== 'off_shift')
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
  const pool = shifts
    .filter((shift) => shift.is_shift_pool && !shift.employee_id && new Date(shift.end_at) >= now)
    .sort((a, b) => a.start_at.localeCompare(b.start_at));

  const days = useMemo(() => {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }, [now]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, Shift[]>();
    for (const shift of upcoming) {
      const key = dayKey(new Date(shift.start_at));
      buckets.set(key, [...(buckets.get(key) ?? []), shift]);
    }
    return Array.from(buckets.entries());
  }, [upcoming]);

  const colorFor = (shift: Shift) =>
    workAreas.find((area) => area.id === shift.work_area_id)?.color ?? '#4c7bd9';

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
      <Card title="This week" hint="Tap a day count to see the details below">
        <div className="week-strip">
          {days.map((day) => {
            const count = mine.filter((shift) => sameLocalDay(new Date(shift.start_at), day)).length;
            return (
              <div className={`week-day${count ? ' has-shift' : ''}`} key={dayKey(day)}>
                <span>{day.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                <strong>{day.getDate()}</strong>
                <i aria-hidden="true" />
                <small>{count || '—'}</small>
              </div>
            );
          })}
        </div>
      </Card>

      {error && <p className="form-error">{error}</p>}

      <Card title="Upcoming shifts" hint={`${upcoming.length} scheduled`}>
        {grouped.length ? (
          <div className="day-groups">
            {grouped.map(([key, list]) => (
              <div className="day-group" key={key}>
                <div className="day-label">
                  <strong>{sameLocalDay(new Date(list[0].start_at), now) ? 'Today' : formatShortDay(list[0].start_at)}</strong>
                  <span>{formatDay(list[0].start_at)}</span>
                </div>
                {list.map((shift) => (
                  <div className="shift-card" key={shift.id} style={{ borderLeftColor: colorFor(shift) }}>
                    <div className="shift-card-main">
                      <strong>{formatRange(shift.start_at, shift.end_at)}</strong>
                      <span>{shift.work_area_name ?? 'Shift'}</span>
                      <span className="muted small">
                        {formatDuration(shiftMinutes(shift.start_at, shift.end_at, shift.break_minutes))} paid
                        {shift.break_minutes ? ` · ${shift.break_minutes}m break` : ''}
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
                ))}
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No upcoming shifts" body="When your manager publishes the schedule it lands here." />
        )}
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
        {formatDateInput(now)}.
      </p>
    </div>
  );
}
