import { useEffect, useMemo, useState } from 'react';
import type { ProfileRow, ShiftRow, TaskAssignmentRow, WorkAreaRow } from '../types';
import { toTimeHHMM } from '../lib/time';

type EmployeeRosterProps = {
  employees: ProfileRow[];
  shifts: ShiftRow[];
  taskAssignments: TaskAssignmentRow[];
  workAreas: WorkAreaRow[];
  searchOverride?: string;
};

function statusLabel(status: ShiftRow['status'] | null): string {
  if (!status) return 'Unscheduled';
  return status.replace('_', ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

export function EmployeeRoster({
  employees,
  shifts,
  taskAssignments,
  workAreas,
  searchOverride
}: EmployeeRosterProps) {
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (typeof searchOverride === 'string') {
      setSearch(searchOverride);
    }
  }, [searchOverride]);

  const workAreaById = useMemo(() => {
    return new Map(workAreas.map((workArea) => [workArea.id, workArea]));
  }, [workAreas]);

  const shiftsByEmployee = useMemo(() => {
    const map = new Map<string, ShiftRow[]>();
    for (const shift of shifts) {
      if (!shift.employee_id) continue;
      const bucket = map.get(shift.employee_id) ?? [];
      bucket.push(shift);
      map.set(shift.employee_id, bucket);
    }

    for (const bucket of map.values()) {
      bucket.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
    }
    return map;
  }, [shifts]);

  const taskCountByEmployee = useMemo(() => {
    const map = new Map<string, number>();
    for (const assignment of taskAssignments) {
      map.set(assignment.employee_id, (map.get(assignment.employee_id) ?? 0) + 1);
    }
    return map;
  }, [taskAssignments]);

  const workedMinutesByEmployee = useMemo(() => {
    const map = new Map<string, number>();
    for (const shift of shifts) {
      if (!shift.employee_id) continue;
      map.set(shift.employee_id, (map.get(shift.employee_id) ?? 0) + (shift.worked_minutes ?? 0));
    }
    return map;
  }, [shifts]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return employees;

    return employees.filter((employee) => {
      const employeeShifts = shiftsByEmployee.get(employee.id) ?? [];
      const areas = employeeShifts
        .map((shift) => (shift.work_area_id ? workAreaById.get(shift.work_area_id)?.name ?? '' : ''))
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return (
        employee.full_name.toLowerCase().includes(term) ||
        employee.email.toLowerCase().includes(term) ||
        employee.helpful_info.toLowerCase().includes(term) ||
        areas.includes(term)
      );
    });
  }, [employees, search, shiftsByEmployee, workAreaById]);


  return (
    <section className="roster-shell">
      <div className="roster-head">
        <h2>Employee Roster</h2>
        <input
          type="search"
          placeholder="Search employee, email, work area..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="roster-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Area</th>
              <th>Shift</th>
              <th>Status</th>
              <th>Assigned Tasks</th>
              <th>Worked Hrs (Day)</th>
              <th>Hourly Rate</th>
              <th>Helpful Info</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((employee) => {
              const employeeShifts = shiftsByEmployee.get(employee.id) ?? [];
              const areaNames = Array.from(
                new Set(
                  employeeShifts
                    .map((shift) => (shift.work_area_id ? workAreaById.get(shift.work_area_id)?.name ?? null : null))
                    .filter((value): value is string => Boolean(value))
                )
              );
              const shiftRanges = employeeShifts.map((shift) => `${toTimeHHMM(shift.start_at)}-${toTimeHHMM(shift.end_at)}`);
              const statusClass =
                employeeShifts.length === 0 ? 'off_shift' : employeeShifts.length === 1 ? employeeShifts[0].status : 'multiple';
              const statusText =
                employeeShifts.length === 0 ? statusLabel(null) : employeeShifts.length === 1 ? statusLabel(employeeShifts[0].status) : 'Multiple';

              return (
                <tr key={employee.id}>
                  <td>{employee.full_name || employee.email}</td>
                  <td>{employee.email}</td>
                  <td>{areaNames.length > 0 ? areaNames.join(', ') : 'Unassigned'}</td>
                  <td>{shiftRanges.length > 0 ? shiftRanges.join(', ') : '-'}</td>
                  <td>
                    <span className={`status-chip ${statusClass}`}>{statusText}</span>
                  </td>
                  <td>{taskCountByEmployee.get(employee.id) ?? 0}</td>
                  <td>{((workedMinutesByEmployee.get(employee.id) ?? 0) / 60).toFixed(2)}</td>
                  <td>{employee.hourly_rate == null ? '-' : `$${Number(employee.hourly_rate).toFixed(2)}`}</td>
                  <td>{employee.helpful_info?.trim() ? employee.helpful_info : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
