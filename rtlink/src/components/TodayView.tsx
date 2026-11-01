import { useState } from 'react';
import { pendingActions } from '../lib/data';
import {
  addDays,
  formatDateInput,
  formatDay,
  formatDuration,
  formatRange,
  formatShortDay,
  minutesBetween,
  sameLocalDay,
  statusLabel
} from '../lib/format';
import { estimatePay, formatMoney, startOfWeek, totalsBetween } from '../lib/hours';
import { clockLocation } from '../lib/location';
import type { ActionKind, ViewMode, Workspace } from '../types';
import { Card, Empty, PendingNote, Pill } from './ui';

type Submit = (kind: ActionKind, payload: Record<string, unknown>) => Promise<void>;

interface Props {
  workspace: Workspace;
  onSubmit: Submit;
  /** Lets a banner row jump to the screen that can actually resolve it. */
  onNavigate?: (view: ViewMode) => void;
}

type Alert = {
  id: string;
  tone: 'warm' | 'live';
  title: string;
  detail: string;
  to?: ViewMode;
};

const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled', 'completed']);

export function TodayView({ workspace, onSubmit, onNavigate }: Props) {
  const { employee, shifts, tasks, training, exceptions, announcements, boardNotes, settings, actions } =
    workspace;
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
  // Everything the site has posted that is live right now, newest first, so the
  // Today screen is not reduced to a single message.
  const liveAnnouncements = announcements.filter((item) => {
    const starts = item.starts_at ? new Date(item.starts_at) : null;
    const ends = item.ends_at ? new Date(item.ends_at) : null;
    return (!starts || starts <= now) && (!ends || ends >= now);
  });
  const news = [
    ...liveAnnouncements.map((item) => ({
      id: `announcement-${item.id}`,
      kind: 'Announcement',
      body: item.message,
      when: item.starts_at ?? item.ends_at
    })),
    ...boardNotes.slice(0, 4).map((item) => ({
      id: `note-${item.id}`,
      kind: 'Board note',
      body: item.body,
      when: item.note_date
    }))
  ];
  const queued = pendingActions(actions);
  const todayMinutes = todayShifts.reduce(
    (total, shift) =>
      total +
      Math.max(0, minutesBetween(new Date(shift.start_at), new Date(shift.end_at)) - shift.break_minutes),
    0
  );
  const weekStart = startOfWeek(now);
  const weekDays = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const weekTotals = totalsBetween(mine, weekStart, addDays(weekStart, 7));
  // Bars are measured against an eight-hour day rather than the busiest day of
  // the week, so a four-hour shift looks half a day and the scale does not jump
  // every time a shift is added.
  const weekScale = Math.max(8 * 60, ...weekDays.map((day) => totalsBetween(mine, day, addDays(day, 1)).planned));
  const weekPay = estimatePay(weekTotals.worked, employee.hourly_rate);

  // Everything waiting on the employee, gathered above the clock card: a task is
  // only "seen" once acknowledged, so this is the one place a new assignment can
  // not be missed by never opening the Tasks tab.
  const openTaskList = tasks.filter(
    (task) => !task.acknowledged_at && !CLOSED_TASK_STATUSES.has(task.status)
  );
  const openTraining = training.filter((item) => !item.completed_at && item.status !== 'completed');
  const todayKey = formatDateInput(now);
  const leaveToday = exceptions.find(
    (request) =>
      request.status === 'approved' &&
      (request.exception_code === 'VAUT' || request.exception_code === 'DO') &&
      request.start_date <= todayKey &&
      request.end_date >= todayKey
  );
  const alerts: Alert[] = [];
  if (openTaskList.length) {
    const first = openTaskList[0];
    alerts.push({
      id: 'tasks',
      tone: 'warm',
      title: `${openTaskList.length} new task${openTaskList.length === 1 ? '' : 's'} to acknowledge`,
      detail: `${first.title}${
        openTaskList.length > 1 ? ` and ${openTaskList.length - 1} more` : ''
      } · ${formatShortDay(first.start_at)}`,
      to: 'tasks'
    });
  }
  if (leaveToday) {
    alerts.push({
      id: 'leave',
      tone: 'live',
      title: 'Approved leave today',
      detail: `${statusLabel(leaveToday.exception_code)} · ${formatShortDay(
        leaveToday.start_date
      )} – ${formatShortDay(leaveToday.end_date)}`
    });
  }
  if (openTraining.length) {
    const first = openTraining[0];
    alerts.push({
      id: 'training',
      tone: 'warm',
      title: `${openTraining.length} training${openTraining.length === 1 ? '' : 's'} to finish`,
      detail: `${first.course_title ?? 'Course'}${
        first.due_at ? ` · due ${formatShortDay(first.due_at)}` : ''
      }`,
      to: 'me'
    });
  }

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
      {alerts.length > 0 && (
        <section className="alerts" aria-label="Needs your attention">
          <div className="alerts-head">
            <span className="alerts-eyebrow">Needs you</span>
            <span className="alerts-count">{alerts.length}</span>
          </div>
          <div className="alerts-list">
            {alerts.map((alert) => {
              const row = (
                <>
                  <span className={`alert-dot alert-dot-${alert.tone}`} aria-hidden="true" />
                  <span className="alert-text">
                    <strong>{alert.title}</strong>
                    <span>{alert.detail}</span>
                  </span>
                  {alert.to && (
                    <span className="alert-go" aria-hidden="true">
                      Open
                    </span>
                  )}
                </>
              );
              return alert.to ? (
                <button
                  className="alert-row"
                  key={alert.id}
                  type="button"
                  onClick={() => onNavigate?.(alert.to as ViewMode)}
                >
                  {row}
                </button>
              ) : (
                <div className="alert-row" key={alert.id}>
                  {row}
                </div>
              );
            })}
          </div>
        </section>
      )}

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

      <Card
        title="This week"
        hint={`${formatShortDay(weekStart)} – ${formatShortDay(addDays(weekStart, 6))}`}
      >
        <div className="week-bars" aria-hidden="true">
          {weekDays.map((day) => {
            const planned = totalsBetween(mine, day, addDays(day, 1)).planned;
            const height = planned ? Math.max(6, Math.min(100, Math.round((planned / weekScale) * 100))) : 0;
            return (
              <div
                className={`week-bar${sameLocalDay(day, now) ? ' is-today' : ''}`}
                key={day.toISOString()}
                title={`${day.toLocaleDateString(undefined, { weekday: 'long' })} · ${
                  planned ? formatDuration(planned) : 'no shifts'
                }`}
              >
                <div className="week-bar-track">
                  <span style={{ height: `${height}%` }} />
                </div>
                <small>{day.toLocaleDateString(undefined, { weekday: 'narrow' })}</small>
              </div>
            );
          })}
        </div>
        <div className="stat-grid">
          <div className="stat">
            <span>Scheduled</span>
            <strong>{formatDuration(weekTotals.planned)}</strong>
          </div>
          <div className="stat">
            <span>Worked</span>
            <strong>{formatDuration(weekTotals.worked)}</strong>
          </div>
          <div className="stat">
            <span>Shifts</span>
            <strong>{weekTotals.shifts}</strong>
          </div>
        </div>
        <p className="card-footnote">
          {weekPay !== null
            ? `About ${formatMoney(weekPay)} at your base rate. Payroll at your site is final.`
            : 'Hours come from your scheduled shifts; worked time appears after you clock out.'}
        </p>
      </Card>

      {news.length > 0 && (
        <Card title="News" hint={`${news.length} from your site`}>
          <div className="list">
            {news.map((item) => (
              <div className="news-row" key={item.id}>
                <div className="news-kind">{item.kind}</div>
                <div className="news-body">
                  <p>{item.body}</p>
                  {item.when && <span className="muted small">{formatDay(item.when)}</span>}
                </div>
              </div>
            ))}
          </div>
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
