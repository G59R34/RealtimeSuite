from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings
from .db import get_organization, session_scope

logger = logging.getLogger("realtimesuite.github")

SOURCE_SYSTEM = "github"

_REPO_PATTERN = re.compile(r"([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)")


def normalize_repo(value: str) -> str | None:
    """Accept owner/repo, a GitHub URL, or an SSH remote and return ``owner/repo``."""
    match = _REPO_PATTERN.search(value.strip())
    if not match:
        return None
    owner, repo = match.group(1), match.group(2)
    if repo.endswith(".git"):
        repo = repo[: -len(".git")]
    return f"{owner}/{repo}"


def _api(path: str, params: dict[str, str] | None = None) -> object:
    url = f"{settings.github_api_url}{path}"
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {settings.github_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "RealtimeSuite",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read() or b"[]")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"GitHub returned {exc.code} for {path}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach GitHub: {exc.reason}") from exc


def _pull_list(repo: str, state: str, per_page: int) -> list[dict]:
    payload = _api(
        f"/repos/{repo}/pulls",
        {"state": state, "per_page": str(per_page), "sort": "updated", "direction": "desc"},
    )
    return payload if isinstance(payload, list) else []


def _task_slot() -> datetime:
    """Start the task at the current quarter hour so it lands on today's board."""
    now = datetime.now().astimezone()
    return now.replace(minute=(now.minute // 15) * 15, second=0, microsecond=0)


def _create_task(session: Session, organization_id: str, repo: str, pull: dict, start: datetime) -> None:
    number = pull.get("number")
    title = str(pull.get("title") or "").strip() or f"Pull request #{number}"
    html_url = str(pull.get("html_url") or "")
    author = (pull.get("user") or {}).get("login") or ""
    body = f"{repo} · opened by @{author}" if author else repo
    if html_url:
        body = f"{body}\n{html_url}"
    session.execute(
        text(
            """
            insert into public.tasks
              (organization_id, title, description, status, priority, source_system,
               external_id, external_url, start_at, end_at)
            values
              (:org, :title, :description, 'pending', 'normal', :source,
               :external_id, :external_url, :start_at, :end_at)
            on conflict do nothing
            """
        ),
        {
            "org": organization_id,
            "title": f"PR #{number}: {title}",
            "description": body,
            "source": SOURCE_SYSTEM,
            "external_id": f"{repo}#{number}",
            "external_url": html_url or None,
            "start_at": start,
            "end_at": start + timedelta(minutes=settings.github_task_minutes),
        },
    )


def sync_pull_requests() -> dict:
    """Mirror open GitHub pull requests into unassigned timeline tasks."""
    if not settings.github_enabled:
        return {"enabled": False, "repos": 0, "created": 0, "completed": 0, "errors": []}

    created = 0
    completed = 0
    errors: list[str] = []
    repos = [repo for repo in (normalize_repo(item) for item in settings.github_repos) if repo]
    if not repos:
        return {"enabled": False, "repos": 0, "created": 0, "completed": 0, "errors": []}

    with session_scope() as session:
        organization_id = str(get_organization(session)["id"])
        for repo in repos:
            try:
                open_pulls = _pull_list(repo, "open", 100)
            except RuntimeError as exc:
                logger.warning("GitHub open pull request sync failed for %s: %s", repo, exc)
                errors.append(str(exc))
                continue

            start = _task_slot()
            for pull in open_pulls:
                if pull.get("draft"):
                    continue
                external_id = f"{repo}#{pull.get('number')}"
                exists = session.execute(
                    text(
                        "select 1 from public.tasks "
                        "where organization_id = :org and source_system = :source "
                        "and external_id = :external_id"
                    ),
                    {"org": organization_id, "source": SOURCE_SYSTEM, "external_id": external_id},
                ).scalar()
                if exists:
                    continue
                _create_task(session, organization_id, repo, pull, start)
                created += 1
            session.commit()

            try:
                closed_pulls = _pull_list(repo, "closed", 30)
            except RuntimeError as exc:
                logger.warning("GitHub closed pull request sync failed for %s: %s", repo, exc)
                errors.append(str(exc))
                continue

            for pull in closed_pulls:
                external_id = f"{repo}#{pull.get('number')}"
                status = "done" if pull.get("merged_at") else "cancelled"
                result = session.execute(
                    text(
                        """
                        update public.tasks
                        set status = cast(:status as public.task_status), updated_at = now()
                        where organization_id = :org
                          and source_system = :source
                          and external_id = :external_id
                          and status in ('pending', 'in_progress')
                        """
                    ),
                    {
                        "status": status,
                        "org": organization_id,
                        "source": SOURCE_SYSTEM,
                        "external_id": external_id,
                    },
                )
                completed += max(result.rowcount or 0, 0)
            session.commit()

    if created or completed:
        logger.info("GitHub sync created %s task(s) and closed %s", created, completed)
    return {
        "enabled": True,
        "repos": len(repos),
        "created": created,
        "completed": completed,
        "errors": errors,
    }
