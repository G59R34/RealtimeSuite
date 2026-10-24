from __future__ import annotations

import smtplib
import uuid
from datetime import date, datetime, timedelta
from email.message import EmailMessage

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_organization, session_scope
from ..deps import RequestUser, get_current_user, get_db, is_effective_admin, require_admin
from ..security import hash_password

router = APIRouter(prefix="/api", tags=["employees"])

PROFILE_COLUMNS = """
  p.id, p.email, p.full_name, p.helpful_info, p.hourly_rate, p.role::text as role,
  p.retail_chaos_stationary, p.admin_training_only, p.is_training_manager,
  p.onboarding_started_at, p.onboarding_completed_at, p.onboarding_completed_version,
  p.onboarding_answers, p.created_at, p.updated_at
"""


class CreateEmployeePayload(BaseModel):
    email: str
    password: str
    full_name: str
    role: str = "employee"


def serialize_profile(row) -> dict:
    data = dict(row)
    data["id"] = str(data["id"])
    if data.get("hourly_rate") is not None:
        data["hourly_rate"] = float(data["hourly_rate"])
    return data


@router.get("/employees")
def list_employees(session: Session = Depends(get_db)) -> list[dict]:
    rows = session.execute(
        text(f"select {PROFILE_COLUMNS} from public.profiles p order by p.full_name, p.email")
    ).mappings().all()
    return [serialize_profile(row) for row in rows]


@router.post("/employees")
def create_employee(
    payload: CreateEmployeePayload,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    if "@" not in payload.email:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    if len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="Temporary password must be at least 8 characters.")
    if payload.role not in {"admin", "employee"}:
        raise HTTPException(status_code=400, detail="Invalid role.")
    org = get_organization(session)
    email = payload.email.lower().strip()
    if session.execute(
        text("select 1 from public.profiles where lower(email) = :email"), {"email": email}
    ).scalar():
        raise HTTPException(status_code=400, detail="An account with that email already exists.")
    user_id = session.execute(
        text("insert into auth.users (email, encrypted_password) values (:email, :password) returning id"),
        {"email": email, "password": hash_password(payload.password)},
    ).scalar()
    row = session.execute(
        text(
            """
            insert into public.profiles (id, email, full_name, role, organization_id)
            values (:id, :email, :full_name, cast(:role as public.app_role), :org)
            returning id, email, full_name, helpful_info, hourly_rate, role::text as role,
                      retail_chaos_stationary, admin_training_only, is_training_manager,
                      onboarding_started_at, onboarding_completed_at, onboarding_completed_version,
                      onboarding_answers, created_at, updated_at
            """
        ),
        {
            "id": user_id,
            "email": email,
            "full_name": payload.full_name.strip(),
            "role": payload.role,
            "org": org["id"],
        },
    ).mappings().first()
    return serialize_profile(row)


@router.patch("/employees/{employee_id}")
def update_employee(
    employee_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    allowed = {
        "full_name",
        "helpful_info",
        "hourly_rate",
        "role",
        "admin_training_only",
        "is_training_manager",
        "retail_chaos_stationary",
    }
    updates = {key: value for key, value in payload.items() if key in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    if "role" in updates and updates["role"] not in {"admin", "employee"}:
        raise HTTPException(status_code=400, detail="Invalid role.")
    assignments = []
    params = {"id": employee_id}
    for key, value in updates.items():
        if key == "role":
            assignments.append("role = cast(:role as public.app_role)")
        else:
            assignments.append(f"{key} = :{key}")
        params[key] = value
    row = session.execute(
        text(
            f"update public.profiles set {', '.join(assignments)} where id = :id "
            "returning id, email, full_name, helpful_info, hourly_rate, role::text as role, "
            "retail_chaos_stationary, admin_training_only, is_training_manager, "
            "onboarding_started_at, onboarding_completed_at, onboarding_completed_version, "
            "onboarding_answers, created_at, updated_at"
        ),
        params,
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Employee not found.")
    return serialize_profile(row)


@router.get("/me")
def my_profile(user: RequestUser = Depends(get_current_user), session: Session = Depends(get_db)) -> dict:
    row = session.execute(
        text(f"select {PROFILE_COLUMNS} from public.profiles p where p.id = :id"), {"id": user.id}
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return serialize_profile(row)


@router.get("/me/effective-admin")
def effective_admin(user: RequestUser = Depends(get_current_user), session: Session = Depends(get_db)) -> dict:
    return {"is_admin": is_effective_admin(session, user)}


@router.patch("/me/profile")
def update_my_profile(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    helpful_info = payload.get("helpful_info")
    if helpful_info is None:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    session.execute(
        text("update public.profiles set helpful_info = :info where id = :id"),
        {"info": str(helpful_info), "id": user.id},
    )
    return {"ok": True}


@router.post("/me/work-preferences")
def save_work_preferences(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    session.execute(
        text(
            """
            select public.upsert_my_work_preferences(
              :max_weekly_hours, :preferred_work_area_ids, :availability_notes
            )
            """
        ),
        {
            "max_weekly_hours": payload.get("max_weekly_hours"),
            "preferred_work_area_ids": payload.get("preferred_work_area_ids") or [],
            "availability_notes": str(payload.get("availability_notes", "")),
        },
    )
    return {"ok": True}


@router.post("/employees/{employee_id}/stationary")
def set_stationary(
    employee_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    session.execute(
        text("select public.set_employee_retail_chaos_stationary(:employee, :stationary)"),
        {"employee": employee_id, "stationary": bool(payload.get("stationary", False))},
    )
    return {"ok": True}


@router.get("/me/extended-leave")
def extended_leave(
    date_value: str | None = None,
    threshold_days: int = 5,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict | None:
    rows = session.execute(
        text(
            """
            select start_date, end_date
            from public.time_off_requests
            where employee_id = :id and status = 'approved'
            order by start_date
            """
        ),
        {"id": user.id},
    ).all()
    if not rows:
        return None
    intervals: list[list[date]] = []
    for start, end in rows:
        if end < start:
            continue
        intervals.append([start, end])
    if not intervals:
        return None
    intervals.sort(key=lambda item: item[0])
    merged: list[list[date]] = []
    for start, end in intervals:
        if not merged:
            merged.append([start, end])
            continue
        current = merged[-1]
        if start <= current[1] + timedelta(days=1):
            if end > current[1]:
                current[1] = end
        else:
            merged.append([start, end])
    target = date.fromisoformat(date_value) if date_value else date.today()
    covering = next((item for item in merged if item[0] <= target <= item[1]), None)
    if covering is None:
        return None
    total_days = (covering[1] - covering[0]).days + 1
    if total_days <= max(1, threshold_days):
        return None
    return {
        "startDate": covering[0].isoformat(),
        "endDate": covering[1].isoformat(),
        "totalDays": total_days,
    }


class OnboardingEmailPayload(BaseModel):
    to_email: str
    employee_name: str
    temporary_password: str
    subject_template: str | None = None
    body_template: str | None = None
    login_url: str | None = None


@router.post("/employees/onboarding-email")
def send_onboarding_email(
    payload: OnboardingEmailPayload,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    org = get_organization(session)
    defaults = {
        "organization_name": org["name"],
        "employee_name": payload.employee_name,
        "login_url": payload.login_url or "http://realtimesuite.local:8000",
        "organization_code": "",
        "temporary_password": payload.temporary_password,
    }
    subject = (payload.subject_template or "Welcome to {{organization_name}}, {{employee_name}}")
    body = (payload.body_template or "").strip()
    if not body:
        body = (
            "Hi {{employee_name}},\n\n"
            "Your RealtimeSuite account is ready.\n\n"
            "Login URL: {{login_url}}\n"
            "Temporary Password: {{temporary_password}}\n\n"
            "Please change your password after your first login.\n\n"
            "- {{organization_name}}"
        )
    for key, value in defaults.items():
        subject = subject.replace("{{" + key + "}}", str(value))
        body = body.replace("{{" + key + "}}", str(value))

    sent = False
    if settings.smtp_host:
        message = EmailMessage()
        message["Subject"] = subject
        message["From"] = settings.smtp_from
        message["To"] = payload.to_email
        message.set_content(body)
        try:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as smtp:
                if settings.smtp_use_tls:
                    smtp.starttls()
                if settings.smtp_username:
                    smtp.login(settings.smtp_username, settings.smtp_password)
                smtp.send_message(message)
            sent = True
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"SMTP delivery failed: {exc}") from exc

    return {"sent": sent, "subject": subject, "body": body}
