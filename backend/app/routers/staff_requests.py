from __future__ import annotations

from datetime import date, datetime, time

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_organization
from ..deps import RequestUser, get_current_user, get_db, require_admin, require_manager
from ..leave import LEAVE_EXCEPTION_CODES, wipe_employee_window

router = APIRouter(prefix="/api", tags=["requests"])


def _day_start(value: str) -> datetime:
    return datetime.combine(date.fromisoformat(value), time.min).astimezone()


def _delete_shifts_in_window(session: Session, employee_id: str, start_date: str, end_date: str) -> None:
    wipe_employee_window(
        session, employee_id, date.fromisoformat(start_date), date.fromisoformat(end_date)
    )


# --- Time off ----------------------------------------------------------------


@router.post("/time-off")
def create_time_off(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    employee_id = payload.get("employee_id") or user.id
    if employee_id != user.id:
        require_admin(session, user)
    start_date = str(payload.get("start_date") or payload.get("startDate") or "")
    end_date = str(payload.get("end_date") or payload.get("endDate") or "")
    if not start_date or not end_date:
        raise HTTPException(status_code=400, detail="Start and end dates are required.")
    if end_date < start_date:
        raise HTTPException(status_code=400, detail="End date must be on or after the start date.")
    org = get_organization(session)
    row = session.execute(
        text(
            """
            insert into public.time_off_requests
              (organization_id, employee_id, start_date, end_date, request_type, reason, status)
            values (:org, :employee, :start_date, :end_date,
                    cast(:request_type as public.time_off_request_type), :reason, 'pending')
            returning *
            """
        ),
        {
            "org": org["id"],
            "employee": employee_id,
            "start_date": start_date,
            "end_date": end_date,
            "request_type": str(payload.get("request_type") or payload.get("requestType") or "other"),
            "reason": str(payload.get("reason", "")),
        },
    ).mappings().first()
    return dict(row)


@router.patch("/time-off/{request_id}")
def update_time_off(
    request_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    allowed = {
        "employee_id",
        "start_date",
        "end_date",
        "request_type",
        "reason",
        "status",
        "review_notes",
    }
    updates = {key: value for key, value in payload.items() if key in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    assignments = []
    params = {"id": request_id}
    for key, value in updates.items():
        if key == "request_type":
            assignments.append("request_type = cast(:request_type as public.time_off_request_type)")
        elif key == "status":
            assignments.append("status = cast(:status as public.time_off_request_status)")
        else:
            assignments.append(f"{key} = :{key}")
        params[key] = value
    status = updates.get("status")
    if status and status != "pending":
        assignments.extend(["reviewed_by = :reviewer", "reviewed_at = now()"])
        params["reviewer"] = user.id
    elif status == "pending":
        assignments.extend(["reviewed_by = null", "reviewed_at = null"])
    row = session.execute(
        text(
            f"update public.time_off_requests set {', '.join(assignments)} "
            "where id = :id returning employee_id, start_date, end_date, status::text as status"
        ),
        params,
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Request not found.")
    if row["status"] == "approved":
        _delete_shifts_in_window(
            session, str(row["employee_id"]), row["start_date"].isoformat(), row["end_date"].isoformat()
        )
    return dict(row)


@router.delete("/time-off/{request_id}")
def delete_time_off(
    request_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    session.execute(text("delete from public.time_off_requests where id = :id"), {"id": request_id})
    return {"ok": True}


@router.post("/time-off/coverage")
def coverage(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> list[dict]:
    rows = session.execute(
        text(
            """
            select * from public.preview_time_off_coverage_impact(
              :employee, cast(:start_date as date), cast(:end_date as date)
            )
            """
        ),
        {
            "employee": payload.get("employee_id"),
            "start_date": payload.get("start_date") or payload.get("startDate"),
            "end_date": payload.get("end_date") or payload.get("endDate"),
        },
    ).mappings().all()
    return [dict(row) for row in rows]


# --- Overtime ----------------------------------------------------------------


@router.post("/overtime")
def create_overtime(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    employee_id = payload.get("employee_id") or user.id
    if employee_id != user.id:
        require_admin(session, user)
    org = get_organization(session)
    row = session.execute(
        text(
            """
            insert into public.overtime_requests
              (organization_id, employee_id, start_at, end_at, note, overtime_type, status)
            values (:org, :employee, :start_at, :end_at, :note,
                    cast(:type as public.overtime_request_type), 'pending')
            returning *
            """
        ),
        {
            "org": org["id"],
            "employee": employee_id,
            "start_at": payload.get("start_at"),
            "end_at": payload.get("end_at"),
            "note": str(payload.get("note", "")),
            "type": str(payload.get("overtime_type") or "voluntary"),
        },
    ).mappings().first()
    return dict(row)


@router.post("/overtime/assign")
def assign_overtime(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    request_id = session.execute(
        text(
            """
            select public.create_or_assign_overtime_request(
              :employee, :start_at, :end_at, :note,
              cast(:type as public.overtime_request_type)
            )
            """
        ),
        {
            "employee": payload.get("employee_id"),
            "start_at": payload.get("start_at"),
            "end_at": payload.get("end_at"),
            "note": str(payload.get("note", "")),
            "type": str(payload.get("overtime_type") or "mandatory"),
        },
    ).scalar()
    return {"id": str(request_id) if request_id else None}


@router.patch("/overtime/{request_id}")
def review_overtime(
    request_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    session.execute(
        text(
            """
            select public.review_overtime_request(
              :id, cast(:status as public.overtime_request_status), :notes
            )
            """
        ),
        {
            "id": request_id,
            "status": str(payload.get("status") or "approved"),
            "notes": str(payload.get("review_notes", "")),
        },
    )
    return {"ok": True}


# --- Shift swaps -------------------------------------------------------------


@router.post("/swaps")
def create_swap(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    request_id = session.execute(
        text(
            """
            select public.create_shift_swap_request(:shift, :target, :note)
            """
        ),
        {
            "shift": payload.get("shift_id"),
            "target": payload.get("requested_employee_id"),
            "note": str(payload.get("request_note", "")),
        },
    ).scalar()
    return {"id": str(request_id) if request_id else None}


@router.post("/swaps/{request_id}/accept")
def accept_swap(
    request_id: str,
    payload: dict = Body(default={}),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    result = session.execute(
        text("select public.accept_shift_swap_request(:id, :note)"),
        {"id": request_id, "note": str((payload or {}).get("acceptance_note", ""))},
    ).scalar()
    return {"id": str(result) if result else None}


@router.patch("/swaps/{request_id}")
def review_swap(
    request_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    result = session.execute(
        text("select public.review_shift_swap_request(:id, :approve, :note)"),
        {
            "id": request_id,
            "approve": bool(payload.get("approve", False)),
            "note": str(payload.get("review_note", "")),
        },
    ).scalar()
    return {"id": str(result) if result else None}


# --- Exceptions --------------------------------------------------------------


@router.post("/exceptions")
def create_exception(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    employee_id = payload.get("employee_id") or user.id
    if employee_id != user.id:
        require_admin(session, user)
    org = get_organization(session)
    row = session.execute(
        text(
            """
            insert into public.exception_requests
              (organization_id, employee_id, submitted_by, exception_type, exception_code,
               title, details, start_date, end_date, related_shift_id, related_task_id, status)
            values
              (:org, :employee, :submitted_by,
               cast(:exception_type as public.exception_request_type),
               cast(:exception_code as public.exception_code),
               :title, :details, cast(:start_date as date), cast(:end_date as date),
               :shift_id, :task_id, 'submitted')
            returning *
            """
        ),
        {
            "org": org["id"],
            "employee": employee_id,
            "submitted_by": user.id,
            "exception_type": str(payload.get("exception_type") or "other"),
            "exception_code": str(payload.get("exception_code") or "DO"),
            "title": str(payload.get("title", "")),
            "details": str(payload.get("details", "")),
            "start_date": payload.get("start_date"),
            "end_date": payload.get("end_date"),
            "shift_id": payload.get("related_shift_id"),
            "task_id": payload.get("related_task_id"),
        },
    ).mappings().first()
    return dict(row)


@router.patch("/exceptions/{request_id}")
def update_exception(
    request_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    allowed = {
        "employee_id",
        "exception_type",
        "exception_code",
        "title",
        "details",
        "start_date",
        "end_date",
        "related_shift_id",
        "related_task_id",
        "status",
        "review_notes",
    }
    updates = {key: value for key, value in payload.items() if key in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    assignments = []
    params = {"id": request_id}
    for key, value in updates.items():
        if key == "exception_type":
            assignments.append("exception_type = cast(:exception_type as public.exception_request_type)")
        elif key == "exception_code":
            assignments.append("exception_code = cast(:exception_code as public.exception_code)")
        elif key == "status":
            assignments.append("status = cast(:status as public.exception_request_status)")
        else:
            assignments.append(f"{key} = :{key}")
        params[key] = value
    if "status" in updates:
        assignments.extend(["reviewed_by = :reviewer", "reviewed_at = now()"])
        params["reviewer"] = user.id
    row = session.execute(
        text(
            f"update public.exception_requests set {', '.join(assignments)} where id = :id "
            "returning employee_id, start_date, end_date, exception_code::text as exception_code, "
            "status::text as status"
        ),
        params,
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Exception request not found.")
    if row["status"] == "approved" and row["exception_code"] in LEAVE_EXCEPTION_CODES:
        # Approved VAUT and DO days take the employee off the board: clear their shifts
        # and task assignments for the covered dates.
        _delete_shifts_in_window(
            session, str(row["employee_id"]), row["start_date"].isoformat(), row["end_date"].isoformat()
        )
    return dict(row)


@router.delete("/exceptions/{request_id}")
def delete_exception(
    request_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    session.execute(
        text("delete from public.exception_requests where id = :id"), {"id": request_id}
    )
    return {"ok": True}
