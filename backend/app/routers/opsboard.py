from __future__ import annotations

from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_organization, session_scope

router = APIRouter(prefix="/api/opsboard", tags=["opsboard"])


@router.get("")
def board(
    token: str | None = Query(default=None),
    horizon_hours: int = Query(default=8, ge=1, le=48),
) -> dict:
    if settings.opsboard_token and token != settings.opsboard_token:
        raise HTTPException(status_code=403, detail="Invalid OpsBoard token.")

    now = datetime.now().astimezone()
    start = now - timedelta(hours=1)
    end = now + timedelta(hours=horizon_hours)

    with session_scope() as session:
        org = get_organization(session)
        employees = [
            dict(row)
            for row in session.execute(
                text("select id, full_name, email, role::text as role from public.profiles order by full_name")
            ).mappings().all()
        ]
        areas = [
            dict(row)
            for row in session.execute(
                text("select id, name, color from public.work_areas where is_active order by name")
            ).mappings().all()
        ]
        shifts = [
            dict(row)
            for row in session.execute(
                text(
                    """
                    select id, employee_id, work_area_id, start_at, end_at,
                           status::text as status, notes, clocked_in_at, clocked_out_at,
                           is_shift_pool, is_unscheduled_overtime
                    from public.shifts
                    where end_at >= :start and start_at <= :end
                    order by start_at
                    """
                ),
                {"start": start, "end": end},
            ).mappings().all()
        ]
        tasks = [
            dict(row)
            for row in session.execute(
                text(
                    """
                    select id, title, description, work_area_id, start_at, end_at,
                           status::text as status, priority::text as priority, source_system
                    from public.tasks
                    where end_at >= :start and start_at <= :end
                    order by start_at
                    """
                ),
                {"start": start, "end": end},
            ).mappings().all()
        ]
        task_ids = [row["id"] for row in tasks]
        assignments = (
            [
                dict(row)
                for row in session.execute(
                    text(
                        """
                        select task_id, employee_id, acknowledged_at
                        from public.task_assignments where task_id = any(:ids)
                        """
                    ),
                    {"ids": task_ids},
                ).mappings().all()
            ]
            if task_ids
            else []
        )
        announcement = session.execute(
            text(
                """
                select message from public.site_announcements
                where is_active
                  and (starts_at is null or starts_at <= now())
                  and (ends_at is null or ends_at >= now())
                order by created_at desc limit 1
                """
            )
        ).scalar()
        overtime = [
            dict(row)
            for row in session.execute(
                text(
                    """
                    select id, status::text as status, overtime_type::text as overtime_type, start_at
                    from public.overtime_requests
                    where start_at between :start and :end
                    """
                ),
                {"start": start, "end": end},
            ).mappings().all()
        ]
        swaps = [
            dict(row)
            for row in session.execute(
                text(
                    """
                    select id, status, created_at from public.shift_swap_requests
                    order by created_at desc limit 40
                    """
                )
            ).mappings().all()
        ]
        notes = [
            dict(row)
            for row in session.execute(
                text(
                    """
                    select n.id, n.body, n.created_at, n.employee_id, n.work_area_id,
                           p.full_name as author_name,
                           e.full_name as employee_name,
                           w.name as work_area_name
                    from public.board_notes n
                    left join public.profiles p on p.id = n.created_by
                    left join public.profiles e on e.id = n.employee_id
                    left join public.work_areas w on w.id = n.work_area_id
                    where n.is_public and n.note_date = cast(:day as date)
                    order by n.created_at
                    """
                ),
                {"day": now.date()},
            ).mappings().all()
        ]

    return {
        "generated_at": now.isoformat(),
        "now": now.isoformat(),
        "horizon_hours": horizon_hours,
        "organization": {
            "name": org["name"],
            "admin_portal_label": org["admin_portal_label"],
            "login_logo_url": org["login_logo_url"],
            "experience_builder_config": org["experience_builder_config"],
        },
        "announcement": announcement,
        "employees": employees,
        "work_areas": areas,
        "shifts": shifts,
        "tasks": tasks,
        "task_assignments": assignments,
        "overtime_requests": overtime,
        "shift_swap_requests": swaps,
        "board_notes": notes,
    }
