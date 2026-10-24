from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_organization
from ..deps import RequestUser, get_current_user, get_db, get_db_optional, require_admin
from ..features import DEFAULT_FEATURE_FLAGS, FEATURE_GROUPS, FEATURE_META, normalize_feature_flags

router = APIRouter(prefix="/api/settings", tags=["settings"])

ORG_EDITABLE = {
    "name",
    "admin_portal_label",
    "login_primary_color",
    "login_accent_color",
    "login_logo_url",
    "login_background_image_url",
    "login_announcement",
    "login_heading",
    "login_subheading",
    "experience_builder_config",
    "enable_retail_floor_simulation",
    "enable_extended_leave_lock",
    "extended_leave_threshold_days",
    "enable_admin_realtime_notifications",
    "default_timeline_window_hours",
    "default_shift_break_minutes",
}

ALLOWED_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
}


@router.get("")
def get_settings(user: RequestUser = Depends(get_current_user), session: Session = Depends(get_db)) -> dict:
    row = get_organization(session)
    return dict(row)


@router.get("/branding")
def get_branding(session: Session = Depends(get_db_optional)) -> dict:
    return dict(get_organization(session))


@router.get("/features")
def get_features(session: Session = Depends(get_db_optional)) -> dict:
    org = get_organization(session)
    config = org.get("experience_builder_config") or {}
    stored = config.get("feature_flags") if isinstance(config, dict) else {}
    return {
        "flags": normalize_feature_flags(stored),
        "groups": FEATURE_GROUPS,
        "meta": FEATURE_META,
        "defaults": DEFAULT_FEATURE_FLAGS,
    }


@router.patch("")
def update_settings(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    org = get_organization(session)
    updates = {key: value for key, value in payload.items() if key in ORG_EDITABLE}
    if not updates:
        return dict(org)

    assignments = []
    params: dict = {"id": org["id"]}
    for key, value in updates.items():
        if key in {"experience_builder_config", "onboarding_custom_questions"}:
            assignments.append(f"{key} = cast(:{key} as jsonb)")
            # psycopg cannot adapt dict/list parameters; send JSON text for the cast.
            params[key] = value if isinstance(value, str) else json.dumps(value)
        else:
            assignments.append(f"{key} = :{key}")
            params[key] = value
    session.execute(
        text(f"update public.organizations set {', '.join(assignments)} where id = :id"),
        params,
    )
    return dict(get_organization(session))


@router.patch("/training-mode")
def update_training_mode(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    session.execute(
        text(
            """
            select public.update_training_mode_settings(
              :training_time_multiplier,
              :training_fake_employee_count,
              :training_no_show_rate_percent,
              :training_task_ack_rate_percent,
              :training_clock_in_early_min,
              :training_clock_in_late_min,
              :training_clock_out_early_min,
              :training_clock_out_late_min
            )
            """
        ),
        {
            "training_time_multiplier": int(payload.get("training_time_multiplier", 10)),
            "training_fake_employee_count": int(payload.get("training_fake_employee_count", 18)),
            "training_no_show_rate_percent": int(payload.get("training_no_show_rate_percent", 12)),
            "training_task_ack_rate_percent": int(payload.get("training_task_ack_rate_percent", 82)),
            "training_clock_in_early_min": int(payload.get("training_clock_in_early_min", -7)),
            "training_clock_in_late_min": int(payload.get("training_clock_in_late_min", 9)),
            "training_clock_out_early_min": int(payload.get("training_clock_out_early_min", -4)),
            "training_clock_out_late_min": int(payload.get("training_clock_out_late_min", 14)),
        },
    )
    return dict(get_organization(session))


@router.post("/assets")
async def upload_asset(
    kind: str = Form(...),
    file: UploadFile = File(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    if kind not in {"logo", "background"}:
        raise HTTPException(status_code=400, detail="Unsupported asset kind.")
    extension = ALLOWED_IMAGE_TYPES.get(file.content_type or "")
    if not extension:
        raise HTTPException(status_code=400, detail="Only image files are allowed.")
    content = await file.read()
    if len(content) > 8 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image must be 8MB or smaller.")
    target_dir = settings.upload_dir / "org" / kind
    target_dir.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{extension}"
    (target_dir / name).write_bytes(content)
    return {"url": f"/uploads/org/{kind}/{name}"}


# --- Announcements -----------------------------------------------------------


@router.get("/announcements")
def list_announcements(session: Session = Depends(get_db)) -> list[dict]:
    rows = session.execute(
        text("select * from public.site_announcements order by created_at desc limit 50")
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/announcements")
def create_announcement(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    org = get_organization(session)
    row = session.execute(
        text(
            """
            insert into public.site_announcements
              (organization_id, message, is_active, starts_at, ends_at, created_by)
            values (:org, :message, :is_active, :starts_at, :ends_at, :created_by)
            returning *
            """
        ),
        {
            "org": org["id"],
            "message": str(payload.get("message", "")).strip(),
            "is_active": bool(payload.get("is_active", True)),
            "starts_at": payload.get("starts_at"),
            "ends_at": payload.get("ends_at"),
            "created_by": user.id,
        },
    ).mappings().first()
    return dict(row)


@router.patch("/announcements/{announcement_id}")
def update_announcement(
    announcement_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    allowed = {"message", "is_active", "starts_at", "ends_at"}
    updates = {k: v for k, v in payload.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    assignments = ", ".join(f"{key} = :{key}" for key in updates)
    row = session.execute(
        text(
            f"update public.site_announcements set {assignments}, updated_by = :actor "
            "where id = :id returning *"
        ),
        {**updates, "actor": user.id, "id": announcement_id},
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Announcement not found.")
    return dict(row)


@router.delete("/announcements/{announcement_id}")
def delete_announcement(
    announcement_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    session.execute(
        text("delete from public.site_announcements where id = :id"),
        {"id": announcement_id},
    )
    return {"ok": True}


# --- Clock-in locations ------------------------------------------------------


def _location_payload(row) -> dict:
    data = dict(row)
    data["id"] = str(data["id"])
    data["organization_id"] = str(data["organization_id"])
    return data


@router.get("/clock-locations")
def list_clock_locations(session: Session = Depends(get_db)) -> list[dict]:
    rows = session.execute(
        text("select * from public.organization_clock_in_locations order by name")
    ).mappings().all()
    return [_location_payload(row) for row in rows]


@router.post("/clock-locations")
def create_clock_location(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    org = get_organization(session)
    name = str(payload.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Location name is required.")
    row = session.execute(
        text(
            """
            insert into public.organization_clock_in_locations
              (organization_id, name, latitude, longitude, radius_meters, is_active)
            values (:org, :name, :latitude, :longitude, :radius, :is_active)
            returning *
            """
        ),
        {
            "org": org["id"],
            "name": name,
            "latitude": float(payload.get("latitude", 0)),
            "longitude": float(payload.get("longitude", 0)),
            "radius": float(payload.get("radius_meters", 150)),
            "is_active": bool(payload.get("is_active", True)),
        },
    ).mappings().first()
    return _location_payload(row)


@router.patch("/clock-locations/{location_id}")
def update_clock_location(
    location_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    allowed = {"name", "latitude", "longitude", "radius_meters", "is_active"}
    updates = {k: v for k, v in payload.items() if k in allowed}
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    assignments = ", ".join(f"{key} = :{key}" for key in updates)
    row = session.execute(
        text(
            f"update public.organization_clock_in_locations set {assignments} "
            "where id = :id returning *"
        ),
        {**updates, "id": location_id},
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Location not found.")
    return _location_payload(row)


@router.delete("/clock-locations/{location_id}")
def delete_clock_location(
    location_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    session.execute(
        text("delete from public.organization_clock_in_locations where id = :id"),
        {"id": location_id},
    )
    return {"ok": True}
