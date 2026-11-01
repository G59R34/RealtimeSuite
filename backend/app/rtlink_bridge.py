"""Two-way bridge between RealtimeSuite and RTLink (Supabase).

RTLink is the employee companion app. The LAN installation stays the source of
truth:

* **Down** — this module builds a snapshot of the site's employees, work areas,
  shifts, tasks, announcements, board notes, requests and training assignments
  and upserts it into the ``rtlink_*`` mirror tables with the service_role key.
  Rows that no longer exist locally are pruned only after every upsert succeeds.
* **Up** — employees queue actions (time off, overtime, exceptions, swaps, task
  acknowledgement, shift-pool claims and clock in/out) in ``rtlink_requests``.
  This module polls its own site's pending rows and applies each one through the
  same SQL functions the LAN app uses, then writes the outcome back.

Sync runs on three triggers for the push (startup, interval, and shortly after a
local change detected by LISTENing on ``suite_realtime``) and on a short poll for
the pull. Failures never reach the caller: the LAN app keeps working and the
last error is reported through ``GET /api/integrations/rtlink/status``.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import quote
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable
from uuid import UUID

import psycopg
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings
from .db import psycopg_dsn, session_scope
from .deps import RequestUser, require_active_employee
from .features import normalize_feature_flags

logger = logging.getLogger("realtimesuite.rtlink")

MAX_ATTEMPTS = 3

# Collection name -> (Supabase table, SQL). Column names must match the schema in
# rtlink/supabase/migrations/0001_rtlink.sql.
COLLECTIONS: dict[str, tuple[str, str]] = {
    "employees": (
        "rtlink_employees",
        """
        select p.id, p.email, p.full_name, p.role::text as role, p.hourly_rate,
               coalesce(p.is_training_manager, false) as is_training_manager,
               p.onboarding_completed_at,
               p.created_at as created_at_local, p.updated_at as updated_at_local
        from public.profiles p
        where p.role = 'employee'
        """,
    ),
    "work_areas": (
        "rtlink_work_areas",
        """
        select id, name, color, coalesce(is_active, true) as is_active
        from public.work_areas
        """,
    ),
    "shifts": (
        "rtlink_shifts",
        """
        select s.id, s.employee_id, s.work_area_id, wa.name as work_area_name,
               s.start_at, s.end_at, s.status::text as status,
               coalesce(s.break_minutes, 0) as break_minutes, s.worked_minutes,
               s.clocked_in_at, s.clocked_out_at,
               coalesce(s.is_unscheduled_overtime, false) as is_unscheduled_overtime,
               coalesce(s.is_shift_pool, false) as is_shift_pool,
               s.shift_pool_posted_at, s.notes
        from public.shifts s
        left join public.work_areas wa on wa.id = s.work_area_id
        where s.start_at >= now() - interval '45 days'
          and s.start_at < now() + interval '60 days'
          and (s.employee_id is not null or s.is_shift_pool)
        """,
    ),
    "tasks": (
        "rtlink_tasks",
        """
        select t.id, t.title, t.description, t.status::text as status,
               t.priority::text as priority, t.start_at, t.end_at,
               t.work_area_id, wa.name as work_area_name,
               ta.employee_id as assignee_id, ta.id as assignment_id,
               ta.acknowledged_at, ta.acknowledgment_note, t.source_system
        from public.tasks t
        join public.task_assignments ta on ta.task_id = t.id
        left join public.work_areas wa on wa.id = t.work_area_id
        where t.start_at >= now() - interval '45 days'
          and t.start_at < now() + interval '60 days'
        """,
    ),
    "announcements": (
        "rtlink_announcements",
        """
        select id, message, is_active, starts_at, ends_at
        from public.site_announcements
        """,
    ),
    "board_notes": (
        "rtlink_board_notes",
        """
        select id, note_date, body, created_at as created_at_local
        from public.board_notes
        where is_public
          and note_date >= current_date - 45
        """,
    ),
    "time_off_requests": (
        "rtlink_time_off_requests",
        """
        select r.id, r.employee_id, r.start_date, r.end_date,
               r.request_type::text as request_type, r.reason,
               r.status::text as status, r.review_notes,
               r.created_at as created_at_local, r.reviewed_at
        from public.time_off_requests r
        where r.created_at >= now() - interval '180 days'
        """,
    ),
    "overtime_requests": (
        "rtlink_overtime_requests",
        """
        select r.id, r.employee_id, r.start_at, r.end_at,
               r.overtime_type::text as overtime_type, r.note,
               r.status::text as status, r.review_notes,
               r.created_at as created_at_local, r.reviewed_at
        from public.overtime_requests r
        where r.created_at >= now() - interval '180 days'
        """,
    ),
    "exception_requests": (
        "rtlink_exception_requests",
        """
        select r.id, r.employee_id, r.exception_code::text as exception_code,
               r.exception_type::text as exception_type, r.title, r.details,
               r.start_date, r.end_date, r.status::text as status, r.review_notes,
               r.created_at as created_at_local, r.reviewed_at
        from public.exception_requests r
        where r.created_at >= now() - interval '180 days'
        """,
    ),
    "swap_requests": (
        "rtlink_swap_requests",
        """
        select r.id, r.requester_id, r.shift_id, r.requested_employee_id,
               r.status, r.request_note, r.review_note,
               s.start_at as shift_start_at, r.created_at as created_at_local
        from public.shift_swap_requests r
        left join public.shifts s on s.id = r.shift_id
        where r.created_at >= now() - interval '180 days'
        """,
    ),
    "training_assignments": (
        "rtlink_training_assignments",
        """
        select a.id, a.employee_id, c.title as course_title,
               c.description as course_description, a.status, a.due_at, a.completed_at
        from public.training_assignments a
        left join public.training_courses c on c.id = a.course_id
        """,
    ),
}

SETTINGS_SQL = """
select o.name,
       o.experience_builder_config->'feature_flags' as feature_flags,
       exists(
         select 1 from public.organization_clock_in_locations l
         where l.organization_id = o.id and l.is_active
       ) as clock_in_required
from public.organizations o
order by o.created_at
limit 1
"""

_state_lock = threading.Lock()
_run_lock = threading.Lock()
_pull_lock = threading.Lock()
_stop = threading.Event()
_dirty = threading.Event()

_state: dict[str, Any] = {
    "last_attempt_at": None,
    "last_success_at": None,
    "last_error": None,
    "last_trigger": None,
    "last_counts": {},
    "last_duration_ms": None,
    "runs": 0,
    "failures": 0,
}

# Actions whose acknowledgement was rejected (for example a site that has not
# applied migration 0004) are retried on a timer instead of on every 2s poll.
_ack_retry_at: dict[str, float] = {}
ACK_RETRY_SECONDS = 20.0
_ack_hint_logged = False

_action_state: dict[str, Any] = {
    "last_poll_at": None,
    "last_success_at": None,
    "last_error": None,
    "last_trigger": None,
    "polls": 0,
    "applied": 0,
    "failed": 0,
    "last_result": None,
}


class RtlinkError(RuntimeError):
    """A snapshot or queue call to Supabase failed."""


class ActionError(RuntimeError):
    """An employee action was rejected; the message is shown in RTLink."""


class TerminalAction(ActionError):
    """An action that cannot succeed by retrying (for example a removed account)."""


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def _request(
    method: str,
    path: str,
    payload: Any = None,
    prefer: str | None = None,
) -> Any:
    url = f"{settings.rtlink_supabase_url}{path}"
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("apikey", settings.rtlink_supabase_key)
    request.add_header("Authorization", f"Bearer {settings.rtlink_supabase_key}")
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "application/json")
    if prefer:
        request.add_header("Prefer", prefer)
    timeout = max(5, settings.rtlink_timeout_seconds)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise RtlinkError(f"{method} {path} failed ({exc.code}): {detail}") from exc
    except urllib.error.URLError as exc:
        raise RtlinkError(f"{method} {path} failed: {exc.reason}") from exc
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _jsonable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, UUID):
        return str(value)
    return value


def _with_retries(action: Callable[[], None], label: str) -> None:
    attempts = 3
    delay = 0.5
    for attempt in range(1, attempts + 1):
        try:
            action()
            return
        except RtlinkError:
            if attempt == attempts:
                raise
            logger.warning("RTLink %s failed (attempt %s/%s), retrying", label, attempt, attempts)
            time.sleep(delay)
            delay *= 2


def _drop_orphan_employees(rows: list[dict[str, Any]]) -> None:
    """Remove mirror employee rows whose id changed but whose email did not.

    Supabase keeps ``(site_id, lower(email))`` unique, so a re-created profile
    (new id, same email) cannot be merged by an id upsert: every push fails with
    23505 and the whole site stops updating. The mirror row belongs to this site,
    so drop the stale one and let the snapshot insert the current row.
    """
    if not rows:
        return
    existing = _request(
        "GET",
        f"/rest/v1/rtlink_employees?select=id,email&site_id=eq.{settings.rtlink_site_id}",
    )
    if not isinstance(existing, list):
        return
    wanted = {str(row["id"]) for row in rows}
    emails = {str(row.get("email") or "").strip().lower() for row in rows}
    orphans = [
        str(row["id"])
        for row in existing
        if str(row.get("id")) not in wanted
        and str(row.get("email") or "").strip().lower() in emails
    ]
    if not orphans:
        return
    _with_retries(
        lambda: _request(
            "DELETE",
            f"/rest/v1/rtlink_employees?id=in.({','.join(orphans)})",
            prefer="return=minimal",
        ),
        "drop stale employee rows",
    )
    logger.info("RTLink removed %s stale employee row(s) before delivery", len(orphans))


def _upsert(table: str, rows: list[dict[str, Any]], conflict: str = "id") -> None:
    if not rows:
        return
    _with_retries(
        lambda: _request(
            "POST",
            f"/rest/v1/{table}?on_conflict={conflict}",
            rows,
            prefer="resolution=merge-duplicates,return=minimal",
        ),
        f"upsert {table}",
    )


# ---------------------------------------------------------------------------
# Supabase Auth: the sign-in employees use for RTLink
# ---------------------------------------------------------------------------

def _auth_error_means_exists(exc: RtlinkError) -> bool:
    message = str(exc).lower()
    return "already" in message or "registered" in message or "exists" in message


def _find_auth_user(email: str) -> dict[str, Any] | None:
    wanted = email.strip().lower()
    for page in range(1, 11):
        listing = _request("GET", f"/auth/v1/admin/users?page={page}&per_page=200")
        users = listing.get("users") if isinstance(listing, dict) else listing
        if not isinstance(users, list) or not users:
            return None
        for user in users:
            if isinstance(user, dict) and str(user.get("email") or "").lower() == wanted:
                return user
        if len(users) < 200:
            return None
    return None


def ensure_auth_user(email: str, password: str, full_name: str | None = None) -> dict[str, Any]:
    """Create or update the Supabase account RTLink signs in with.

    RealtimeSuite keeps its accounts in Postgres; Supabase Auth is a separate
    user table. An account created in the Server Manager can sign in to the LAN
    app but not to RTLink until the same email and password exist in Supabase,
    so mirror the credential whenever the plaintext is known (account creation
    and password reset).
    """
    if not settings.rtlink_enabled:
        raise RtlinkError(
            "RTLink sync is not configured. Set RTLINK_SUPABASE_URL, "
            "RTLINK_SUPABASE_SERVICE_ROLE_KEY and RTLINK_SITE_ID."
        )
    clean_email = (email or "").strip().lower()
    if "@" not in clean_email:
        raise RtlinkError("Enter a valid email address.")
    if len(password or "") < 8:
        raise RtlinkError("Password must be at least 8 characters.")

    payload: dict[str, Any] = {
        "email": clean_email,
        "password": password,
        "email_confirm": True,
    }
    if full_name:
        payload["user_metadata"] = {"full_name": full_name}
    try:
        created = _request("POST", "/auth/v1/admin/users", payload)
    except RtlinkError as exc:
        if not _auth_error_means_exists(exc):
            raise
        existing = _find_auth_user(clean_email)
        if existing is None:
            raise
        update: dict[str, Any] = {"password": password, "email_confirm": True}
        if full_name:
            update["user_metadata"] = {"full_name": full_name}
        changed = _request("PUT", f"/auth/v1/admin/users/{existing.get('id')}", update)
        user_id = (changed or existing).get("id") if isinstance(changed or existing, dict) else None
        return {"ok": True, "email": clean_email, "status": "updated", "user_id": user_id}

    user_id = created.get("id") if isinstance(created, dict) else None
    return {"ok": True, "email": clean_email, "status": "created", "user_id": user_id}


# ---------------------------------------------------------------------------
# Push: build and deliver the snapshot
# ---------------------------------------------------------------------------


def build_settings(stamp: str) -> dict[str, Any] | None:
    with session_scope() as session:
        row = session.execute(text(SETTINGS_SQL)).mappings().first()
    if row is None:
        return None
    name = row["name"] or settings.organization_name
    return {
        "site_id": settings.rtlink_site_id,
        "organization_name": name,
        "portal_label": name,
        "feature_flags": normalize_feature_flags(row["feature_flags"]),
        "clock_in_required": bool(row["clock_in_required"]),
        "synced_at": stamp,
    }


def build_snapshot() -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]], str]:
    started = datetime.now(timezone.utc)
    stamp = started.isoformat()
    site_id = settings.rtlink_site_id

    collections: dict[str, list[dict[str, Any]]] = {}
    counts: dict[str, int] = {}
    with session_scope() as session:
        organization = session.execute(
            text("select name from public.organizations order by created_at limit 1")
        ).scalar()
        for name, (_table, sql) in COLLECTIONS.items():
            rows = session.execute(text(sql)).mappings().all()
            prepared: list[dict[str, Any]] = []
            for row in rows:
                item = {key: _jsonable(value) for key, value in row.items()}
                item["site_id"] = site_id
                item["synced_at"] = stamp
                prepared.append(item)
            collections[name] = prepared
            counts[name] = len(prepared)

    site_row = {
        "id": site_id,
        "name": settings.rtlink_site_name or organization or settings.organization_name,
        "organization_name": organization or settings.organization_name,
        "org_code": settings.rtlink_org_code or None,
        "timezone": datetime.now().astimezone().strftime("%Z"),
        "app_version": settings.app_version,
        "last_sync_at": stamp,
        "record_counts": counts,
        "updated_at": stamp,
    }
    return site_row, collections, stamp


def sync_now(trigger: str = "manual") -> dict[str, Any]:
    """Build and deliver one snapshot. Returns a result dict, never raises."""
    if not settings.rtlink_enabled:
        return {
            "ok": False,
            "error": (
                "RTLink sync is not configured. Set RTLINK_SUPABASE_URL, "
                "RTLINK_SUPABASE_SERVICE_ROLE_KEY and RTLINK_SITE_ID."
            ),
        }

    started_at = datetime.now(timezone.utc)
    started = time.monotonic()
    with _state_lock:
        _state["last_attempt_at"] = started_at.isoformat()
        _state["last_trigger"] = trigger
        _state["runs"] += 1

    try:
        site_row, collections, stamp = build_snapshot()
        _upsert("rtlink_sites", [site_row])
        site_settings = build_settings(stamp)
        if site_settings is not None:
            _upsert("rtlink_settings", [site_settings], conflict="site_id")
        # Runs before the employees upsert so a re-created profile cannot wedge
        # delivery on the unique (site_id, email) index.
        _drop_orphan_employees(collections["employees"])
        for name, (table, _sql) in COLLECTIONS.items():
            _upsert(table, collections[name])

        # Prune only after every upsert succeeded: a partial failure must not
        # delete rows the site still has locally.
        for name, (table, _sql) in COLLECTIONS.items():
            _with_retries(
                lambda table=table: _request(
                    "DELETE",
                    f"/rest/v1/{table}?site_id=eq.{settings.rtlink_site_id}"
                    # A raw "+00:00" offset becomes a space in a query string and
                    # Postgres then rejects the timestamp.
                    f"&synced_at=lt.{quote(stamp, safe='')}",
                    prefer="return=minimal",
                ),
                f"prune {table}",
            )

        counts = {name: len(rows) for name, rows in collections.items()}
        _request(
            "POST",
            "/rest/v1/rtlink_sync_events",
            [
                {
                    "site_id": settings.rtlink_site_id,
                    "kind": trigger,
                    "status": "ok",
                    "record_counts": counts,
                    "message": None,
                    "received_at": stamp,
                }
            ],
            prefer="return=minimal",
        )
        # Keep the event log small; this is telemetry, not history.
        try:
            cutoff = (started_at - timedelta(days=30)).isoformat()
            _request(
                "DELETE",
                f"/rest/v1/rtlink_sync_events?site_id=eq.{settings.rtlink_site_id}"
                f"&received_at=lt.{quote(cutoff, safe='')}",
                prefer="return=minimal",
            )
        except RtlinkError:
            logger.debug("RTLink sync event cleanup skipped", exc_info=True)

        duration = int((time.monotonic() - started) * 1000)
        with _state_lock:
            _state["last_success_at"] = stamp
            _state["last_error"] = None
            _state["last_counts"] = counts
            _state["last_duration_ms"] = duration
        logger.info(
            "RTLink sync (%s) delivered %s records in %sms",
            trigger,
            sum(counts.values()),
            duration,
        )
        return {"ok": True, "counts": counts, "at": stamp, "durationMs": duration}

    except Exception as exc:  # noqa: BLE001 - surfaced through status/response
        message = str(exc) or exc.__class__.__name__
        with _state_lock:
            _state["last_error"] = message
            _state["failures"] += 1
        logger.warning("RTLink sync (%s) failed: %s", trigger, message)
        try:
            _request(
                "POST",
                "/rest/v1/rtlink_sync_events",
                [
                    {
                        "site_id": settings.rtlink_site_id,
                        "kind": trigger,
                        "status": "failed",
                        "record_counts": {},
                        "message": message[:500],
                        "received_at": datetime.now(timezone.utc).isoformat(),
                    }
                ],
                prefer="return=minimal",
            )
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "error": message}


# ---------------------------------------------------------------------------
# Pull: apply employee actions
# ---------------------------------------------------------------------------


def fetch_pending(limit: int = 20) -> list[dict]:
    rows = _request(
        "GET",
        "/rest/v1/rtlink_requests"
        "?select=id,kind,employee_id,payload,attempts,requested_at"
        f"&site_id=eq.{settings.rtlink_site_id}"
        "&status=eq.pending"
        "&order=requested_at.asc"
        f"&limit={limit}",
    )
    return rows if isinstance(rows, list) else []


def _report(action_id: str, body: dict) -> None:
    # The action is already applied locally, so a lost acknowledgement only means
    # the next poll reports it again. Retry transport failures, but never a 4xx: a
    # rejected write (missing grant, trigger) cannot pass on a second attempt.
    path = f"/rest/v1/rtlink_requests?id=eq.{action_id}"
    try:
        _request("PATCH", path, body, prefer="return=minimal")
    except RtlinkError as exc:
        if "not linked to an employee" in str(exc):
            global _ack_hint_logged
            if not _ack_hint_logged:
                _ack_hint_logged = True
                logger.error(
                    "RTLink cannot acknowledge actions: apply "
                    "rtlink/supabase/migrations/0004_service_ack.sql once in Supabase"
                )
        if "failed (4" in str(exc):
            raise
        _with_retries(
            lambda: _request("PATCH", path, body, prefer="return=minimal"),
            f"ack {action_id}",
        )


def _log_row(session: Session, action_id: str) -> dict | None:
    row = session.execute(
        text("select status, attempts from public.rtlink_action_log where action_id = :id"),
        {"id": action_id},
    ).mappings().first()
    return dict(row) if row else None


def _write_log(
    session: Session,
    action: dict,
    status: str,
    attempts: int,
    error: str | None,
    result: str | None,
) -> None:
    session.execute(
        text(
            """
            insert into public.rtlink_action_log
              (action_id, kind, employee_id, payload, status, attempts, error, result,
               received_at, applied_at)
            values
              (:id, :kind, :employee, cast(:payload as jsonb), :status, :attempts,
               :error, :result, now(), case when :status = 'applied' then now() else null end)
            on conflict (action_id) do update
              set status = excluded.status,
                  attempts = excluded.attempts,
                  error = excluded.error,
                  result = excluded.result,
                  applied_at = excluded.applied_at
            """
        ),
        {
            "id": action["id"],
            "kind": action.get("kind") or "unknown",
            "employee": action.get("employee_id"),
            "payload": json.dumps(action.get("payload") or {}),
            "status": status,
            "attempts": attempts,
            "error": error,
            "result": result,
        },
    )


def recent(limit: int = 20) -> list[dict]:
    """Locally applied RTLink actions, newest first."""
    with session_scope() as session:
        rows = session.execute(
            text(
                "select action_id, kind, employee_id, payload, status, attempts, error, "
                "result, received_at, applied_at from public.rtlink_action_log "
                "order by received_at desc limit :limit"
            ),
            {"limit": max(1, min(200, limit))},
        ).mappings().all()
    return [
        {
            **dict(row),
            "action_id": str(row["action_id"]),
            "employee_id": str(row["employee_id"]) if row["employee_id"] else None,
            "received_at": row["received_at"].isoformat() if row["received_at"] else None,
            "applied_at": row["applied_at"].isoformat() if row["applied_at"] else None,
        }
        for row in rows
    ]


# --- payload helpers ---------------------------------------------------------


def _text(payload: dict, key: str, label: str, required: bool = True) -> str:
    value = payload.get(key)
    text_value = "" if value is None else str(value).strip()
    if required and not text_value:
        raise ActionError(f"{label} is required.")
    return text_value


def _date(payload: dict, key: str, label: str) -> date:
    raw = _text(payload, key, label)
    try:
        return date.fromisoformat(raw[:10])
    except ValueError as exc:
        raise ActionError(f"{label} must be a date like 2026-04-30.") from exc


def _datetime(payload: dict, key: str, label: str) -> datetime:
    raw = _text(payload, key, label)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ActionError(f"{label} must be an ISO date and time.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed


def _choice(session: Session, type_name: str, value: Any, fallback: str) -> str:
    allowed = list(
        session.execute(text(f"select unnest(enum_range(null::{type_name}))::text")).scalars()
    )
    candidate = str(value or "").strip().lower()
    if candidate in allowed:
        return candidate
    if fallback in allowed:
        return fallback
    if allowed:
        return allowed[0]
    raise ActionError("This site is missing a required database type.")


def _profile(session: Session, employee_id: Any) -> dict:
    if not employee_id:
        raise ActionError("The request did not identify an employee.")
    row = session.execute(
        text(
            """
            select id, email, full_name, role::text as role, organization_id,
                   is_training_manager
            from public.profiles
            where id = :id
            """
        ),
        {"id": employee_id},
    ).mappings().first()
    if row is None or row["organization_id"] is None:
        # The mirror may still hold a queued action for an account that was
        # re-created; retrying it can never succeed.
        raise TerminalAction("That employee account was re-created on the site. Sign out and back in, then try again.")
    return dict(row)


def _require_active(session: Session, profile: dict) -> None:
    user = RequestUser(
        id=str(profile["id"]),
        email=profile["email"] or "",
        full_name=profile["full_name"] or "",
        role=profile["role"],
        organization_id=str(profile["organization_id"]),
        is_training_manager=bool(profile["is_training_manager"]),
    )
    try:
        require_active_employee(session, user)
    except HTTPException as exc:
        raise ActionError(str(exc.detail)) from exc


def _require_own_shift(session: Session, employee_id: Any, shift_id: Any, label: str) -> dict:
    if not shift_id:
        raise ActionError("Choose a shift first.")
    row = session.execute(
        text(
            """
            select id, employee_id, organization_id, start_at, end_at, status::text as status,
                   coalesce(is_unscheduled_overtime, false) as is_unscheduled_overtime
            from public.shifts
            where id = :id
            """
        ),
        {"id": shift_id},
    ).mappings().first()
    if row is None:
        raise ActionError(f"{label} no longer exists on this site.")
    if str(row["employee_id"] or "") != str(employee_id):
        raise ActionError(f"You can only use your own shift for {label.lower()}.")
    return dict(row)


def _clock_location(
    session: Session,
    organization_id: Any,
    shift_id: Any,
    payload: dict,
    unscheduled: bool,
) -> dict[str, Any]:
    """Verify the clock-in is on site when this organization enforces it."""
    configured = session.execute(
        text(
            "select count(*) from public.organization_clock_in_locations "
            "where organization_id = :org and is_active"
        ),
        {"org": organization_id},
    ).scalar()
    latitude = payload.get("latitude")
    longitude = payload.get("longitude")
    if not configured:
        return {"latitude": None, "longitude": None, "accuracy": None}
    if latitude is None or longitude is None:
        raise ActionError(
            "Turn on location access and try again — this site verifies your location at clock-in."
        )
    verification = session.execute(
        text(
            "select * from public.verify_clock_in_location("
            ":org, :shift, :lat, :lon, :accuracy, :unscheduled)"
        ),
        {
            "org": organization_id,
            "shift": shift_id,
            "lat": latitude,
            "lon": longitude,
            "accuracy": payload.get("accuracyMeters"),
            "unscheduled": unscheduled,
        },
    ).mappings().first()
    if verification is not None and not verification["is_allowed"]:
        raise ActionError(verification["message"] or "Clock-in denied by location policy.")
    return {
        "latitude": latitude,
        "longitude": longitude,
        "accuracy": payload.get("accuracyMeters"),
    }


# --- appliers ----------------------------------------------------------------


def _apply_time_off(session: Session, profile: dict, payload: dict) -> str:
    start = _date(payload, "start_date", "Start date")
    end = _date(payload, "end_date", "End date")
    if end < start:
        raise ActionError("The end date must be on or after the start date.")
    request_type = _choice(session, "public.time_off_request_type", payload.get("request_type"), "vacation")
    session.execute(
        text(
            """
            insert into public.time_off_requests
              (organization_id, employee_id, start_date, end_date, request_type, reason, status)
            values (:org, :employee, :start, :end,
                    cast(:type as public.time_off_request_type), :reason, 'pending')
            """
        ),
        {
            "org": profile["organization_id"],
            "employee": profile["id"],
            "start": start,
            "end": end,
            "type": request_type,
            "reason": _text(payload, "reason", "Reason", required=False),
        },
    )
    return f"Time off from {start.isoformat()} to {end.isoformat()} submitted for approval."


def _apply_overtime(session: Session, profile: dict, payload: dict) -> str:
    start = _datetime(payload, "start_at", "Start time")
    end = _datetime(payload, "end_at", "End time")
    if end <= start:
        raise ActionError("The end time must be after the start time.")
    if (end - start) > timedelta(hours=16):
        raise ActionError("An overtime request cannot be longer than 16 hours.")
    overtime_type = _choice(
        session, "public.overtime_request_type", payload.get("overtime_type"), "voluntary"
    )
    session.execute(
        text(
            """
            insert into public.overtime_requests
              (organization_id, employee_id, start_at, end_at, note, overtime_type, status)
            values (:org, :employee, :start, :end, :note,
                    cast(:type as public.overtime_request_type), 'pending')
            """
        ),
        {
            "org": profile["organization_id"],
            "employee": profile["id"],
            "start": start,
            "end": end,
            "note": _text(payload, "note", "Note", required=False),
            "type": overtime_type,
        },
    )
    return "Overtime request submitted for approval."


def _apply_exception(session: Session, profile: dict, payload: dict) -> str:
    start = _date(payload, "start_date", "Start date")
    end = _date(payload, "end_date", "End date")
    if end < start:
        raise ActionError("The end date must be on or after the start date.")
    code = _choice(session, "public.exception_code", payload.get("exception_code"), "DO")
    exception_type = _choice(
        session, "public.exception_request_type", payload.get("exception_type"), "other"
    )
    title = _text(payload, "title", "Title", required=False) or f"{code} request"
    session.execute(
        text(
            """
            insert into public.exception_requests
              (organization_id, employee_id, submitted_by, exception_type, exception_code,
               title, details, start_date, end_date, status)
            values
              (:org, :employee, :employee,
               cast(:type as public.exception_request_type),
               cast(:code as public.exception_code),
               :title, :details, :start, :end, 'submitted')
            """
        ),
        {
            "org": profile["organization_id"],
            "employee": profile["id"],
            "type": exception_type,
            "code": code,
            "title": title,
            "details": _text(payload, "details", "Details", required=False),
            "start": start,
            "end": end,
        },
    )
    return f"{code} exception request submitted for review."


def _apply_swap(session: Session, profile: dict, payload: dict) -> str:
    shift_id = _text(payload, "shift_id", "Shift")
    _require_own_shift(session, profile["id"], shift_id, "Shift swaps")
    target = payload.get("requested_employee_id") or None
    if target:
        exists = session.execute(
            text("select 1 from public.profiles where id = :id"), {"id": target}
        ).scalar()
        if not exists:
            raise ActionError("The requested colleague no longer exists on this site.")
    session.execute(
        text("select public.create_shift_swap_request(:shift, :target, :note)"),
        {
            "shift": shift_id,
            "target": target,
            "note": _text(payload, "request_note", "Note", required=False),
        },
    )
    return "Shift swap posted."


def _apply_acknowledge(session: Session, profile: dict, payload: dict) -> str:
    assignment_id = _text(payload, "assignment_id", "Task assignment")
    owner = session.execute(
        text("select employee_id from public.task_assignments where id = :id"),
        {"id": assignment_id},
    ).scalar()
    if owner is None:
        raise ActionError("That task assignment no longer exists on this site.")
    if str(owner) != str(profile["id"]):
        raise ActionError("You can only acknowledge your own tasks.")
    session.execute(
        text("select public.acknowledge_task_assignment(:id, :note)"),
        {"id": assignment_id, "note": _text(payload, "note", "Note", required=False)},
    )
    return "Task acknowledged."


def _apply_claim(session: Session, profile: dict, payload: dict) -> str:
    shift_id = _text(payload, "shift_id", "Shift")
    session.execute(text("select public.claim_shift_pool_shift(:id)"), {"id": shift_id})
    return "Shift claimed. Check your schedule for the update."


def _apply_clock_in(session: Session, profile: dict, payload: dict) -> str:
    shift_id = _text(payload, "shift_id", "Shift")
    _require_own_shift(session, profile["id"], shift_id, "Clock-in")
    location = _clock_location(session, profile["organization_id"], shift_id, payload, False)
    session.execute(
        text("select public.clock_in_shift(:shift, :lat, :lon, :accuracy, :device, :mobile)"),
        {
            "shift": shift_id,
            "lat": location["latitude"],
            "lon": location["longitude"],
            "accuracy": location["accuracy"],
            "device": "RTLink web",
            "mobile": location["latitude"] is not None,
        },
    )
    return "Clocked in."


def _apply_clock_out(session: Session, profile: dict, payload: dict) -> str:
    shift_id = _text(payload, "shift_id", "Shift")
    _require_own_shift(session, profile["id"], shift_id, "Clock-out")
    session.execute(text("select public.clock_out_shift(:id)"), {"id": shift_id})
    return "Clocked out."


def _apply_unscheduled_clock_in(session: Session, profile: dict, payload: dict) -> str:
    location = _clock_location(session, profile["organization_id"], None, payload, True)
    session.execute(
        text(
            "select public.clock_in_unscheduled_shift("
            ":note, :lat, :lon, :accuracy, :device, :mobile)"
        ),
        {
            "note": _text(payload, "note", "Note", required=False) or "Clocked in from RTLink",
            "lat": location["latitude"],
            "lon": location["longitude"],
            "accuracy": location["accuracy"],
            "device": "RTLink web",
            "mobile": location["latitude"] is not None,
        },
    )
    return "Clocked in (unscheduled overtime)."


APPLIERS: dict[str, Callable[[Session, dict, dict], str]] = {
    "time_off.create": _apply_time_off,
    "overtime.create": _apply_overtime,
    "exception.create": _apply_exception,
    "swap.create": _apply_swap,
    "task.acknowledge": _apply_acknowledge,
    "shift.claim": _apply_claim,
    "shift.clock_in": _apply_clock_in,
    "shift.clock_out": _apply_clock_out,
    "shift.clock_in_unscheduled": _apply_unscheduled_clock_in,
}


def _apply_one(action: dict) -> tuple[bool, str | None, str | None]:
    """Apply one queued action. Returns (applied, message, error)."""
    action_id = str(action["id"])
    kind = str(action.get("kind") or "")
    payload = action.get("payload") or {}
    if not isinstance(payload, dict):
        payload = {}

    with session_scope() as session:
        logged = _log_row(session, action_id)
        if logged and logged["status"] == "applied":
            return True, "Already applied.", None
        attempts = int(logged["attempts"]) + 1 if logged else 1

    if kind not in APPLIERS:
        error = f"Unsupported RTLink action: {kind or 'missing'}."
        with session_scope() as session:
            _write_log(session, action, "failed", 1, error, None)
        return False, None, error

    try:
        with session_scope(action["employee_id"], "authenticated") as session:
            profile = _profile(session, action.get("employee_id"))
            _require_active(session, profile)
            message = APPLIERS[kind](session, profile, payload)
            _write_log(session, action, "applied", attempts, None, message)
        return True, message, None
    except Exception as exc:  # noqa: BLE001 - reported back to RTLink
        error = str(exc) or exc.__class__.__name__
        if isinstance(exc, ActionError):
            error = str(exc)
        elif isinstance(exc, HTTPException):
            error = str(exc.detail)
        terminal = attempts >= MAX_ATTEMPTS or isinstance(exc, TerminalAction)
        logger.info("RTLink action %s (%s) failed: %s", action_id, kind, error)
        try:
            with session_scope() as session:
                _write_log(
                    session,
                    action,
                    "failed" if terminal else "pending",
                    attempts,
                    error,
                    None,
                )
        except Exception:  # noqa: BLE001 - logging must not mask the outcome
            logger.warning("RTLink action log write failed", exc_info=True)
        return False, None, error


def run_once(trigger: str = "poll") -> dict[str, Any]:
    """Poll and apply this site's pending RTLink actions. Never raises."""
    if not settings.rtlink_enabled:
        return {
            "ok": False,
            "error": (
                "RTLink sync is not configured. Set RTLINK_SUPABASE_URL, "
                "RTLINK_SUPABASE_SERVICE_ROLE_KEY and RTLINK_SITE_ID."
            ),
        }
    with _pull_lock:
        at = datetime.now(timezone.utc).isoformat()
        with _state_lock:
            _action_state["last_poll_at"] = at
            _action_state["last_trigger"] = trigger
            _action_state["polls"] += 1
        applied = 0
        changed = 0
        failed = 0
        messages: list[str] = []
        try:
            actions = fetch_pending()
        except Exception as exc:  # noqa: BLE001
            message = str(exc) or exc.__class__.__name__
            with _state_lock:
                _action_state["last_error"] = message
            logger.warning("RTLink action poll failed: %s", message)
            return {"ok": False, "error": message}

        for action in actions:
            ok, message, error = _apply_one(action)
            next_attempts = 1
            try:
                with session_scope() as session:
                    logged = _log_row(session, str(action["id"]))
                    next_attempts = int(logged["attempts"]) if logged else 1
            except Exception:  # noqa: BLE001
                next_attempts = 1
            body: dict[str, Any] = {
                "attempts": next_attempts,
                "processed_at": at if ok or next_attempts >= MAX_ATTEMPTS else None,
            }
            if ok:
                applied += 1
                if message != "Already applied.":
                    changed += 1
                body["status"] = "applied"
                body["error"] = None
                body["result"] = message
                if message:
                    messages.append(message)
            else:
                failed += 1
                body["status"] = "failed" if next_attempts >= MAX_ATTEMPTS else "pending"
                body["error"] = error
                body["result"] = None
            action_id = str(action["id"])
            if _ack_retry_at.get(action_id, 0.0) > time.monotonic():
                continue
            try:
                _report(action_id, body)
                _ack_retry_at.pop(action_id, None)
            except Exception as exc:  # noqa: BLE001
                _ack_retry_at[action_id] = time.monotonic() + ACK_RETRY_SECONDS
                logger.warning("RTLink action %s could not be acknowledged: %s", action_id, exc)

        result: dict[str, Any] = {
            "ok": True,
            "trigger": trigger,
            "polled": len(actions),
            "applied": applied,
            "failed": failed,
            "messages": messages,
            "at": at,
        }
        with _state_lock:
            _action_state["last_success_at"] = at
            _action_state["last_error"] = None
            _action_state["applied"] += applied
            _action_state["failed"] += failed
            _action_state["last_result"] = result

        if changed:
            # Employees should see the new shift/request without waiting for the
            # next reconciliation pass. A no-op re-apply (an action already in the
            # local log) must not trigger a push on every poll.
            try:
                sync_now("action")
            except Exception:  # noqa: BLE001
                logger.warning("Snapshot after RTLink action failed", exc_info=True)

        return result


def status() -> dict[str, Any]:
    with _state_lock:
        snapshot = dict(_state)
    with _state_lock:
        actions = dict(_action_state)
    return {
        "configured": settings.rtlink_enabled,
        "siteId": settings.rtlink_site_id or None,
        "siteName": settings.rtlink_site_name or None,
        "supabaseUrl": settings.rtlink_supabase_url or None,
        "intervalMinutes": settings.rtlink_sync_minutes,
        "changeSync": settings.rtlink_change_sync,
        "pollSeconds": settings.rtlink_poll_seconds,
        "kinds": sorted(APPLIERS),
        **snapshot,
        "actions": actions,
    }


# ---------------------------------------------------------------------------
# Background workers
# ---------------------------------------------------------------------------


def _listener_loop() -> None:
    """Mark the snapshot dirty whenever any public table changes."""
    while not _stop.is_set():
        try:
            with psycopg.connect(psycopg_dsn(), autocommit=True) as connection:
                connection.execute("listen suite_realtime")
                logger.info("RTLink sync listening for local changes")
                while not _stop.is_set():
                    for _notify in connection.notifies(timeout=5.0, stop_after=1):
                        _dirty.set()
        except Exception:  # noqa: BLE001 - reconnect forever
            if _stop.is_set():
                return
            logger.warning("RTLink listener disconnected; retrying in 10s", exc_info=True)
            _stop.wait(10)


# A change on this LAN is usually one save, so the push waits only long enough
# for the surrounding transaction to commit.
CHANGE_SETTLE_SECONDS = 0.35
RETRY_MAX_SECONDS = 30.0


def _worker_loop() -> None:
    interval = max(1, settings.rtlink_sync_minutes) * 60
    sync_now("startup")
    next_full = time.monotonic() + interval
    retry_delay = 0.0
    while not _stop.is_set():
        if settings.rtlink_change_sync and (retry_delay or _dirty.wait(1.0)):
            _dirty.clear()
            if not retry_delay:
                # Let a burst of writes settle before reading the database.
                _stop.wait(CHANGE_SETTLE_SECONDS)
            result = sync_now("change")
            next_full = time.monotonic() + interval
            if result.get("ok"):
                retry_delay = 0.0
            else:
                # A delivered-then-lost change would leave RTLink stale until the
                # next interval, so retry with backoff on top of the regular loop.
                retry_delay = min(RETRY_MAX_SECONDS, retry_delay * 2 if retry_delay else 1.0)
                _stop.wait(retry_delay)
                _dirty.set()
            continue
        if time.monotonic() >= next_full:
            sync_now("interval")
            next_full = time.monotonic() + interval


def _poll_loop() -> None:
    interval = max(1, settings.rtlink_poll_seconds)
    while not _stop.is_set():
        try:
            run_once("poll")
        except Exception:  # noqa: BLE001 - the poller must survive anything
            logger.warning("RTLink poll crashed; continuing", exc_info=True)
        _stop.wait(interval)


def start() -> None:
    if not settings.rtlink_enabled:
        return
    _stop.clear()
    for target, name in (
        (_listener_loop, "rtlink-listen"),
        (_worker_loop, "rtlink-push"),
        (_poll_loop, "rtlink-pull"),
    ):
        threading.Thread(target=target, name=name, daemon=True).start()
    logger.info(
        "RTLink bridge started (snapshot every %s min, actions every %ss)",
        settings.rtlink_sync_minutes,
        settings.rtlink_poll_seconds,
    )


def stop() -> None:
    _stop.set()
