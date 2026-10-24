from __future__ import annotations

import os

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import session_scope
from ..deps import RequestUser, get_current_user, get_db
from ..realtime import event_stream

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
def health() -> dict:
    db_ok = True
    try:
        with session_scope() as session:
            session.execute(text("select 1")).scalar()
    except Exception:  # noqa: BLE001
        db_ok = False
    return {
        "ok": db_ok,
        "service": "RealtimeSuite",
        "version": "1.0.0",
        "pid": os.getpid(),
    }


@router.get("/time")
def server_time(_: Session = Depends(get_db)) -> dict:
    with session_scope() as session:
        value = session.execute(text("select public.server_now()")).scalar()
    return {"now": value}


@router.get("/realtime/stream")
def realtime_stream(_: RequestUser = Depends(get_current_user)) -> StreamingResponse:
    # The SSE client authenticates with a bearer header on the initial request.
    # The stream itself only emits row-change notifications for the single LAN org.
    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
