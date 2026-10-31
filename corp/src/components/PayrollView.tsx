import { useMemo, useState } from 'react';
import type { CommandRequest, CorpData } from '../types';
import { formatHours, formatMoney, toDateInput } from '../lib/format';
import { latestCommand } from '../lib/commands';
import { payrollRows, payrollTotals } from '../lib/metrics';
import { Badge, Card, Empty, Stat, TableShell } from './ui';
import { CommandError, CommandState, RateEditor } from './CommandControls';

export function PayrollView({
  data,
  canManage,
  onCommand
}: {
  data: CorpData;
  canManage: boolean;
  onCommand: (request: CommandRequest) => Promise<void>;
}) {
  const [month, setMonth] = useState(toDateInput(new Date()).slice(0, 7));
  const [site, setSite] = useState('');

  const monthDate = useMemo(() => {
    const [year, monthIndex] = month.split('-').map(Number);
    return new Date(year, (monthIndex ?? 1) - 1, 1);
  }, [month]);

  const rows = useMemo(() => payrollRows(data, monthDate, site), [data, monthDate, site]);
  const totals = payrollTotals(rows);
  const label = monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  function exportCsv() {
    const header = ['Employee', 'Site', 'Role', 'Rate', 'Shifts', 'Hours', 'Gross'];
    const lines = rows.map((row) =>
      [
        row.name,
        row.site,
        row.role,
        row.rate.toFixed(2),
        String(row.shiftCount),
        (row.minutes / 60).toFixed(2),
        row.gross.toFixed(2)
      ]
        .map((value) => `"${value.replace(/"/g, '""')}"`)
        .join(',')
    );
    const csv = [header.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `realtimecorp-payroll-${month}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="view-stack">
      <div className="toolbar toolbar-wide">
        <label className="inline-field">
          <span className="muted small">Month</span>
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </label>
        <label className="inline-field">
          <span className="muted small">Site</span>
          <select value={site} onChange={(event) => setSite(event.target.value)}>
            <option value="">All sites</option>
            {data.sites.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <button className="button" type="button" onClick={exportCsv} disabled={rows.length === 0}>
          Export CSV
        </button>
      </div>

      <div className="stat-grid compact">
        <Stat label="Gross estimate" value={formatMoney(totals.gross)} hint={label} />
        <Stat label="Hours" value={formatHours(totals.minutes)} />
        <Stat label="Employees" value={String(totals.employees)} />
        <Stat label="Shifts" value={String(totals.shifts)} />
      </div>

      <Card
        title={`Payroll · ${label}`}
        subtitle="Rates are set here and applied by each site; hours come from worked minutes when present"
      >
        {rows.length === 0 ? (
          <Empty>No shifts mirrored for this month.</Empty>
        ) : (
          <TableShell>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Site</th>
                <th>Role</th>
                <th>Rate</th>
                <th>Shifts</th>
                <th>Hours</th>
                <th>Gross</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employeeId}>
                  <td>{row.name}</td>
                  <td className="muted">{row.site}</td>
                  <td>
                    <Badge value={row.role} />
                  </td>
                  <td>
                    <RateEditor
                      rate={row.rate || null}
                      command={latestCommand(data.commands, 'set_pay_rate', row.employeeId)}
                      disabled={!canManage}
                      onSave={(rate) =>
                        onCommand({
                          kind: 'set_pay_rate',
                          siteId: row.siteId,
                          targetId: row.employeeId,
                          payload: { hourly_rate: rate }
                        })
                      }
                    />
                    <CommandState
                      command={latestCommand(data.commands, 'set_pay_rate', row.employeeId)}
                    />
                    <CommandError
                      command={latestCommand(data.commands, 'set_pay_rate', row.employeeId)}
                    />
                  </td>
                  <td>{row.shiftCount}</td>
                  <td>{formatHours(row.minutes)}</td>
                  <td>
                    <strong>{formatMoney(row.gross)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={4}>Total</th>
                <th>{totals.shifts}</th>
                <th>{formatHours(totals.minutes)}</th>
                <th>{formatMoney(totals.gross)}</th>
              </tr>
            </tfoot>
          </TableShell>
        )}
      </Card>

      <Card title="Adjustments" subtitle="Overtime and exception time recorded at the sites">
        <div className="grid-2 inner">
          <div>
            <h3 className="subhead">Approved overtime</h3>
            {data.overtime.filter((row) => row.status === 'approved').length === 0 ? (
              <Empty>No approved overtime mirrored.</Empty>
            ) : (
              <ul className="plain-list">
                {data.overtime
                  .filter((row) => row.status === 'approved')
                  .slice(0, 8)
                  .map((row) => (
                    <li key={row.id}>
                      <span>{row.employee_name ?? '—'}</span>
                      <span className="muted small">
                        {row.start_at ? new Date(row.start_at).toLocaleDateString() : '—'}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="subhead">Unpaid leave / exceptions</h3>
            {data.exceptions.filter((row) => row.status === 'approved').length === 0 ? (
              <Empty>No approved exceptions mirrored.</Empty>
            ) : (
              <ul className="plain-list">
                {data.exceptions
                  .filter((row) => row.status === 'approved')
                  .slice(0, 8)
                  .map((row) => (
                    <li key={row.id}>
                      <span>{row.employee_name ?? '—'}</span>
                      <span className="muted small">{row.exception_code ?? '—'}</span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
