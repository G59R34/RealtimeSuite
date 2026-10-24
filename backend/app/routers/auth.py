from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import session_scope
from ..deps import RequestUser, get_current_user, get_db
from ..security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

PROFILE_COLUMNS = """
  id, email, full_name, helpful_info, hourly_rate, role::text as role,
  retail_chaos_stationary, admin_training_only, is_training_manager,
  onboarding_started_at, onboarding_completed_at, onboarding_completed_version,
  onboarding_answers, created_at, updated_at
"""


class LoginPayload(BaseModel):
    email: str
    password: str


class ChangePasswordPayload(BaseModel):
    current_password: str
    new_password: str


def serialize_profile(row) -> dict:
    data = dict(row)
    data["id"] = str(data["id"])
    rate = data.get("hourly_rate")
    data["hourly_rate"] = float(rate) if rate is not None else None
    return data


@router.post("/login")
def login(payload: LoginPayload) -> dict:
    email = payload.email.lower().strip()
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    with session_scope() as session:
        row = session.execute(
            text(
                """
                select u.id, u.encrypted_password, p.email, p.role::text as role,
                       p.full_name, p.organization_id
                from auth.users u
                join public.profiles p on p.id = u.id
                where lower(u.email) = :email
                """
            ),
            {"email": email},
        ).mappings().first()
    if row is None or not verify_password(payload.password, row["encrypted_password"] or ""):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password.",
        )
    if row["organization_id"] is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account is not attached to an organization.",
        )
    token, expires_in = create_access_token(
        str(row["id"]), row["role"], row["email"]
    )
    with session_scope(str(row["id"]), "authenticated") as session:
        profile = session.execute(
            text(f"select {PROFILE_COLUMNS} from public.profiles where id = :id"),
            {"id": row["id"]},
        ).mappings().first()
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": expires_in,
        "user": serialize_profile(profile),
    }


@router.get("/me")
def me(user: RequestUser = Depends(get_current_user), session: Session = Depends(get_db)) -> dict:
    row = session.execute(
        text(f"select {PROFILE_COLUMNS} from public.profiles where id = :id"),
        {"id": user.id},
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return serialize_profile(row)


@router.post("/logout")
def logout() -> dict:
    return {"ok": True}


@router.post("/change-password")
def change_password(
    payload: ChangePasswordPayload,
    user: RequestUser = Depends(get_current_user),
) -> dict:
    if len(payload.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    with session_scope() as session:
        row = session.execute(
            text("select encrypted_password from auth.users where id = :id"),
            {"id": user.id},
        ).mappings().first()
        if row is None:
            raise HTTPException(status_code=404, detail="Account not found.")
        if not verify_password(payload.current_password, row["encrypted_password"] or ""):
            raise HTTPException(status_code=400, detail="Current password is incorrect.")
        session.execute(
            text("update auth.users set encrypted_password = :password where id = :id"),
            {"password": hash_password(payload.new_password), "id": user.id},
        )
    return {"ok": True}
