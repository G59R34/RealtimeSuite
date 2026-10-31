import { formatDay, formatTime, statusLabel } from '../lib/format';
import type { Workspace } from '../types';
import { Card, Empty, Pill } from './ui';

interface Props {
  workspace: Workspace;
  email: string | null;
  onSignOut: () => void;
}

export function MeView({ workspace, email, onSignOut }: Props) {
  const { employee, site, settings, training, actions } = workspace;
  const name = employee.full_name ?? email ?? 'Employee';
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

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
