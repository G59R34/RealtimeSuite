from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..deps import RequestUser, get_current_user, get_db, is_effective_admin, require_active_employee, require_admin

router = APIRouter(prefix="/api", tags=["comms"])


@router.get("/messages")
def list_messages(
    counterparty_id: str | None = Query(default=None),
    limit: int = Query(default=400, ge=1, le=1000),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> list[dict]:
    admin = is_effective_admin(session, user)
    params = {"id": user.id, "limit": limit}
    if counterparty_id:
        where = "((sender_id = :id and recipient_id = :other) or (sender_id = :other and recipient_id = :id))"
        params["other"] = counterparty_id
    elif admin:
        where = "true"
    else:
        where = "(sender_id = :id or recipient_id = :id)"
    rows = session.execute(
        text(
            f"""
            select id, organization_id, sender_id, recipient_id, subject, message,
                   read_at, created_at, thread_key
            from public.employee_messages
            where {where}
            order by created_at desc limit :limit
            """
        ),
        params,
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/messages")
def send_message(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    recipient_id = payload.get("recipient_id")
    message = str(payload.get("message", "")).strip()
    if not is_effective_admin(session, user):
        require_active_employee(session, user)
    if not recipient_id or not message:
        raise HTTPException(status_code=400, detail="Recipient and message are required.")
    message_id = session.execute(
        text("select public.send_employee_message(:recipient, :subject, :message)"),
        {
            "recipient": recipient_id,
            "subject": str(payload.get("subject", "")).strip(),
            "message": message,
        },
    ).scalar()
    return {"id": str(message_id) if message_id else None}


@router.post("/messages/{message_id}/read")
def mark_message_read(
    message_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    session.execute(
        text(
            """
            update public.employee_messages
            set read_at = coalesce(read_at, now())
            where id = :id and recipient_id = :user
            """
        ),
        {"id": message_id, "user": user.id},
    )
    return {"ok": True}


@router.get("/messages/recipients")
def message_recipients(
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> list[dict]:
    rows = session.execute(
        text(
            """
            select id, full_name from public.profiles
            where role = 'admin' or is_training_manager
            order by full_name
            """
        )
    ).mappings().all()
    return [dict(row) for row in rows]


@router.get("/notifications")
def list_notifications(
    limit: int = Query(default=100, ge=1, le=500),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> list[dict]:
    rows = session.execute(
        text(
            """
            select * from public.app_notifications
            where recipient_id = :id order by created_at desc limit :limit
            """
        ),
        {"id": user.id, "limit": limit},
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/notifications/{notification_id}/read")
def mark_notification_read(
    notification_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    session.execute(
        text("select public.mark_my_notification_read(:id)"), {"id": notification_id}
    )
    return {"ok": True}


@router.get("/notifications/unread-count")
def unread_count(
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    count = session.execute(
        text(
            "select count(*) from public.app_notifications where recipient_id = :id and read_at is null"
        ),
        {"id": user.id},
    ).scalar()
    return {"count": int(count or 0)}
