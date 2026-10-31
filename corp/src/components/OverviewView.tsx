import type { CorpData, Scope } from '../types';
import {
  formatDate,
  formatHours,
  formatMoney,
  formatNumber,
  formatRange,
  humanize,
  relativeTime,
  toDateInput
} from '../lib/format';
import {
  isShiftActive,
  monthShifts,
  openTaskCount,
  payrollRows,
  payrollTotals,
  pendingRequestCount,
  shiftMinutes,
  syncHealth,
  unpaidTrainingCount
} from '../lib/metrics';
import { Badge, Card, Empty, Stat, TableShell } from './ui';

const HEALTH_LABEL = { ok: 'Healthy', stale: 'Stale', offline: 'Offline' } as const;

export function OverviewView({ data, scope }: { data: CorpData; scope: Scope }) {
  const now = new Date();
  const today = toDateInput(now);
  const todayShifts = data.shifts.filter((shift) => shift.start_at?.startsWith(today));
  const activeShifts = data.shifts.filter((shift) => isShiftActive(shift, now));
  const month = monthShifts(data.shifts, now);
  const minutes = month.reduce((total, shift) => total + shiftMinutes(shift), 0);
  const payroll = payrollTotals(payrollRows(data, now, ''));
  const sitesReporting = data.sites.filter((site) => syncHealth(site) === 'ok').length;
  const pending = [
    ...data.timeOff.filter((row) => row.status === 'pending').map((row) => ({
      id: row.id,
      kind: 'Time off',
      employee: row.employee_name ?? '—',
      detail: `${formatDate(row.start_date)} → ${formatDate(row.end_date)}`,
      status: row.status
    })),
    ...data.exceptions.filter((row) => row.status === 'pending').map((row) => ({
      id: row.id,
      kind: `Exception ${row.exception_code ?? ''}`.trim(),
      employee: row.employee_name ?? '—',
      detail: row.title ?? '—',
      status: row.status
    })),
    ...data.overtime.filter((row) => row.status === 'pending').map((row) => ({
      id: row.id,
      kind: 'Overtime',
      employee: row.employee_name ?? '—',
      detail: `${formatDate(row.start_at)} ${formatRange(row.start_at, row.end_at)}`,
      status: row.status
    }))
  ];

  return (
    <div className="view-stack">
      <div className="stat-grid">
        <Stat
          label="Sites reporting"
          value={`${sitesReporting}/${data.sites.length}`}
          hint={data.sites.length ? 'Snapshots within 20 minutes' : 'No site connected yet'}
          tone={sitesReporting === data.sites.length && data.sites.length > 0 ? 'good' : 'warn'}
        />
        <Stat
          label="People on file"
          value={formatNumber(data.employees.length, 0)}
          hint={`${data.employees.filter((row) => row.role === 'admin').length} ${
            data.employees.filter((row) => row.role === 'admin').length === 1
              ? 'administrator'
              : 'administrators'
          }`}
        />
        <Stat
          label="On shift now"
          value={formatNumber(activeShifts.length, 0)}
          hint={`${todayShifts.length} shifts scheduled today`}
        />
        <Stat
          label="Hours this month"
          value={formatHours(minutes)}
          hint={`${formatMoney(payroll.gross)} estimated payroll`}
        />
        <Stat
          label="Pending requests"
          value={formatNumber(pendingRequestCount(data), 0)}
          hint="Time off, exceptions, overtime"
          tone={pendingRequestCount(data) > 0 ? 'warn' : undefined}
        />
        <Stat
          label="Open tasks"
          value={formatNumber(openTaskCount(data), 0)}
          hint={`${unpaidTrainingCount(data)} training items outstanding`}
        />
      </div>

      <div className="grid-2">
        <Card title="Sites" subtitle="One card per RealtimeSuite installation">
          {data.sites.length === 0 ? (
            <Empty>
              No site has synced yet. Configure <code>CORP_SUPABASE_URL</code> and{' '}
              <code>CORP_SITE_ID</code> in the RealtimeSuite server, then run a sync.
            </Empty>
          ) : (
            <ul className="site-list">
              {data.sites.map((site) => {
                const health = syncHealth(site);
                const location = data.locations.find((row) => row.id === site.location_id);
                return (
                  <li key={site.id} className="site-row">
                    <div>
                      <strong>{site.name}</strong>
                      <p className="muted small">
                        {location?.name ?? 'Unassigned location'} ·{' '}
                        {site.app_version ? `v${site.app_version}` : 'version unknown'}
                      </p>
                    </div>
                    <div className="site-row-meta">
                      <span className={`dot dot-${health}`} />
                      <span className="small">{HEALTH_LABEL[health]}</span>
                      <span className="muted small">{relativeTime(site.last_sync_at)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card
          title="Needs review"
          subtitle="Requests waiting on a site manager"
          actions={<Badge value="pending" label={`${pending.length} pending`} />}
        >
          {pending.length === 0 ? (
            <Empty>Nothing is waiting for review.</Empty>
          ) : (
            <TableShell>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Employee</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {pending.slice(0, 8).map((row) => (
                  <tr key={`${row.kind}-${row.id}`}>
                    <td>{row.kind}</td>
                    <td>{row.employee}</td>
                    <td className="muted">{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Recent discipline" subtitle="Write-ups and applied punishments">
          {data.discipline.length === 0 ? (
            <Empty>No discipline actions on record.</Empty>
          ) : (
            <TableShell>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Action</th>
                  <th>Punishment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.discipline.slice(0, 6).map((row) => (
                  <tr key={row.id}>
                    <td>{row.employee_name ?? '—'}</td>
                    <td>{row.title ?? '—'}</td>
                    <td className="muted">{humanize(row.punishment_type)}</td>
                    <td>
                      <Badge value={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>

        <Card title="Payroll snapshot" subtitle="Current month, all sites">
          <div className="mini-stats">
            <div>
              <span className="stat-label">Employees paid</span>
              <strong>{payroll.employees}</strong>
            </div>
            <div>
              <span className="stat-label">Shifts</span>
              <strong>{payroll.shifts}</strong>
            </div>
            <div>
              <span className="stat-label">Hours</span>
              <strong>{formatHours(payroll.minutes)}</strong>
            </div>
            <div>
              <span className="stat-label">Gross estimate</span>
              <strong>{formatMoney(payroll.gross)}</strong>
            </div>
          </div>
          <p className="muted small">
            Estimates use each employee's hourly rate and shift pay multiplier from{' '}
            {scope.company_name}. Overtime and discipline adjustments are applied at the site.
          </p>
        </Card>
      </div>
    </div>
  );
}
