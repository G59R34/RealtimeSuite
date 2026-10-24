from __future__ import annotations

from datetime import date
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_organization
from ..deps import RequestUser, get_current_user, get_db, is_effective_admin, require_manager

router = APIRouter(prefix="/api/board-notes", tags=["board notes"])

MAX_NOTE_LENGTH = 1000

NOTE_COLUMNS = """
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
"""


def _serialize(row) -> dict:
    data = dict(row)
    for key in ("id", "created_by", "employee_id", "work_area_id"):
        if data.get(key) is not None:
            data[key] = str(data[key])
    return data


def _optional_uuid(payload: dict, key: str) -> str | None:
    value = payload.get(key)
    if value is None or value == "":
        return None
    try:
        return str(UUID(str(value)))
    except (ValueError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail=f"{key.replace('_', ' ').title()} is invalid.") from exc


def _validate_targets(
    session: Session, organization_id: str, employee_id: str | None, work_area_id: str | None
) -> None:
    if employee_id and work_area_id:
        raise HTTPException(status_code=400, detail="Attach a note to an employee or a work area, not both.")
    if employee_id:
        found = session.execute(
            text("select 1 from public.profiles where id = :id and organization_id = :org"),
            {"id": employee_id, "org": organization_id},
        ).first()
        if not found:
            raise HTTPException(status_code=400, detail="That employee is not on this board.")
    if work_area_id:
        found = session.execute(
            text("select 1 from public.work_areas where id = :id and organization_id = :org"),
            {"id": work_area_id, "org": organization_id},
        ).first()
        if not found:
            raise HTTPException(status_code=400, detail="That work area does not exist.")


@router.post("")
def create_board_note(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    body = str(payload.get("body", "")).strip()
    if not body:
        raise HTTPException(status_code=400, detail="Write the note before saving it.")
    if len(body) > MAX_NOTE_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"Board notes are limited to {MAX_NOTE_LENGTH} characters.",
        )
    note_date = str(payload.get("date") or date.today().isoformat())
    try:
        date.fromisoformat(note_date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Board note date is invalid.") from exc

    employee_id = _optional_uuid(payload, "employee_id")
    work_area_id = _optional_uuid(payload, "work_area_id")
    org = get_organization(session)
    _validate_targets(session, org["id"], employee_id, work_area_id)

    note_id = session.execute(
        text(
            """
            insert into public.board_notes
              (organization_id, note_date, body, is_public, created_by, employee_id, work_area_id)
            values (:org, :note_date, :body, :is_public, :actor, :employee_id, :work_area_id)
            returning id
            """
        ),
        {
            "org": org["id"],
            "note_date": note_date,
            "body": body,
            "is_public": bool(payload.get("is_public")),
            "actor": user.id,
            "employee_id": employee_id,
            "work_area_id": work_area_id,
        },
    ).scalar_one()
    row = session.execute(
        text(f"{NOTE_COLUMNS} where n.id = :id"), {"id": note_id}
    ).mappings().one()
    return _serialize(row)


@router.delete("/{note_id}")
def delete_board_note(
    note_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    row = session.execute(
        text("select id, created_by from public.board_notes where id = :id"),
        {"id": note_id},
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Board note not found.")
    if str(row["created_by"] or "") != user.id and not is_effective_admin(session, user):
        raise HTTPException(status_code=403, detail="Only the author can delete this note.")
    require_manager(session, user)
    session.execute(text("delete from public.board_notes where id = :id"), {"id": note_id})
    return {"ok": True}
