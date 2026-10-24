import { useMemo } from 'react';
import type { ProfileRow, ShiftRow } from '../types';
import { toReadableDate } from '../lib/time';

type ClockInAuditProps = {
  employees: ProfileRow[];
  shifts: ShiftRow[];
};

function toDeviceLabel(shift: ShiftRow): string {
  if (shift.clock_in_is_mobile === true) return 'Mobile';
  if (shift.clock_in_is_mobile === false) return 'Desktop/Web';
  if (shift.clock_in_device && shift.clock_in_device.trim().length > 0) return shift.clock_in_device;
  return '-';
}

function toLocationLabel(shift: ShiftRow): string {
  if (typeof shift.clock_in_latitude !== 'number' || typeof shift.clock_in_longitude !== 'number') {
    return '-';
  }
  const base = `${shift.clock_in_latitude.toFixed(6)}, ${shift.clock_in_longitude.toFixed(6)}`;
  if (typeof shift.clock_in_accuracy_meters === 'number' && Number.isFinite(shift.clock_in_accuracy_meters)) {
    return `${base} (+/-${Math.round(shift.clock_in_accuracy_meters)}m)`;
  }
  return base;
}

export function ClockInAudit({ employees, shifts }: ClockInAuditProps) {
  const employeeById = useMemo(
    () => new Map(employees.map((employee) => [employee.id, employee])),
    [employees]
  );

  const rows = useMemo(() => {
    return shifts
      .filter((shift) => Boolean(shift.clocked_in_at))
      .slice()
      .sort((a, b) => {
        const left = a.clocked_in_at ? new Date(a.clocked_in_at).getTime() : 0;
        const right = b.clocked_in_at ? new Date(b.clocked_in_at).getTime() : 0;
        return right - left;
      });
  }, [shifts]);

  return (
    <section className="roster-shell">
      <div className="roster-head">
        <h2>Clock-In Audit</h2>
      </div>

      <div className="roster-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Clock-In</th>
              <th>Clock-Out</th>
              <th>Device</th>
              <th>Location</th>
              <th>Status</th>
              <th>Shift Window</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((shift) => {
              const employee = shift.employee_id ? employeeById.get(shift.employee_id) : undefined;
              return (
                <tr key={shift.id}>
                  <td>{employee?.full_name || employee?.email || shift.employee_id}</td>
                  <td>{shift.clocked_in_at ? toReadableDate(shift.clocked_in_at) : '-'}</td>
                  <td>{shift.clocked_out_at ? toReadableDate(shift.clocked_out_at) : '-'}</td>
                  <td>{toDeviceLabel(shift)}</td>
                  <td>{toLocationLabel(shift)}</td>
                  <td>{shift.status}</td>
                  <td>{toReadableDate(shift.start_at)} - {toReadableDate(shift.end_at)}</td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7}>No clock-ins found for this date.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
