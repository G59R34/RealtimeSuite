from __future__ import annotations

from fastapi import APIRouter, Body, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..deps import RequestUser, get_current_user, get_db, require_manager

router = APIRouter(prefix="/api/training", tags=["training"])


@router.get("/courses")
def list_courses(session: Session = Depends(get_db)) -> list[dict]:
    rows = session.execute(
        text("select * from public.training_courses order by created_at desc")
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/courses")
def create_course(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    course_id = session.execute(
        text(
            """
            select public.create_training_course(
              :title, :description, :content, :minutes, :active
            )
            """
        ),
        {
            "title": str(payload.get("title", "")),
            "description": str(payload.get("description", "")),
            "content": str(payload.get("content", "")),
            "minutes": int(payload.get("estimated_minutes", 30)),
            "active": bool(payload.get("is_active", True)),
        },
    ).scalar()
    return {"id": str(course_id) if course_id else None}


@router.get("/assignments")
def list_assignments(
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> list[dict]:
    require_manager(session, user)
    rows = session.execute(
        text(
            """
            select ta.*, row_to_json(tc.*) as course,
                   json_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email) as employee
            from public.training_assignments ta
            left join public.training_courses tc on tc.id = ta.course_id
            left join public.profiles p on p.id = ta.employee_id
            order by ta.assigned_at desc
            """
        )
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/assignments")
def assign_course(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    assignment_id = session.execute(
        text("select public.assign_training_course(:course, :employee, :due_at)"),
        {
            "course": payload.get("course_id"),
            "employee": payload.get("employee_id"),
            "due_at": payload.get("due_at"),
        },
    ).scalar()
    return {"id": str(assignment_id) if assignment_id else None}


@router.post("/assignments/{assignment_id}/complete")
def complete_assignment(
    assignment_id: str,
    payload: dict = Body(default={}),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    session.execute(
        text("select public.complete_training_assignment(:id, :notes)"),
        {"id": assignment_id, "notes": str((payload or {}).get("completion_notes", ""))},
    )
    return {"ok": True}
