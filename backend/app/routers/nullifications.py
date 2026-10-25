from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_organization
from ..deps import (
    RequestUser,
    get_current_user,
    get_db,
    is_effective_admin,
    require_active_employee,
    require_manager,
)

router = APIRouter(prefix="/api/nullifications", tags=["nullifications"])

MIN_WINDOW_MINUTES = 10
OPEN_STATUSES = ("pending", "approved")

NULLIFICATION_COLUMNS = """
select n.id, n.employee_id, n.shift_id, n.start_at, n.end_at, n.reason, n.status,
       n.requested_by, n.reviewed_by, n.reviewed_at, n.review_note,
       n.created_at, n.updated_at,
       e.full_name as employee_name,
       e.email as employee_email,
       r.full_name as reviewer_name
from public.time_nullification_requests n
left join public.profiles e on e.id = n.employee_id
left join public.profiles r on r.id = n.reviewed_by
"""

UUID_FIELDS = ("id", "employee_id", "shift_id", "requested_by", "reviewed_by")


def _serialize(row) -> dict:
    data = dict(row)
    for key in UUID_FIELDS:
        if data.get(key) is not None:
            data[key] = str(data[key])
    return data


def _is_manager(session: Session, user: RequestUser) -> bool:
    return is_effective_admin(session, user) or user.is_training_manager


def _parse_moment(value: object, label: str) -> datetime:
    text_value = str(value or "").strip()
    if not text_value:
        raise HTTPException(status_code=400, detail=f"{label} is required.")
    try:
        parsed = datetime.fromisoformat(text_value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{label} is not a valid date and time.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed


def _fetch(session: Session, request_id: str) -> dict:
    try:
        UUID(str(request_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="That no-task request does not exist.") from exc
    row = session.execute(
        text(f"{NULLIFICATION_COLUMNS} where n.id = :id"), {"id": request_id}
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="That no-task request does not exist.")
    return dict(row)


@router.get("")
def list_nullifications(
    selected_date: str | None = Query(default=None, alias="date"),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> list[dict]:
    day_value = selected_date or date.today().isoformat()
    try:
        day = date.fromisoformat(day_value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="That date is not valid.") from exc
    day_start = datetime.combine(day, time.min).astimezone()
    day_end = day_start + timedelta(days=1)
    org = get_organization(session)
    sql = (
        f"{NULLIFICATION_COLUMNS} "
        "where n.organization_id = :org and n.start_at < :end and n.end_at > :start"
    )
    params: dict = {"org": org["id"], "start": day_start, "end": day_end}
    if not _is_manager(session, user):
        sql += " and n.employee_id = :viewer"
        params["viewer"] = user.id
    sql += " order by n.start_at"
    rows = session.execute(text(sql), params).mappings().all()
    return [_serialize(row) for row in rows]


@router.post("")
def create_nullification(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    org = get_organization(session)
    employee_id = str(payload.get("employee_id") or user.id)
    manager = _is_manager(session, user)
    if employee_id != user.id:
        require_manager(session, user)
    else:
        require_active_employee(session, user)

    shift_id = payload.get("shift_id")
    shift = session.execute(
        text(
            "select id, employee_id, start_at, end_at from public.shifts "
            "where id = :id and organization_id = :org"
        ),
        {"id": shift_id, "org": org["id"]},
    ).mappings().first() if shift_id else None
    if shift is None:
        raise HTTPException(status_code=400, detail="Choose one of the employee's shifts for this window.")
    if str(shift["employee_id"] or "") != employee_id:
        raise HTTPException(status_code=400, detail="That shift is not assigned to this employee.")

    start_at = _parse_moment(payload.get("start_at"), "Start time")
    end_at = _parse_moment(payload.get("end_at"), "End time")
    if end_at <= start_at:
        raise HTTPException(status_code=400, detail="The end time must be after the start time.")
    if (end_at - start_at) < timedelta(minutes=MIN_WINDOW_MINUTES):
        raise HTTPException(
            status_code=400,
            detail=f"A no-task window must be at least {MIN_WINDOW_MINUTES} minutes long.",
        )
    if start_at < shift["start_at"] or end_at > shift["end_at"]:
        raise HTTPException(
            status_code=400,
            detail="A no-task window must sit inside the selected shift.",
        )

    overlap = session.execute(
        text(
            "select start_at, end_at, status from public.time_nullification_requests "
            "where employee_id = :employee and start_at < :end and end_at > :start "
            "and status in ('pending', 'approved') order by start_at limit 1"
        ),
        {"employee": employee_id, "start": start_at, "end": end_at},
    ).mappings().first()
    if overlap:
        raise HTTPException(
            status_code=400,
            detail="That time already has a no-task request. Cancel or change the existing one first.",
        )

    reason = str(payload.get("reason", "")).strip()
    if len(reason) > 500:
        raise HTTPException(status_code=400, detail="Keep the reason under 500 characters.")

    approved_now = bool(payload.get("approved")) and manager
    status = "approved" if approved_now else "pending"
    row = session.execute(
        text(
            """
            insert into public.time_nullification_requests
              (organization_id, employee_id, shift_id, start_at, end_at, reason, status,
               requested_by, reviewed_by, reviewed_at)
            values (:org, :employee, :shift, :start_at, :end_at, :reason, :status,
                    :actor, :reviewer, :reviewed_at)
            returning id
            """
        ),
        {
            "org": org["id"],
            "employee": employee_id,
            "shift": shift["id"],
            "start_at": start_at,
            "end_at": end_at,
            "reason": reason,
            "status": status,
            "actor": user.id,
            "reviewer": user.id if approved_now else None,
            "reviewed_at": datetime.now(timezone.utc) if approved_now else None,
        },
    ).scalar_one()
    return _serialize(_fetch(session, row))


@router.patch("/{request_id}")
def review_nullification(
    request_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    row = _fetch(session, request_id)
    wanted = str(payload.get("status", "")).strip().lower()
    if wanted not in {"approved", "denied", "cancelled"}:
        raise HTTPException(status_code=400, detail="Choose approved, denied or cancelled.")

    if wanted == "cancelled":
        if str(row["employee_id"]) != user.id:
            require_manager(session, user)
        if row["status"] != "pending":
            raise HTTPException(status_code=400, detail="Only a pending request can be cancelled.")
    else:
        require_manager(session, user)
        if row["status"] not in {"pending", "approved"}:
            raise HTTPException(status_code=400, detail="That request is already closed.")

    note = str(payload.get("review_note") or payload.get("reviewNote") or "").strip()
    if len(note) > 500:
        raise HTTPException(status_code=400, detail="Keep the review note under 500 characters.")
    session.execute(
        text(
            """
            update public.time_nullification_requests
            set status = :status, review_note = :note,
                reviewed_by = :reviewer, reviewed_at = now()
            where id = :id
            """
        ),
        {"status": wanted, "note": note, "reviewer": user.id, "id": row["id"]},
    )
    return _serialize(_fetch(session, row["id"]))


@router.delete("/{request_id}")
def delete_nullification(
    request_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    row = _fetch(session, request_id)
    if str(row["employee_id"]) != user.id:
        require_manager(session, user)
    elif row["status"] != "pending":
        raise HTTPException(
            status_code=400,
            detail="Approved windows must be removed by a manager. Cancel the request instead.",
        )
    session.execute(
        text("delete from public.time_nullification_requests where id = :id"),
        {"id": row["id"]},
    )
    return {"ok": True}
