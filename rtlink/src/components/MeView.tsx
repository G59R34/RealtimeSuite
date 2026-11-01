import {
  addDays,
  formatDay,
  formatDuration,
  formatRange,
  formatShortDay,
  formatTime,
  statusLabel
} from '../lib/format';
import {
  estimatePay,
  formatMoney,
  startOfWeek,
  totalsBetween,
  workedMinutes,
  type HoursTotals
} from '../lib/hours';
import type { Workspace } from '../types';
import { Card, Empty, Pill } from './ui';

interface Props {
  workspace: Workspace;
  email: string | null;
  orgCode: string;
  onChangeOrg: () => void;
  onSignOut: () => void;
}

export function MeView({ workspace, email, orgCode, onChangeOrg, onSignOut }: Props) {
  const { employee, site, settings, shifts, training, actions } = workspace;
  const name = employee.full_name ?? email ?? 'Employee';
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  const now = new Date();
  const mine = shifts.filter((shift) => shift.employee_id === employee.id);
  const weekStart = startOfWeek(now);
  const weekTotals = totalsBetween(mine, weekStart, addDays(weekStart, 7));
  const lastWeekTotals = totalsBetween(mine, addDays(weekStart, -7), weekStart);
  const monthTotals = totalsBetween(
    mine,
    new Date(now.getFullYear(), now.getMonth(), 1),
    new Date(now.getFullYear(), now.getMonth() + 1, 1)
  );
  const rate = employee.hourly_rate;
  // A week with no clock-outs has no pay figure, so say what it does have.
  const payLine = (totals: HoursTotals) => {
    const pay = estimatePay(totals.worked, rate);
    if (pay !== null) return formatMoney(pay);
    if (!totals.shifts) return 'no shifts';
    return `${totals.shifts} shift${totals.shifts === 1 ? '' : 's'} booked`;
  };
  // Schedule hides shifts once they end, so this is the only place a finished
  // shift still shows its hours.
  const recent = mine
    .filter((shift) => new Date(shift.end_at) < now)
    .sort((a, b) => b.start_at.localeCompare(a.start_at))
    .slice(0, 6);

  return (
    <div className="stack">
      <Card>
        <div className="profile-head">
          <span className="avatar" aria-hidden="true">{initials || 'RT'}</span>
          <div>
            <h2>{name}</h2>
            <p className="muted small">{email ?? employee.email ?? 'No email on file'}</p>
          </div>
        </div>
        <dl className="detail-list">
          <div>
            <dt>Site</dt>
            <dd>{site.name}</dd>
          </div>
          <div>
            <dt>Organization</dt>
            <dd>{settings?.organization_name ?? site.organization_name ?? '—'}</dd>
          </div>
          <div>
            <dt>Organization code</dt>
            <dd>{orgCode}</dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>{site.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}</dd>
          </div>
          <div>
            <dt>Clock-in location</dt>
            <dd>{settings?.clock_in_required ? 'Verified on site' : 'Not enforced'}</dd>
          </div>
          <div>
            <dt>Last sync</dt>
            <dd>{site.last_sync_at ? formatTime(site.last_sync_at) : 'Waiting for first sync'}</dd>
          </div>
          <div>
            <dt>App version</dt>
            <dd>{site.app_version ?? '1.0.0'}</dd>
          </div>
        </dl>
      </Card>

      <Card
        title="Work & pay"
        hint={
          rate
            ? `Base rate ${formatMoney(rate)}/h · estimate only`
            : 'Hours from your schedule and clock-ins'
        }
      >
        <div className="stat-grid">
          <div className="stat">
            <span>This week</span>
            <strong>{formatDuration(weekTotals.worked)}</strong>
            <small>
              {weekTotals.planned ? `of ${formatDuration(weekTotals.planned)} booked` : 'nothing booked'}
            </small>
          </div>
          <div className="stat">
            <span>Last week</span>
            <strong>{formatDuration(lastWeekTotals.worked)}</strong>
            <small>{payLine(lastWeekTotals)}</small>
          </div>
          <div className="stat">
            <span>This month</span>
            <strong>{formatDuration(monthTotals.worked)}</strong>
            <small>{payLine(monthTotals)}</small>
          </div>
        </div>
        <p className="card-footnote">
          {rate
            ? 'Pay is estimated from your base rate. Overtime, multipliers and deductions are applied in RealtimeSuite, so final pay comes from your site.'
            : 'Your site has not set an hourly rate for you yet, so these are hours only.'}
        </p>

        <h3 className="subhead">Recent shifts</h3>
        {recent.length ? (
          <div className="list">
            {recent.map((shift) => (
              <div className="shift-row" key={shift.id}>
                <div className="shift-time">
                  <strong>{formatShortDay(shift.start_at)}</strong>
                  <span>{formatRange(shift.start_at, shift.end_at)}</span>
                </div>
                <div className="shift-body">
                  <span className="shift-area">{shift.work_area_name ?? 'Shift'}</span>
                  <span className="muted small">
                    {shift.clocked_in_at
                      ? `${formatDuration(workedMinutes(shift))} worked`
                      : 'No clock-in recorded'}
                  </span>
                </div>
                <Pill status={shift.status} />
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No completed shifts yet" body="A shift moves here once it ends." />
        )}
      </Card>

      <Card title="Training" hint={training.length ? `${training.length} assigned` : 'Nothing assigned'}>
        {training.length ? (
          <div className="list">
            {training.map((item) => (
              <div className="training-row" key={item.id}>
                <div>
                  <strong>{item.course_title ?? 'Course'}</strong>
                  <span className="muted small">
                    {item.due_at ? `Due ${formatDay(item.due_at)}` : 'No due date'}
                    {item.completed_at ? ` · completed ${formatDay(item.completed_at)}` : ''}
                  </span>
                </div>
                <Pill status={item.status} />
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No training assigned" body="Courses appear here when your manager assigns them." />
        )}
        <p className="fine-print">
          Complete training in RealtimeSuite; RTLink updates your progress on the next sync.
        </p>
      </Card>

      <Card title="Sent to your site" hint="The last few actions from this phone">
        {actions.length ? (
          <div className="list">
            {actions.slice(0, 6).map((action) => (
              <div className="history-row" key={action.id}>
                <div className="history-type">{statusLabel(action.kind.split('.')[0])}</div>
                <div className="history-body">
                  <strong>{statusLabel(action.kind.split('.')[1] ?? '')}</strong>
                  <span className="muted small">
                    {formatTime(action.requested_at)}
                    {action.result ? ` · ${action.result}` : ''}
                    {action.error ? ` · ${action.error}` : ''}
                  </span>
                </div>
                <Pill status={action.status} />
              </div>
            ))}
          </div>
        ) : (
          <Empty title="Nothing sent yet" />
        )}
      </Card>

      <div className="sign-out">
        <button className="btn ghost" type="button" onClick={onChangeOrg}>
          Change organization code
        </button>
        <button className="btn ghost" type="button" onClick={onSignOut}>
          Sign out
        </button>
        <p className="fine-print">
          RTLink reads your schedule from {settings?.organization_name ?? site.organization_name ?? 'your site'}.
          Your manager's RealtimeSuite installation remains the source of truth.
        </p>
      </div>
    </div>
  );
}
