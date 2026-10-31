from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import corp_commands, corp_sync
from ..deps import RequestUser, get_current_user, get_db, require_manager

router = APIRouter(prefix="/api/integrations/corp", tags=["integrations"])


@router.get("/status")
def corp_status(
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    return {
        **corp_sync.status(),
        "commands": corp_commands.status(),
        "recentCommands": corp_commands.recent(20),
    }


@router.post("/sync")
def corp_sync_now(
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    result = corp_sync.sync_now("manual")
    if not result.get("ok"):
        raise HTTPException(status_code=502, detail=result.get("error") or "Snapshot delivery failed.")
    return result


@router.post("/commands/apply")
def corp_commands_apply(
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    """Apply any corporate-owned changes this site is waiting on, right now."""
    require_manager(session, user)
    result = corp_commands.run_once("manual")
    if not result.get("ok"):
        raise HTTPException(status_code=502, detail=result.get("error") or "Command delivery failed.")
    return result
