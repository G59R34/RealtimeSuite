from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_organization
from ..deps import RequestUser, get_current_user, get_db, require_admin, require_manager

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.post("/assign")
def assign_task(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    task_id = session.execute(
        text(
            """
            select public.assign_task_to_employee(
              :employee_id, :title, :description, :start_at, :end_at,
              :work_area_id, :shift_id, cast(:priority as public.task_priority)
            )
            """
        ),
        {
            "employee_id": payload.get("employee_id"),
            "title": str(payload.get("title", "")),
            "description": str(payload.get("description", "")),
            "start_at": payload.get("start_at"),
            "end_at": payload.get("end_at"),
            "work_area_id": payload.get("work_area_id"),
            "shift_id": payload.get("shift_id"),
            "priority": str(payload.get("priority", "normal")),
        },
    ).scalar()
    return {"id": str(task_id) if task_id else None}


@router.patch("/{task_id}")
def update_task(
    task_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    allowed = {
        "title",
        "description",
        "start_at",
        "end_at",
        "work_area_id",
        "shift_id",
        "priority",
        "status",
    }
    updates = {key: value for key, value in payload.items() if key in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    assignments = []
    params = {"id": task_id, "actor": user.id}
    for key, value in updates.items():
        if key == "priority":
            assignments.append("priority = cast(:priority as public.task_priority)")
        elif key == "status":
            assignments.append("status = cast(:status as public.task_status)")
        else:
            assignments.append(f"{key} = :{key}")
        params[key] = value
    result = session.execute(
        text(
            f"update public.tasks set {', '.join(assignments)}, updated_by = :actor "
            "where id = :id"
        ),
        params,
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Task not found.")
    return {"ok": True}


@router.post("/{task_id}/reassign")
def reassign_task(
    task_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    employee_id = payload.get("employee_id")
    if not employee_id:
        raise HTTPException(status_code=400, detail="Employee is required.")
    result = session.execute(
        text(
            """
            update public.task_assignments
            set employee_id = :employee, assigned_by = :actor, assigned_at = now(),
                acknowledged_at = null, acknowledged_by = null, acknowledgment_note = ''
            where task_id = :task
            """
        ),
        {"employee": employee_id, "actor": user.id, "task": task_id},
    )
    if result.rowcount == 0:
        # The task had no assignment yet (for example a task created unassigned).
        org = get_organization(session)
        session.execute(
            text(
                """
                insert into public.task_assignments
                  (organization_id, task_id, employee_id, assigned_by, assigned_at)
                values (:org, :task, :employee, :actor, now())
                """
            ),
            {"org": org["id"], "task": task_id, "employee": employee_id, "actor": user.id},
        )
    return {"ok": True}


@router.delete("/{task_id}/assignment")
def unassign_task(
    task_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    session.execute(
        text("delete from public.task_assignments where task_id = :id"),
        {"id": task_id},
    )
    return {"ok": True}


@router.delete("/{task_id}")
def delete_task(
    task_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    session.execute(text("delete from public.task_assignments where task_id = :id"), {"id": task_id})
    session.execute(text("delete from public.tasks where id = :id"), {"id": task_id})
    return {"ok": True}


@router.post("/{task_id}/assignments/{assignment_id}/acknowledge")
def acknowledge(
    task_id: str,
    assignment_id: str,
    payload: dict = Body(default={}),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    session.execute(
        text("select public.acknowledge_task_assignment(:id, :note)"),
        {"id": assignment_id, "note": str((payload or {}).get("note", ""))},
    )
    return {"ok": True}


@router.post("/ack/{assignment_id}")
def acknowledge_by_assignment(
    assignment_id: str,
    payload: dict = Body(default={}),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    session.execute(
        text("select public.acknowledge_task_assignment(:id, :note)"),
        {"id": assignment_id, "note": str((payload or {}).get("note", ""))},
    )
    return {"ok": True}


@router.post("/note")
def create_note(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    employee_id = payload.get("employee_id")
    note = str(payload.get("note", "")).strip()
    if not employee_id or not note:
        raise HTTPException(status_code=400, detail="Employee and note are required.")

    now = datetime.now(tz=timezone.utc)
    window_end = now + timedelta(minutes=30)
    shifts = session.execute(
        text(
            """
            select id, start_at, end_at from public.shifts
            where employee_id = :employee and start_at < :window_end and end_at > :now
            order by start_at limit 8
            """
        ),
        {"employee": employee_id, "window_end": window_end, "now": now},
    ).mappings().all()
    if not shifts:
        raise HTTPException(
            status_code=400,
            detail="Cannot create NOTE task outside shift hours or more than 30 minutes before shift start.",
        )
    active = next(
        (row for row in shifts if row["start_at"] <= now < row["end_at"]),
        shifts[0],
    )
    task_start = max(now, active["start_at"])
    task_end = min(task_start + timedelta(minutes=30), active["end_at"])
    if task_end <= task_start:
        raise HTTPException(status_code=400, detail="Cannot create NOTE task for this shift window.")

    org = get_organization(session)
    task_id = session.execute(
        text(
            """
            insert into public.tasks
              (organization_id, title, description, status, priority, source_system,
               start_at, end_at, work_area_id, shift_id, created_by, updated_by)
            values
              (:org, 'NOTE', :note, 'pending', 'normal', 'note_message',
               :start_at, :end_at, null, null, :actor, :actor)
            returning id
            """
        ),
        {
            "org": org["id"],
            "note": note,
            "start_at": task_start,
            "end_at": task_end,
            "actor": user.id,
        },
    ).scalar()
    session.execute(
        text(
            """
            insert into public.task_assignments (organization_id, task_id, employee_id, assigned_by)
            values (:org, :task, :employee, :actor)
            """
        ),
        {"org": org["id"], "task": task_id, "employee": employee_id, "actor": user.id},
    )
    return {"id": str(task_id)}
