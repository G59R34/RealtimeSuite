from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from math import floor

from sqlalchemy import text
from sqlalchemy.orm import Session

# Punishments that take an employee off the schedule for their duration.
LEAVE_PUNISHMENTS = {"unpaid_suspension", "probation"}

# Exception codes that authorize a day off and must clear the schedule with it.
LEAVE_EXCEPTION_CODES = {"VAUT", "DO"}


def leave_days(value: object) -> int:
    """Whole days covered by a punishment length, matching apply_discipline_action."""
    try:
        return max(1, floor(float(value or 0)))
    except (TypeError, ValueError):
        return 1


def leave_window(punishment_type: str, punishment_value: object) -> tuple[date, date] | None:
    """Dates a punishment covers, starting today (UTC, like the SQL apply function)."""
    if punishment_type not in LEAVE_PUNISHMENTS:
        return None
    days = leave_days(punishment_value)
    start = datetime.now(timezone.utc).date()
    return start, start + timedelta(days=days - 1)


def _day_start(value: date) -> datetime:
    return datetime.combine(value, time.min).astimezone()


def wipe_employee_window(
    session: Session, employee_id: str, start_date: date, end_date: date
) -> dict[str, int]:
    """Remove an employee's shifts and task assignments inside a leave window."""
    start = _day_start(start_date)
    end = _day_start(end_date) + timedelta(days=1)
    shifts = session.execute(
        text(
            """
            delete from public.shifts
            where employee_id = :employee
              and start_at < :end and end_at > :start
            """
        ),
        {"employee": employee_id, "start": start, "end": end},
    ).rowcount
    assignments = session.execute(
        text(
            """
            delete from public.task_assignments
            where employee_id = :employee
              and task_id in (
                select id from public.tasks
                where start_at < :end and end_at > :start
              )
            """
        ),
        {"employee": employee_id, "start": start, "end": end},
    ).rowcount
    return {"shifts": max(shifts or 0, 0), "taskAssignments": max(assignments or 0, 0)}
