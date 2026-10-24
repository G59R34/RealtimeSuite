from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_organization
from ..deps import RequestUser, get_current_user, get_db, require_manager
from ..leave import leave_window, wipe_employee_window

router = APIRouter(prefix="/api/discipline", tags=["discipline"])


def _leave_columns(session: Session, action_id: str, start, end) -> None:
    session.execute(
        text(
            "update public.discipline_actions "
            "set leave_starts_on = :start, leave_ends_on = :end where id = :id"
        ),
        {"id": action_id, "start": start, "end": end},
    )


@router.post("")
def create_action(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    org = get_organization(session)
    employee_id = str(payload.get("employee_id") or "")
    if not employee_id:
        raise HTTPException(status_code=400, detail="An employee is required.")
    punishment_type = str(payload.get("punishment_type") or "none")
    punishment_value = float(payload.get("punishment_value", 0) or 0)
    status = str(payload.get("status") or "issued")
    # A suspension or probation takes the employee off the schedule as soon as it is
    # issued, so the window is recorded and their shifts are cleared right away.
    window = None if status == "revoked" else leave_window(punishment_type, punishment_value)
    row = session.execute(
        text(
            """
            insert into public.discipline_actions
              (organization_id, employee_id, issued_by, title, details, severity,
               punishment_type, punishment_value, status,
               leave_starts_on, leave_ends_on)
            values
              (:org, :employee, :issued_by, :title, :details,
               cast(:severity as public.discipline_severity),
               cast(:punishment_type as public.discipline_punishment_type),
               :punishment_value, cast(:status as public.discipline_status),
               :leave_start, :leave_end)
            returning *
            """
        ),
        {
            "org": org["id"],
            "employee": employee_id,
            "issued_by": user.id,
            "title": str(payload.get("title", "")),
            "details": str(payload.get("details", "")),
            "severity": str(payload.get("severity") or "warning"),
            "punishment_type": punishment_type,
            "punishment_value": punishment_value,
            "status": status,
            "leave_start": window[0] if window else None,
            "leave_end": window[1] if window else None,
        },
    ).mappings().first()
    record = dict(row)
    if window:
        record["cleared"] = wipe_employee_window(session, employee_id, *window)
    return record


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
    record = dict(row)
    if record["status"] == "revoked":
        # Revoking lifts the leave marker; shifts that were cleared are not restored.
        if record.get("leave_starts_on") or record.get("leave_ends_on"):
            _leave_columns(session, action_id, None, None)
            record["leave_starts_on"] = None
            record["leave_ends_on"] = None
        return record
    touches_leave = any(
        key in updates for key in ("employee_id", "punishment_type", "punishment_value", "status")
    )
    window = leave_window(str(record["punishment_type"]), record["punishment_value"])
    if window and (touches_leave or not record.get("leave_starts_on")):
        _leave_columns(session, action_id, *window)
        record["leave_starts_on"], record["leave_ends_on"] = window
        record["cleared"] = wipe_employee_window(
            session, str(record["employee_id"]), *window
        )
    elif touches_leave and not window:
        _leave_columns(session, action_id, None, None)
        record["leave_starts_on"] = None
        record["leave_ends_on"] = None
    return record


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
    action = session.execute(
        text(
            "select employee_id, punishment_type::text as punishment_type, punishment_value, "
            "leave_starts_on, leave_ends_on from public.discipline_actions where id = :id"
        ),
        {"id": action_id},
    ).mappings().first()
    cleared: dict[str, int] = {}
    if action is not None:
        window = leave_window(str(action["punishment_type"]), action["punishment_value"])
        if window:
            start = action["leave_starts_on"] or window[0]
            end = action["leave_ends_on"] or window[1]
            if start != action["leave_starts_on"] or end != action["leave_ends_on"]:
                _leave_columns(session, action_id, start, end)
            cleared = wipe_employee_window(session, str(action["employee_id"]), start, end)
    return {"ok": True, "cleared": cleared}


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
    _leave_columns(session, action_id, None, None)
    return {"ok": True}
