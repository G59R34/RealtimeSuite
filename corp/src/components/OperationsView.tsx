import { useMemo, useState } from 'react';
import type { CommandRequest, CorpData } from '../types';
import { formatRange, formatTime, humanize, toDateInput } from '../lib/format';
import { latestCommand } from '../lib/commands';
import { dayBounds, isShiftActive, shiftMinutes } from '../lib/metrics';
import { Badge, Card, Empty, Stat, TableShell } from './ui';
import { CommandError, CommandState } from './CommandControls';

export function OperationsView({
  data,
  canManage,
  onCommand
}: {
  data: CorpData;
  canManage: boolean;
  onCommand: (request: CommandRequest) => Promise<void>;
}) {
  const [day, setDay] = useState(toDateInput(new Date()));
  const [site, setSite] = useState('');

  const { shifts, tasks, overtime } = useMemo(() => {
    const { from, to } = dayBounds(day);
    const inDay = (value: string | null) => {
      if (!value) return false;
      const date = new Date(value);
      return date >= from && date < to;
    };
    return {
      shifts: data.shifts.filter(
        (row) => inDay(row.start_at) && (!site || row.site_id === site)
      ),
      tasks: data.tasks.filter((row) => inDay(row.start_at) && (!site || row.site_id === site)),
      overtime: data.overtime.filter(
        (row) => inDay(row.start_at) && (!site || row.site_id === site)
      )
    };
  }, [data, day, site]);

  const siteNames = useMemo(
    () => new Map(data.sites.map((row) => [row.id, row.name])),
    [data.sites]
  );
  const now = new Date();
  const active = shifts.filter((row) => isShiftActive(row, now));
  const minutes = shifts.reduce((total, row) => total + shiftMinutes(row), 0);
  const locations = new Set(shifts.map((row) => row.site_id)).size;

  return (
    <div className="view-stack">
      <div className="toolbar toolbar-wide">
        <label className="inline-field">
          <span className="muted small">Date</span>
          <input type="date" value={day} onChange={(event) => setDay(event.target.value)} />
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
      </div>

      <div className="stat-grid compact">
        <Stat label="Shifts" value={String(shifts.length)} hint={`${active.length} active now`} />
        <Stat label="Scheduled hours" value={`${(minutes / 60).toFixed(1)}h`} />
        <Stat label="Sites active" value={String(locations)} />
        <Stat
          label="Tasks"
          value={String(tasks.length)}
          hint={`${tasks.filter((row) => row.status === 'done').length} done`}
        />
      </div>

      <Card
        title="Shifts"
        subtitle="Scheduled and worked time for the day; pay multipliers are set here"
      >
        {shifts.length === 0 ? (
          <Empty>No shifts on this date.</Empty>
        ) : (
          <TableShell>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Work area</th>
                <th>Window</th>
                <th>Clocked</th>
                <th>Break</th>
                <th>Pay multiplier</th>
                <th>Site</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((shift) => (
                <tr key={shift.id}>
                  <td>{shift.employee_name ?? '—'}</td>
                  <td className="muted">{shift.work_area_name ?? '—'}</td>
                  <td>{formatRange(shift.start_at, shift.end_at)}</td>
                  <td className="muted small">
                    {shift.clocked_in_at
                      ? `${formatTime(shift.clocked_in_at)} → ${formatTime(shift.clocked_out_at)}`
                      : 'Not clocked in'}
                  </td>
                  <td>{shift.break_minutes ?? 0}m</td>
                  <td>
                    {canManage ? (
                      <span className="inline-field">
                        <input
                          type="number"
                          min={0.1}
                          max={10}
                          step="0.05"
                          defaultValue={Number(shift.pay_multiplier ?? 1) || 1}
                          style={{ width: '80px' }}
                          onBlur={(event) => {
                            const next = Number(event.target.value);
                            if (!Number.isFinite(next) || next <= 0) return;
                            if (next === (Number(shift.pay_multiplier ?? 1) || 1)) return;
                            void onCommand({
                              kind: 'set_shift_multiplier',
                              siteId: shift.site_id,
                              targetId: shift.id,
                              payload: { pay_multiplier: next }
                            });
                          }}
                          aria-label="Shift pay multiplier"
                        />
                        <span className="muted small">x</span>
                      </span>
                    ) : (
                      <span>{Number(shift.pay_multiplier ?? 1).toFixed(2)}x</span>
                    )}
                    <CommandState
                      command={latestCommand(data.commands, 'set_shift_multiplier', shift.id)}
                    />
                    <CommandError
                      command={latestCommand(data.commands, 'set_shift_multiplier', shift.id)}
                    />
                  </td>
                  <td className="muted">{siteNames.get(shift.site_id) ?? '—'}</td>
                  <td>
                    <Badge value={shift.status} />
                    {shift.is_unscheduled_overtime && <span className="tag">OT</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Tasks" subtitle="Work assigned during the day">
          {tasks.length === 0 ? (
            <Empty>No tasks on this date.</Empty>
          ) : (
            <TableShell>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Assignee</th>
                  <th>Window</th>
                  <th>Priority</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      {task.title ?? '—'}
                      {task.source_system === 'github' && <span className="tag">github</span>}
                    </td>
                    <td className="muted">{task.assignee_name ?? 'Unassigned'}</td>
                    <td className="small">{formatRange(task.start_at, task.end_at)}</td>
                    <td>
                      <Badge value={task.priority} />
                    </td>
                    <td>
                      <Badge value={task.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>

        <Card title="Overtime" subtitle="Requests touching this date">
          {overtime.length === 0 ? (
            <Empty>No overtime entries on this date.</Empty>
          ) : (
            <TableShell>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Window</th>
                  <th>Type</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {overtime.map((row) => (
                  <tr key={row.id}>
                    <td>{row.employee_name ?? '—'}</td>
                    <td className="small">{formatRange(row.start_at, row.end_at)}</td>
                    <td className="muted">{humanize(row.overtime_type)}</td>
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
