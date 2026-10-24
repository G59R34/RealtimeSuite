from __future__ import annotations

from typing import Iterator

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import session_scope
from .security import decode_token

bearer = HTTPBearer(auto_error=False)


class RequestUser(BaseModel):
    id: str
    email: str
    role: str
    organization_id: str
    full_name: str
    is_training_manager: bool = False


def _load_user(token: str) -> RequestUser:
    payload = decode_token(token)
    if not payload or "sub" not in payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session.")
    with session_scope() as session:
        row = session.execute(
            text(
                """
                select id, email, full_name, role::text as role, organization_id, is_training_manager
                from public.profiles where id = :id
                """
            ),
            {"id": payload["sub"]},
        ).mappings().first()
    if row is None or row["organization_id"] is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account not found.")
    return RequestUser(
        id=str(row["id"]),
        email=row["email"],
        full_name=row["full_name"],
        role=row["role"],
        organization_id=str(row["organization_id"]),
        is_training_manager=bool(row["is_training_manager"]),
    )


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    x_suite_token: str | None = Header(default=None, alias="X-Suite-Token"),
) -> RequestUser:
    token = credentials.credentials if credentials else x_suite_token
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    return _load_user(token)


def get_db(user: RequestUser = Depends(get_current_user)) -> Iterator[Session]:
    with session_scope(user.id, "authenticated") as session:
        yield session


def get_db_optional(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    x_suite_token: str | None = Header(default=None, alias="X-Suite-Token"),
) -> Iterator[Session]:
    """Session without a user (used by the kiosk and public endpoints)."""
    token = credentials.credentials if credentials else x_suite_token
    if token:
        user = _load_user(token)
        with session_scope(user.id, "authenticated") as session:
            yield session
        return
    with session_scope() as session:
        yield session


def is_effective_admin(session: Session, user: RequestUser) -> bool:
    if user.role == "admin":
        return True
    return bool(session.execute(text("select public.is_admin(:uid)"), {"uid": user.id}).scalar())


def require_admin(session: Session, user: RequestUser) -> None:
    if not is_effective_admin(session, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required.")


def require_active_employee(session: Session, user: RequestUser) -> None:
    """Block employee-initiated actions during an active leave or restriction."""
    if is_effective_admin(session, user):
        return
    action = session.execute(
        text(
            """
            select title, leave_ends_on from public.discipline_actions
            where employee_id = :id and status in ('issued', 'applied')
              and punishment_type in ('unpaid_suspension', 'probation')
              and (leave_starts_on is null or leave_ends_on is null
                   or current_date between leave_starts_on and leave_ends_on)
            order by created_at desc limit 1
            """
        ),
        {"id": user.id},
    ).mappings().first()
    if action:
        detail = "Your suspension or probation is active"
        if action.get("title"):
            detail += f" ({action['title']})"
        if action.get("leave_ends_on"):
            detail += f" through {action['leave_ends_on']}"
        raise HTTPException(status_code=403, detail=f"{detail}. You cannot clock in, message management, or submit requests until management releases you.")
    leave_code = session.execute(
        text(
            """
            select exception_code::text from public.exception_requests
            where employee_id = :id and status = 'approved'
              and exception_code in ('VAUT', 'DO')
              and current_date between start_date and end_date
            order by created_at desc limit 1
            """
        ),
        {"id": user.id},
    ).scalar()
    if leave_code:
        leave = session.execute(
            text(
                "select title, end_date from public.exception_requests "
                "where employee_id = :id and status = 'approved' "
                "and exception_code = :code and current_date between start_date and end_date "
                "order by created_at desc limit 1"
            ),
            {"id": user.id, "code": leave_code},
        ).mappings().first()
        detail = f"Your approved {leave_code} leave is active"
        if leave and leave.get("title"):
            detail += f" ({leave['title']})"
        if leave and leave.get("end_date"):
            detail += f" through {leave['end_date']}"
        raise HTTPException(status_code=403, detail=f"{detail}. You cannot clock in, message management, or submit requests until the leave period ends.")


def require_manager(session: Session, user: RequestUser) -> None:
    if is_effective_admin(session, user) or user.is_training_manager:
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Manager access required.")


def require_self_or_admin(session: Session, user: RequestUser, target_user_id: str) -> None:
    if str(target_user_id) == user.id:
        return
    require_admin(session, user)
