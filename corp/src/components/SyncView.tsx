import type { CorpData } from '../types';
import { formatDateTime, humanize, relativeTime } from '../lib/format';
import { syncHealth } from '../lib/metrics';
import { Badge, Card, Empty, Stat, TableShell } from './ui';

const COLLECTION_LABELS: Record<string, string> = {
  employees: 'People',
  work_areas: 'Work areas',
  shifts: 'Shifts',
  tasks: 'Tasks',
  time_off_requests: 'Time off',
  exception_requests: 'Exceptions',
  overtime_requests: 'Overtime',
  discipline_actions: 'Discipline',
  training_assignments: 'Training',
  board_notes: 'Board notes',
  announcements: 'Announcements'
};

export function SyncView({
  data,
  canManage,
  onCancel
}: {
  data: CorpData;
  canManage: boolean;
  onCancel: (commandId: string) => Promise<void>;
}) {
  const healthy = data.sites.filter((site) => syncHealth(site) === 'ok').length;
  const failing = data.syncEvents.filter((event) => event.status !== 'ok').length;
  const lastEvent = data.syncEvents[0];
  const latestCounts = data.sites[0]?.record_counts ?? {};

  return (
    <div className="view-stack">
      <div className="stat-grid compact">
        <Stat
          label="Sites healthy"
          value={`${healthy}/${data.sites.length}`}
          tone={data.sites.length > 0 && healthy === data.sites.length ? 'good' : 'warn'}
        />
        <Stat label="Last snapshot" value={relativeTime(lastEvent?.received_at)} />
        <Stat
          label="Failed deliveries"
          value={String(failing)}
          tone={failing > 0 ? 'bad' : undefined}
        />
        <Stat
          label="Rows mirrored"
          value={String(
            Object.values(latestCounts).reduce((sum, value) => sum + Number(value ?? 0), 0)
          )}
        />
      </div>

      <div className="grid-2">
        <Card title="Site freshness" subtitle="A site is healthy when it delivered within 20 minutes">
          {data.sites.length === 0 ? (
            <Empty>No sites have connected.</Empty>
          ) : (
            <ul className="plain-list">
              {data.sites.map((site) => {
                const health = syncHealth(site);
                return (
                  <li key={site.id}>
                    <div>
                      <strong>{site.name}</strong>
                      <p className="muted small">{formatDateTime(site.last_sync_at)}</p>
                    </div>
                    <span className={`badge badge-${health === 'ok' ? 'good' : health === 'stale' ? 'warn' : 'bad'}`}>
                      {humanize(health === 'ok' ? 'healthy' : health)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Current snapshot" subtitle="Row counts in the most recent delivery">
          <ul className="count-list">
            {Object.keys(COLLECTION_LABELS).map((key) => (
              <li key={key}>
                <span>{COLLECTION_LABELS[key]}</span>
                <strong>{Number(latestCounts[key] ?? 0)}</strong>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card
        title="Corporate changes"
        subtitle="Queued from this console; each site applies them and reports back"
      >
        {data.commands.length === 0 ? (
          <Empty>No corporate changes queued yet.</Empty>
        ) : (
          <TableShell>
            <thead>
              <tr>
                <th>Requested</th>
                <th>Site</th>
                <th>Change</th>
                <th>Status</th>
                <th>Detail</th>
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {data.commands.slice(0, 40).map((command) => (
                <tr key={command.id}>
                  <td className="small">{formatDateTime(command.requested_at)}</td>
                  <td className="muted">
                    {data.sites.find((site) => site.id === command.site_id)?.name ?? '—'}
                  </td>
                  <td>{humanize(command.kind)}</td>
                  <td>
                    <Badge value={command.status} />
                    {command.attempts > 1 && (
                      <span className="muted small"> {command.attempts} attempts</span>
                    )}
                  </td>
                  <td className="muted small">
                    {command.error ?? command.note ?? formatDateTime(command.applied_at)}
                  </td>
                  {canManage && (
                    <td className="row-actions">
                      {command.status === 'pending' ? (
                        <button
                          className="button ghost small"
                          type="button"
                          onClick={() => void onCancel(command.id)}
                        >
                          Cancel
                        </button>
                      ) : null}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Card title="Delivery history" subtitle="Newest first, one row per snapshot">
        {data.syncEvents.length === 0 ? (
          <Empty>No snapshots received yet.</Empty>
        ) : (
          <TableShell>
            <thead>
              <tr>
                <th>Received</th>
                <th>Site</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Records</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {data.syncEvents.slice(0, 40).map((event) => {
                const counts = event.record_counts ?? {};
                const total = Object.values(counts).reduce(
                  (sum, value) => sum + Number(value ?? 0),
                  0
                );
                return (
                  <tr key={event.id}>
                    <td>{formatDateTime(event.received_at)}</td>
                    <td className="muted">
                      {data.sites.find((site) => site.id === event.site_id)?.name ?? '—'}
                    </td>
                    <td>{humanize(event.kind)}</td>
                    <td>
                      <Badge value={event.status} />
                    </td>
                    <td>{total}</td>
                    <td className="muted small">{event.message ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}
