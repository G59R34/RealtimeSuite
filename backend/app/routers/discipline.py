from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_organization
from ..deps import RequestUser, get_current_user, get_db, require_manager

router = APIRouter(prefix="/api/discipline", tags=["discipline"])


@router.post("")
def create_action(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    org = get_organization(session)
    row = session.execute(
        text(
            """
            insert into public.discipline_actions
              (organization_id, employee_id, issued_by, title, details, severity,
               punishment_type, punishment_value, status)
            values
              (:org, :employee, :issued_by, :title, :details,
               cast(:severity as public.discipline_severity),
               cast(:punishment_type as public.discipline_punishment_type),
               :punishment_value, cast(:status as public.discipline_status))
            returning *
            """
        ),
        {
            "org": org["id"],
            "employee": payload.get("employee_id"),
            "issued_by": user.id,
            "title": str(payload.get("title", "")),
            "details": str(payload.get("details", "")),
            "severity": str(payload.get("severity") or "warning"),
            "punishment_type": str(payload.get("punishment_type") or "none"),
            "punishment_value": float(payload.get("punishment_value", 0) or 0),
            "status": str(payload.get("status") or "issued"),
        },
    ).mappings().first()
    return dict(row)


@router.patch("/{action_id}")
def update_action(
    action_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    allowed = {
        "employee_id",
        "title",
        "details",
        "severity",
        "punishment_type",
        "punishment_value",
        "status",
        "review_notes",
    }
    updates = {key: value for key, value in payload.items() if key in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    assignments = []
    params = {"id": action_id, "actor": user.id}
    for key, value in updates.items():
        if key == "severity":
            assignments.append("severity = cast(:severity as public.discipline_severity)")
        elif key == "punishment_type":
            assignments.append("punishment_type = cast(:punishment_type as public.discipline_punishment_type)")
        elif key == "status":
            assignments.append("status = cast(:status as public.discipline_status)")
        else:
            assignments.append(f"{key} = :{key}")
        params[key] = value
    row = session.execute(
        text(
            f"update public.discipline_actions set {', '.join(assignments)}, updated_by = :actor "
            "where id = :id returning *"
        ),
        params,
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Discipline action not found.")
    return dict(row)


@router.post("/{action_id}/apply")
def apply_action(
    action_id: str,
    payload: dict = Body(default={}),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    session.execute(
        text("select public.apply_discipline_action(:id, :notes)"),
        {"id": action_id, "notes": str((payload or {}).get("review_notes", ""))},
    )
    return {"ok": True}


@router.post("/{action_id}/revoke")
def revoke_action(
    action_id: str,
    payload: dict = Body(default={}),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    session.execute(
        text("select public.revoke_discipline_action(:id, :notes)"),
        {"id": action_id, "notes": str((payload or {}).get("review_notes", ""))},
    )
    return {"ok": True}
