from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import session_scope
from ..deps import RequestUser, get_current_user, get_db, require_manager

router = APIRouter(prefix="/api", tags=["reports"])

SHIFT_COLUMNS = """
  s.id, s.employee_id, s.work_area_id, s.start_at, s.end_at, s.status::text as status,
  s.clocked_in_at, s.clocked_out_at, s.clock_in_latitude, s.clock_in_longitude,
  s.clock_in_accuracy_meters, s.clock_in_device, s.clock_in_is_mobile,
  s.is_unscheduled_overtime, s.pay_multiplier::float8 as pay_multiplier, s.worked_minutes, s.break_minutes,
  s.is_shift_pool, s.shift_pool_posted_at, s.shift_pool_posted_by,
  s.shift_pool_claimed_at, s.shift_pool_claimed_by, s.notes,
  s.created_by, s.updated_by, s.created_at, s.updated_at
"""

TASK_COLUMNS = """
  t.id, t.title, t.description, t.status::text as status, t.priority::text as priority,
  t.source_system, t.start_at, t.end_at, t.work_area_id, t.shift_id,
  t.created_by, t.updated_by, t.created_at, t.updated_at
"""

PROFILE_COLUMNS = """
  p.id, p.email, p.full_name, p.helpful_info, p.hourly_rate, p.role::text as role,
  p.retail_chaos_stationary, p.admin_training_only, p.is_training_manager,
  p.onboarding_started_at, p.onboarding_completed_at, p.onboarding_completed_version,
  p.onboarding_answers, p.created_at, p.updated_at
"""


def _bounds(value: str) -> tuple[datetime, datetime]:
    day = date.fromisoformat(value)
    start = datetime.combine(day, time.min).astimezone()
    return start, start + timedelta(days=1)


def _month_bounds(value: str) -> tuple[datetime, datetime]:
    day = date.fromisoformat(value)
    start = datetime(day.year, day.month, 1).astimezone()
    end = datetime(day.year + (1 if day.month == 12 else 0), 1 if day.month == 12 else day.month + 1, 1).astimezone()
    return start, end


def _serialize_profile(row) -> dict:
    data = dict(row)
    data["id"] = str(data["id"])
    if data.get("hourly_rate") is not None:
        data["hourly_rate"] = float(data["hourly_rate"])
    return data


@router.get("/dashboard")
def dashboard(
    selected_date: str | None = Query(default=None, alias="date"),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    selected_date = selected_date or date.today().isoformat()
    day_start, day_end = _bounds(selected_date)
    month_start, month_end = _month_bounds(selected_date)

    employees = [
        _serialize_profile(row)
        for row in session.execute(
            text(f"select {PROFILE_COLUMNS} from public.profiles p where p.role = 'employee' order by p.full_name")
        ).mappings().all()
    ]
    work_areas = [
        dict(row)
        for row in session.execute(text("select * from public.work_areas order by name")).mappings().all()
    ]
    shifts = [
        dict(row)
        for row in session.execute(
            text(
                f"select {SHIFT_COLUMNS} from public.shifts s "
                "where s.start_at >= :start and s.start_at < :end order by s.start_at"
            ),
            {"start": day_start, "end": day_end},
        ).mappings().all()
    ]
    month_shifts = [
        dict(row)
        for row in session.execute(
            text(
                f"select {SHIFT_COLUMNS} from public.shifts s "
                "where s.start_at >= :start and s.start_at < :end order by s.start_at"
            ),
            {"start": month_start, "end": month_end},
        ).mappings().all()
    ]
    tasks = [
        dict(row)
        for row in session.execute(
            text(
                f"select {TASK_COLUMNS} from public.tasks t "
                "where t.start_at >= :start and t.start_at < :end order by t.start_at"
            ),
            {"start": month_start, "end": month_end},
        ).mappings().all()
    ]
    task_ids = [row["id"] for row in tasks]
    assignments = []
    if task_ids:
        assignments = [
            dict(row)
            for row in session.execute(
                text(
                    """
                    select id, task_id, employee_id, assigned_by, assigned_at,
                           acknowledged_at, acknowledged_by, acknowledgment_note
                    from public.task_assignments
                    where task_id = any(:ids)
                    """
                ),
                {"ids": task_ids},
            ).mappings().all()
        ]
    tracking = [
        dict(row)
        for row in session.execute(
            text(
                """
                select a.* from public.activity_tracking a
                join public.shifts s on s.id = a.shift_id
                where s.start_at >= :start and s.start_at < :end
                order by a.captured_at desc limit 2000
                """
            ),
            {"start": day_start, "end": day_end},
        ).mappings().all()
    ]
    messages = [
        dict(row)
        for row in session.execute(
            text(
                """
                select id, organization_id, sender_id, recipient_id, subject, message,
                       read_at, created_at, thread_key
                from public.employee_messages
                order by created_at desc limit 400
                """
            )
        ).mappings().all()
    ]
    time_off = [
        dict(row)
        for row in session.execute(
            text("select * from public.time_off_requests order by created_at desc limit 500")
        ).mappings().all()
    ]
    exceptions = [
        dict(row)
        for row in session.execute(
            text("select * from public.exception_requests order by created_at desc limit 500")
        ).mappings().all()
    ]
    overtime = [
        dict(row)
        for row in session.execute(
            text("select * from public.overtime_requests order by created_at desc limit 500")
        ).mappings().all()
    ]
    swaps = [
        dict(row)
        for row in session.execute(
            text("select * from public.shift_swap_requests order by created_at desc limit 300")
        ).mappings().all()
    ]
    discipline = [
        dict(row)
        for row in session.execute(
            text("select * from public.discipline_actions order by created_at desc limit 300")
        ).mappings().all()
    ]
    intelligence = session.execute(
        text("select public.fetch_shift_intelligence(cast(:day as date), 14)"),
        {"day": selected_date},
    ).scalar()
    board_notes = [
        dict(row)
        for row in session.execute(
            text(
                """
                select n.id, n.note_date, n.body, n.is_public, n.created_by,
                       n.employee_id, n.work_area_id,
                       p.full_name as author_name,
                       e.full_name as employee_name,
                       w.name as work_area_name,
                       n.created_at, n.updated_at
                from public.board_notes n
                left join public.profiles p on p.id = n.created_by
                left join public.profiles e on e.id = n.employee_id
                left join public.work_areas w on w.id = n.work_area_id
                where n.note_date = cast(:day as date)
                  and (n.is_public or n.created_by = :viewer)
                order by n.created_at desc
                """
            ),
            {"day": selected_date, "viewer": user.id},
        ).mappings().all()
    ]

    return {
        "employees": employees,
        "workAreas": work_areas,
        "shifts": shifts,
        "monthShifts": month_shifts,
        "rocconnectorTracking": tracking,
        "tasks": tasks,
        "taskAssignments": assignments,
        "messages": messages,
        "timeOffRequests": time_off,
        "exceptionRequests": exceptions,
        "overtimeRequests": overtime,
        "shiftSwapRequests": swaps,
        "shiftIntelligence": intelligence if isinstance(intelligence, dict) else json.loads(intelligence or "{}"),
        "disciplineActions": discipline,
        "boardNotes": board_notes,
    }


@router.get("/portal")
def portal(
    selected_date: str | None = Query(default=None, alias="date"),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    selected_date = selected_date or date.today().isoformat()
    day_start, day_end = _bounds(selected_date)
    month_start, month_end = _month_bounds(selected_date)

    profile_row = session.execute(
        text(f"select {PROFILE_COLUMNS} from public.profiles p where p.id = :id"), {"id": user.id}
    ).mappings().first()
    admin_contacts = [
        _serialize_profile(row)
        for row in session.execute(
            text(
                f"select {PROFILE_COLUMNS} from public.profiles p "
                "where (p.role = 'admin' or p.is_training_manager) and p.id <> :id order by p.full_name"
            ),
            {"id": user.id},
        ).mappings().all()
    ]
    work_areas = [
        dict(row)
        for row in session.execute(text("select * from public.work_areas order by name")).mappings().all()
    ]
    shifts = [
        dict(row)
        for row in session.execute(
            text(
                f"select {SHIFT_COLUMNS} from public.shifts s "
                "where s.employee_id = :id and s.start_at < :end and s.end_at > :start "
                "order by s.start_at"
            ),
            {"id": user.id, "start": day_start, "end": day_end},
        ).mappings().all()
    ]
    pool_shifts = [
        dict(row)
        for row in session.execute(
            text(
                f"select {SHIFT_COLUMNS} from public.shifts s "
                "where s.is_shift_pool and s.start_at >= :start and s.start_at < :end "
                "and (s.employee_id is null or s.employee_id = :id) "
                "and s.shift_pool_claimed_by is null order by s.start_at"
            ),
            {"id": user.id, "start": day_start, "end": day_end},
        ).mappings().all()
    ]
    month_shifts = [
        dict(row)
        for row in session.execute(
            text(
                f"select {SHIFT_COLUMNS} from public.shifts s "
                "where s.employee_id = :id and s.start_at >= :start and s.start_at < :end "
                "order by s.start_at"
            ),
            {"id": user.id, "start": month_start, "end": month_end},
        ).mappings().all()
    ]
    assignment_rows = session.execute(
        text(
            """
            select ta.id, ta.task_id, ta.employee_id, ta.assigned_by, ta.assigned_at,
                   ta.acknowledged_at, ta.acknowledged_by, ta.acknowledgment_note
            from public.task_assignments ta
            where ta.employee_id = :id
            order by ta.assigned_at desc
            """
        ),
        {"id": user.id},
    ).mappings().all()
    task_rows = session.execute(
        text(
            f"""
            select {TASK_COLUMNS} from public.tasks t
            where t.id = any(:ids) and t.start_at < :end and t.end_at > :start
            order by t.start_at
            """
        ),
        {
            "ids": [row["task_id"] for row in assignment_rows] or [],
            "start": day_start,
            "end": day_end,
        },
    ).mappings().all()
    tasks_by_id = {str(row["id"]): dict(row) for row in task_rows}
    task_assignments = []
    for row in assignment_rows:
        task = tasks_by_id.get(str(row["task_id"]))
        if task:
            task_assignments.append({**dict(row), "task": task})

    messages = [
        dict(row)
        for row in session.execute(
            text(
                """
                select id, organization_id, sender_id, recipient_id, subject, message,
                       read_at, created_at, thread_key
                from public.employee_messages
                where sender_id = :id or recipient_id = :id
                order by created_at desc limit 300
                """
            ),
            {"id": user.id},
        ).mappings().all()
    ]
    notifications = [
        dict(row)
        for row in session.execute(
            text(
                """
                select * from public.app_notifications
                where recipient_id = :id order by created_at desc limit 100
                """
            ),
            {"id": user.id},
        ).mappings().all()
    ]
    preferences = session.execute(
        text("select * from public.employee_work_preferences where employee_id = :id limit 1"),
        {"id": user.id},
    ).mappings().first()
    swaps = session.execute(
        text(
            """
            select * from public.shift_swap_requests
            where status = 'open' and requested_employee_id is null
               or requester_id = :id or requested_employee_id = :id or accepted_by_employee_id = :id
            order by created_at desc limit 100
            """
        ),
        {"id": user.id},
    ).mappings().all()
    training = session.execute(
        text(
            """
            select ta.*, row_to_json(tc.*) as course
            from public.training_assignments ta
            left join public.training_courses tc on tc.id = ta.course_id
            where ta.employee_id = :id
            order by ta.assigned_at desc limit 200
            """
        ),
        {"id": user.id},
    ).mappings().all()
    time_off = session.execute(
        text(
            "select * from public.time_off_requests where employee_id = :id order by created_at desc limit 60"
        ),
        {"id": user.id},
    ).mappings().all()
    exceptions = session.execute(
        text(
            "select * from public.exception_requests where employee_id = :id order by created_at desc limit 100"
        ),
        {"id": user.id},
    ).mappings().all()
    overtime = session.execute(
        text(
            "select * from public.overtime_requests where employee_id = :id order by created_at desc limit 120"
        ),
        {"id": user.id},
    ).mappings().all()

    return {
        "profile": _serialize_profile(profile_row),
        "adminContacts": admin_contacts,
        "workAreas": work_areas,
        "shifts": shifts,
        "shiftPoolShifts": pool_shifts,
        "monthShifts": month_shifts,
        "taskAssignments": task_assignments,
        "messages": messages,
        "notifications": notifications,
        "workPreferences": dict(preferences) if preferences else None,
        "swapMarketplaceOpenRequests": [
            dict(row) for row in swaps if row["status"] == "open" and row["requested_employee_id"] is None
        ],
        "mySwapRequests": [
            dict(row)
            for row in swaps
            if str(row["requester_id"]) == user.id
            or str(row["requested_employee_id"]) == user.id
            or str(row["accepted_by_employee_id"]) == user.id
        ],
        "trainingAssignments": [
            {**dict(row), "course": row["course"] if isinstance(row["course"], dict) else None}
            for row in training
        ],
        "timeOffRequests": [dict(row) for row in time_off],
        "exceptionRequests": [dict(row) for row in exceptions],
        "overtimeRequests": [dict(row) for row in overtime],
    }
