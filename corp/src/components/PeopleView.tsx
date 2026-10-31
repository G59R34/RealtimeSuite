import { useMemo, useState } from 'react';
import type { CommandRequest, CorpData } from '../types';
import { formatDate, formatMoney, humanize } from '../lib/format';
import { latestCommand } from '../lib/commands';
import { Badge, Card, Empty, Stat, TableShell } from './ui';
import { CommandError, CommandState, RateEditor } from './CommandControls';

export function PeopleView({
  data,
  canManage,
  onCommand
}: {
  data: CorpData;
  canManage: boolean;
  onCommand: (request: CommandRequest) => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [site, setSite] = useState('');
  const [role, setRole] = useState('');

  const siteNames = useMemo(
    () => new Map(data.sites.map((row) => [row.id, row.name])),
    [data.sites]
  );

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return data.employees.filter((employee) => {
      if (site && employee.site_id !== site) return false;
      if (role && (employee.role ?? 'employee') !== role) return false;
      if (!needle) return true;
      return (
        (employee.full_name ?? '').toLowerCase().includes(needle) ||
        (employee.email ?? '').toLowerCase().includes(needle)
      );
    });
  }, [data.employees, search, site, role]);

  const admins = data.employees.filter((row) => row.role === 'admin').length;
  const onboarding = data.employees.filter((row) => !row.onboarding_completed_at).length;
  const rates = data.employees
    .map((row) => Number(row.hourly_rate ?? 0))
    .filter((rate) => rate > 0);
  const averageRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;

  return (
    <div className="view-stack">
      <div className="stat-grid compact">
        <Stat label="Employees" value={String(data.employees.length)} />
        <Stat label="Administrators" value={String(admins)} />
        <Stat
          label="Onboarding open"
          value={String(onboarding)}
          tone={onboarding > 0 ? 'warn' : undefined}
        />
        <Stat label="Average rate" value={`${formatMoney(averageRate)}/h`} />
      </div>

      <Card
        title="People"
        subtitle="Pay rates and roles are set here; the site applies each change in seconds"
        actions={
          <div className="toolbar">
            <input
              className="search"
              placeholder="Search name or email"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select value={site} onChange={(event) => setSite(event.target.value)}>
              <option value="">All sites</option>
              {data.sites.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
            <select value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="">All roles</option>
              <option value="employee">Employee</option>
              <option value="admin">Administrator</option>
            </select>
          </div>
        }
      >
        {rows.length === 0 ? (
          <Empty>No people match these filters.</Empty>
        ) : (
          <TableShell>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Site</th>
                <th>Rate</th>
                <th>Onboarding</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((employee) => (
                <tr key={employee.id}>
                  <td>
                    {employee.full_name ?? '—'}
                    {employee.is_training_manager && (
                      <span className="tag">training manager</span>
                    )}
                  </td>
                  <td className="muted">{employee.email ?? '—'}</td>
                  <td>
                    {canManage ? (
                      <select
                        value={employee.role ?? 'employee'}
                        onChange={(event) =>
                          void onCommand({
                            kind: 'set_employee_permissions',
                            siteId: employee.site_id,
                            targetId: employee.id,
                            payload: { role: event.target.value }
                          })
                        }
                      >
                        <option value="employee">Employee</option>
                        <option value="admin">Administrator</option>
                      </select>
                    ) : (
                      <Badge value={employee.role ?? 'employee'} />
                    )}
                    <CommandState
                      command={latestCommand(
                        data.commands,
                        'set_employee_permissions',
                        employee.id
                      )}
                    />
                  </td>
                  <td className="muted">{siteNames.get(employee.site_id) ?? '—'}</td>
                  <td>
                    <RateEditor
                      rate={employee.hourly_rate}
                      command={latestCommand(data.commands, 'set_pay_rate', employee.id)}
                      disabled={!canManage}
                      onSave={(rate) =>
                        onCommand({
                          kind: 'set_pay_rate',
                          siteId: employee.site_id,
                          targetId: employee.id,
                          payload: { hourly_rate: rate }
                        })
                      }
                    />
                    <CommandError command={latestCommand(data.commands, 'set_pay_rate', employee.id)} />
                  </td>
                  <td>
                    {employee.onboarding_completed_at ? (
                      <span className="muted small">
                        {formatDate(employee.onboarding_completed_at)}
                      </span>
                    ) : (
                      <Badge value="pending" label="Pending" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Discipline history" subtitle="Write-ups and punishments from every site">
          {data.discipline.length === 0 ? (
            <Empty>No discipline actions recorded.</Empty>
          ) : (
            <TableShell>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Action</th>
                  <th>Punishment</th>
                  <th>Leave</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.discipline.slice(0, 10).map((row) => (
                  <tr key={row.id}>
                    <td>{row.employee_name ?? '—'}</td>
                    <td>
                      {row.title ?? '—'}
                      {row.severity && <span className="tag">{humanize(row.severity)}</span>}
                    </td>
                    <td className="muted">{humanize(row.punishment_type)}</td>
                    <td className="muted small">
                      {row.leave_starts_on
                        ? `${formatDate(row.leave_starts_on)} → ${formatDate(row.leave_ends_on)}`
                        : '—'}
                    </td>
                    <td>
                      <Badge value={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>

        <Card title="Training completion" subtitle="Assigned training across sites">
          {data.training.length === 0 ? (
            <Empty>No training assignments mirrored yet.</Empty>
          ) : (
            <TableShell>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Course</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.training.slice(0, 10).map((row) => (
                  <tr key={row.id}>
                    <td>{row.employee_name ?? '—'}</td>
                    <td>{row.course_title ?? '—'}</td>
                    <td className="muted small">{formatDate(row.due_at)}</td>
                    <td>
                      <Badge value={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>
      </div>
    </div>
  );
}
