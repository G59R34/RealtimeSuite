import { useMemo, useState } from 'react';
import type { ProfileRow, ShiftRow, TaskAssignmentRow, TaskRow, WorkAreaRow } from '../types';
import { toReadableDate, toTimeHHMM } from '../lib/time';

type AdminReportsProps = {
  employees: ProfileRow[];
  shifts: ShiftRow[];
  tasks: TaskRow[];
  taskAssignments: TaskAssignmentRow[];
  workAreas: WorkAreaRow[];
  selectedDate: string;
};

type EmployeeReport = {
  employee: ProfileRow;
  shifts: ShiftRow[];
  assignments: Array<{ assignment: TaskAssignmentRow; task: TaskRow }>;
  workedMinutes: number;
  unscheduledOvertimeMinutes: number;
  lateClockOutMinutes: number;
  acknowledgedCount: number;
  pendingAckCount: number;
};

function statusLabel(status: string): string {
  return status.replace('_', ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

function minutesBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return Math.floor((end - start) / 60000);
}

function formatHours(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

export function AdminReports({ employees, shifts, tasks, taskAssignments, workAreas, selectedDate }: AdminReportsProps) {
  const [search, setSearch] = useState('');
  const workAreaById = useMemo(() => new Map(workAreas.map((area) => [area.id, area.name])), [workAreas]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  const reports = useMemo<EmployeeReport[]>(() => {
    const assignmentsByEmployee = new Map<string, Array<{ assignment: TaskAssignmentRow; task: TaskRow }>>();
    for (const assignment of taskAssignments) {
      const task = taskById.get(assignment.task_id);
      if (!task) continue;
      const bucket = assignmentsByEmployee.get(assignment.employee_id) ?? [];
      bucket.push({ assignment, task });
      assignmentsByEmployee.set(assignment.employee_id, bucket);
    }

    return employees
      .map((employee) => {
        const employeeShifts = shifts
          .filter((shift) => shift.employee_id === employee.id)
          .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
        const assignments = (assignmentsByEmployee.get(employee.id) ?? []).sort(
          (a, b) => new Date(a.task.start_at).getTime() - new Date(b.task.start_at).getTime()
        );

        const workedMinutes = employeeShifts.reduce((sum, shift) => sum + (shift.worked_minutes ?? 0), 0);
        const unscheduledOvertimeMinutes = employeeShifts
          .filter((shift) => shift.is_unscheduled_overtime || shift.pay_multiplier > 1)
          .reduce((sum, shift) => sum + (shift.worked_minutes ?? 0), 0);
        const lateClockOutMinutes = employeeShifts.reduce((sum, shift) => {
          if (shift.is_unscheduled_overtime || !shift.clocked_out_at) return sum;
          const plannedEnd = new Date(shift.end_at).getTime();
          const clockedOut = new Date(shift.clocked_out_at).getTime();
          if (Number.isNaN(plannedEnd) || Number.isNaN(clockedOut) || clockedOut <= plannedEnd) return sum;
          return sum + Math.floor((clockedOut - plannedEnd) / 60000);
        }, 0);

        const acknowledgedCount = assignments.filter(({ assignment }) => Boolean(assignment.acknowledged_at)).length;
        const pendingAckCount = assignments.length - acknowledgedCount;

        return {
          employee,
          shifts: employeeShifts,
          assignments,
          workedMinutes,
          unscheduledOvertimeMinutes,
          lateClockOutMinutes,
          acknowledgedCount,
          pendingAckCount
        };
      })
      .filter((report) => report.shifts.length > 0 || report.assignments.length > 0);
  }, [employees, shifts, taskAssignments, taskById]);

  const filteredReports = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return reports;
    return reports.filter(({ employee }) => {
      return employee.full_name.toLowerCase().includes(term) || employee.email.toLowerCase().includes(term);
    });
  }, [reports, search]);

  const totals = useMemo(() => {
    return filteredReports.reduce(
      (acc, report) => {
        acc.shifts += report.shifts.length;
        acc.tasks += report.assignments.length;
        acc.workedMinutes += report.workedMinutes;
        acc.unscheduledOvertimeMinutes += report.unscheduledOvertimeMinutes;
        acc.pendingAck += report.pendingAckCount;
        return acc;
      },
      { shifts: 0, tasks: 0, workedMinutes: 0, unscheduledOvertimeMinutes: 0, pendingAck: 0 }
    );
  }, [filteredReports]);

  return (
    <section className="reports-shell">
      <div className="reports-head">
        <h2>Daily Operations Report ({selectedDate})</h2>
        <input
          type="search"
          placeholder="Search employee..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="reports-metrics">
        <div className="reports-metric"><strong>{filteredReports.length}</strong><span>Employees Logged</span></div>
        <div className="reports-metric"><strong>{totals.shifts}</strong><span>Shifts</span></div>
        <div className="reports-metric"><strong>{totals.tasks}</strong><span>Task Assignments</span></div>
        <div className="reports-metric"><strong>{formatHours(totals.workedMinutes)}</strong><span>Worked Hours</span></div>
        <div className="reports-metric"><strong>{formatHours(totals.unscheduledOvertimeMinutes)}</strong><span>Unscheduled OT Hours</span></div>
        <div className="reports-metric"><strong>{totals.pendingAck}</strong><span>Pending ACK</span></div>
      </div>

      <div className="reports-list">
        {filteredReports.length === 0 ? <p className="empty-state">No report entries for this date.</p> : null}
        {filteredReports.map((report) => (
          <article className="report-card" key={report.employee.id}>
            <header className="report-card-head">
              <div>
                <h3>{report.employee.full_name || report.employee.email}</h3>
                <p>{report.employee.email}</p>
              </div>
              <div className="report-badges">
                <span className="report-badge">Worked: {formatHours(report.workedMinutes)}h</span>
                <span className="report-badge">OT: {formatHours(report.unscheduledOvertimeMinutes + report.lateClockOutMinutes)}h</span>
                <span className="report-badge">ACK: {report.acknowledgedCount}/{report.assignments.length}</span>
              </div>
            </header>

            <div className="report-section">
              <h4>Shift Log</h4>
              {report.shifts.length === 0 ? (
                <p className="empty-state">No shifts.</p>
              ) : (
                <div className="roster-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Area</th>
                        <th>Scheduled</th>
                        <th>Status</th>
                        <th>Clock In</th>
                        <th>Clock Out</th>
                        <th>Worked Hrs</th>
                        <th>Overtime</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.shifts.map((shift) => {
                        const lateClockOutMinutes =
                          shift.is_unscheduled_overtime || !shift.clocked_out_at
                            ? 0
                            : Math.max(0, minutesBetween(shift.end_at, shift.clocked_out_at));
                        const overtimeMinutes = ((shift.is_unscheduled_overtime || shift.pay_multiplier > 1) ? shift.worked_minutes ?? 0 : 0) + lateClockOutMinutes;
                        return (
                          <tr key={shift.id}>
                            <td>{shift.work_area_id ? workAreaById.get(shift.work_area_id) ?? 'Unassigned' : 'Unassigned'}</td>
                            <td>{toTimeHHMM(shift.start_at)}-{toTimeHHMM(shift.end_at)}</td>
                            <td>
                              {statusLabel(shift.status)}
                              {shift.is_unscheduled_overtime ? ' (Unscheduled OT)' : shift.pay_multiplier > 1 ? ` (OT ${shift.pay_multiplier.toFixed(1)}x)` : ''}
                            </td>
                            <td>{shift.clocked_in_at ? toReadableDate(shift.clocked_in_at) : '-'}</td>
                            <td>{shift.clocked_out_at ? toReadableDate(shift.clocked_out_at) : '-'}</td>
                            <td>{formatHours(shift.worked_minutes ?? 0)}</td>
                            <td>{formatHours(overtimeMinutes)}</td>
                            <td>{shift.notes || '-'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="report-section">
              <h4>Task Assignment Log</h4>
              {report.assignments.length === 0 ? (
                <p className="empty-state">No task assignments.</p>
              ) : (
                <div className="roster-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Task</th>
                        <th>Window</th>
                        <th>Area</th>
                        <th>Status</th>
                        <th>Priority</th>
                        <th>ACK</th>
                        <th>ACK Time</th>
                        <th>ACK Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.assignments.map(({ assignment, task }) => (
                        <tr key={assignment.id}>
                          <td>{task.title}</td>
                          <td>{toTimeHHMM(task.start_at)}-{toTimeHHMM(task.end_at)}</td>
                          <td>{task.work_area_id ? workAreaById.get(task.work_area_id) ?? 'Unassigned' : 'Unassigned'}</td>
                          <td>{statusLabel(task.status)}</td>
                          <td>{statusLabel(task.priority)}</td>
                          <td>{assignment.acknowledged_at ? 'ACK' : 'Pending'}</td>
                          <td>{assignment.acknowledged_at ? toReadableDate(assignment.acknowledged_at) : '-'}</td>
                          <td>{assignment.acknowledgment_note?.trim() ? assignment.acknowledgment_note : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
