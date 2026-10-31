from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import rtlink_bridge
from ..deps import RequestUser, get_current_user, get_db, require_manager

router = APIRouter(prefix="/api/integrations/rtlink", tags=["integrations"])


@router.get("/status")
def rtlink_status(
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    return {**rtlink_bridge.status(), "recentActions": rtlink_bridge.recent(20)}


@router.post("/sync")
def rtlink_sync_now(
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    result = rtlink_bridge.sync_now("manual")
    if not result.get("ok"):
        raise HTTPException(status_code=502, detail=result.get("error") or "Snapshot delivery failed.")
    return result


@router.post("/pull")
def rtlink_pull_now(
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    """Apply employee actions queued in RTLink right now."""
    require_manager(session, user)
    result = rtlink_bridge.run_once("manual")
    if not result.get("ok"):
        raise HTTPException(status_code=502, detail=result.get("error") or "Action delivery failed.")
    return result
