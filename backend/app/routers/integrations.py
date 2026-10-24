from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..config import settings
from ..deps import RequestUser, get_current_user, get_db, require_manager
from ..github_sync import normalize_repo, sync_pull_requests

router = APIRouter(prefix="/api/integrations/github", tags=["integrations"])


@router.get("/status")
def github_status(
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    return {
        "configured": settings.github_enabled,
        "repos": [repo for repo in (normalize_repo(item) for item in settings.github_repos) if repo],
        "pollMinutes": settings.github_poll_minutes,
        "taskMinutes": settings.github_task_minutes,
    }


@router.post("/sync")
def github_sync_now(
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    return sync_pull_requests()
