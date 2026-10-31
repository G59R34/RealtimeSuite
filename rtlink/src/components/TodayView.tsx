import { useState } from 'react';
import { pendingActions } from '../lib/data';
import {
  dayKey,
  formatDay,
  formatDuration,
  formatRange,
  minutesBetween,
  sameLocalDay,
  startOfLocalDay
} from '../lib/format';
import { clockLocation } from '../lib/location';
import type { ActionKind, Workspace } from '../types';
import { Card, Empty, PendingNote, Pill } from './ui';

type Submit = (kind: ActionKind, payload: Record<string, unknown>) => Promise<void>;

interface Props {
  workspace: Workspace;
  onSubmit: Submit;
}

export function TodayView({ workspace, onSubmit }: Props) {
  const { employee, shifts, tasks, announcements, boardNotes, settings, actions } = workspace;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const now = new Date();
  const mine = shifts.filter((shift) => shift.employee_id === employee.id);
  const active = mine.find(
    (shift) => shift.clocked_in_at && !shift.clocked_out_at && shift.status !== 'off_shift'
  );
  const todayShifts = mine.filter((shift) => sameLocalDay(new Date(shift.start_at), now));
  const upcoming = mine
    .filter(
      (shift) =>
        new Date(shift.end_at) > now && shift.status !== 'off_shift' && !shift.clocked_out_at
    )
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
  const nextShift = upcoming.find((shift) => shift.id !== active?.id) ?? null;
  const todayTasks = tasks.filter(
    (task) => sameLocalDay(new Date(task.start_at), now) && task.status !== 'cancelled'
  );
  const openTasks = todayTasks.filter(
    (task) => !task.acknowledged_at && task.status !== 'done' && task.status !== 'cancelled'
  );
  const announcement =
    announcements.find((item) => {
      const starts = item.starts_at ? new Date(item.starts_at) : null;
      const ends = item.ends_at ? new Date(item.ends_at) : null;
      return (!starts || starts <= now) && (!ends || ends >= now);
    }) ?? announcements[0];
  const note =
    boardNotes.find((item) => item.note_date === dayKey(startOfLocalDay(now))) ?? boardNotes[0];
  const queued = pendingActions(actions);
  const todayMinutes = todayShifts.reduce(
    (total, shift) =>
      total +
      Math.max(0, minutesBetween(new Date(shift.start_at), new Date(shift.end_at)) - shift.break_minutes),
    0
  );

  async function run(kind: ActionKind, payload: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      await onSubmit(kind, payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not go through. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function clockIn(shiftId: string) {
    const location = settings?.clock_in_required ? await clockLocation() : undefined;
    if (settings?.clock_in_required && !location) {
      setError(
        'Location is required to clock in here. Allow location access for this site in your browser, then try again.'
      );
      return;
    }
    await run('shift.clock_in', { shift_id: shiftId, ...location }, 'clock-in');
  }

  async function clockInUnscheduled() {
    const location = settings?.clock_in_required ? await clockLocation() : undefined;
    if (settings?.clock_in_required && !location) {
      setError(
        'Location is required to clock in here. Allow location access for this site in your browser, then try again.'
      );
      return;
    }
    await run(
      'shift.clock_in_unscheduled',
      { note: 'Clocked in from RTLink', ...location },
      'clock-in-anyway'
    );
  }

  const onDutyMinutes = active?.clocked_in_at
    ? minutesBetween(new Date(active.clocked_in_at), now)
    : 0;

  return (
    <div className="stack">
      <section className={`clock-card${active ? ' is-live' : ''}`}>
        <div className="clock-top">
          <span className="clock-eyebrow">{active ? 'On the clock' : 'Right now'}</span>
          <span className="clock-date">{formatDay(now)}</span>
        </div>

        {active ? (
          <>
            <div className="clock-main">
              <strong>{formatDuration(onDutyMinutes)}</strong>
              <span>
                since {formatRange(active.clocked_in_at, active.end_at).split(' – ')[0]}
                {active.work_area_name ? ` · ${active.work_area_name}` : ''}
              </span>
            </div>
            <button
              className="btn on-dark"
              type="button"
              disabled={busy !== null}
              onClick={() => void run('shift.clock_out', { shift_id: active.id }, 'clock-out')}
            >
              {busy === 'clock-out' ? 'Sending clock-out…' : 'Clock out'}
            </button>
          </>
        ) : nextShift ? (
          <>
            <div className="clock-main">
              <strong>{formatRange(nextShift.start_at, nextShift.end_at)}</strong>
              <span>
                {nextShift.work_area_name ?? 'Your shift'} ·{' '}
                {sameLocalDay(new Date(nextShift.start_at), now)
                  ? 'today'
                  : formatDay(nextShift.start_at)}
              </span>
            </div>
            <div className="clock-actions">
              {sameLocalDay(new Date(nextShift.start_at), now) ? (
                <button
                  className="btn on-dark"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void clockIn(nextShift.id)}
                >
                  {busy === 'clock-in' ? 'Sending clock-in…' : 'Clock in'}
                </button>
              ) : (
                <span className="clock-footnote">You can clock in on the day of this shift.</span>
              )}
              <span className="clock-footnote">
                {settings?.clock_in_required ? 'Location is checked at clock-in.' : 'Clock-in opens on the shift day.'}
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="clock-main">
              <strong>No shift scheduled</strong>
              <span>{formatDay(now)} · enjoy the day off</span>
            </div>
            <button
              className="btn on-dark ghost-on-dark"
              type="button"
              disabled={busy !== null}
              onClick={() => void clockInUnscheduled()}
            >
              {busy === 'clock-in-anyway' ? 'Sending…' : 'Clock in anyway'}
            </button>
          </>
        )}
      </section>

      {error && <p className="form-error">{error}</p>}
      <PendingNote count={queued.length} />

      <Card
        title="Today's schedule"
        hint={todayShifts.length ? `${formatDuration(todayMinutes)} planned` : 'Nothing booked for today'}
      >
        {todayShifts.length ? (
          <div className="list">
            {todayShifts.map((shift) => (
              <div className="shift-row" key={shift.id}>
                <div className="shift-time">
                  <strong>{formatRange(shift.start_at, shift.end_at)}</strong>
                  <span>{formatDuration(minutesBetween(new Date(shift.start_at), new Date(shift.end_at)) - shift.break_minutes)} paid</span>
                </div>
                <div className="shift-body">
                  <span className="shift-area">{shift.work_area_name ?? 'Shift'}</span>
                  <span className="muted small">
                    {shift.break_minutes ? `${shift.break_minutes}m break` : 'No break'}
                    {shift.notes ? ` · ${shift.notes}` : ''}
                  </span>
                </div>
                <Pill status={shift.status} />
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No shift today" body="Open shifts you can claim are on the Schedule tab." />
        )}
      </Card>

      <Card
        title="Tasks for today"
        hint={openTasks.length ? `${openTasks.length} still open` : 'All caught up'}
      >
        {todayTasks.length ? (
          <div className="list">
            {todayTasks.slice(0, 4).map((task) => (
              <div className="task-row" key={task.id}>
                <div>
                  <strong>{task.title}</strong>
                  <span className="muted small">
                    {formatRange(task.start_at, task.end_at)}
                    {task.work_area_name ? ` · ${task.work_area_name}` : ''}
                  </span>
                </div>
                {task.acknowledged_at ? (
                  <Pill status="done" label="Acknowledged" />
                ) : (
                  <button
                    className="btn small"
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void run('task.acknowledge', { assignment_id: task.assignment_id }, `ack-${task.id}`)
                    }
                  >
                    {busy === `ack-${task.id}` ? 'Sending…' : 'Acknowledge'}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No tasks today" body="New tasks appear here as soon as they are assigned." />
        )}
      </Card>

      {announcement && (
        <Card title="Announcement" hint="From your site">
          <p className="announcement">{announcement.message}</p>
        </Card>
      )}

      {note && (
        <Card title="Board note" hint={note.note_date}>
          <p className="announcement">{note.body}</p>
        </Card>
      )}

      {nextShift && (
        <Card title="Next up" hint="After today">
          <div className="shift-row">
            <div className="shift-time">
              <strong>{formatDay(nextShift.start_at)}</strong>
              <span>{formatRange(nextShift.start_at, nextShift.end_at)}</span>
            </div>
            <div className="shift-body">
              <span className="shift-area">{nextShift.work_area_name ?? 'Shift'}</span>
              <span className="muted small">{nextShift.work_area_name ? 'Scheduled' : 'Details in RealtimeSuite'}</span>
            </div>
            <Pill status={nextShift.status} />
          </div>
        </Card>
      )}
    </div>
  );
}
