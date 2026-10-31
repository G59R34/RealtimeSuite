"""Snapshot delivery from RealtimeSuite to RealtimeCorp (Supabase).

The LAN installation stays the source of truth. This module builds a JSON
snapshot of the local workforce data, upserts it into the RealtimeCorp mirror
tables with the service_role key, removes rows that no longer exist locally and
records a sync event so corporate users can see how fresh each site is.

Sync runs on three triggers:
  * once at startup (baseline),
  * every ``CORP_SYNC_MINUTES`` (reconciliation),
  * shortly after any local change, detected by LISTENing on ``suite_realtime``.

Nothing here is required for the LAN app to work: if Supabase is unreachable the
suite keeps operating and the failure is reported through the status endpoint.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Callable
from uuid import UUID

import psycopg
from sqlalchemy import text

from .config import settings
from .db import psycopg_dsn, session_scope
from .features import normalize_feature_flags
from .locks import CORP_OWNED_ORG_SETTINGS, CORP_OWNED_TRAINING_SETTINGS

logger = logging.getLogger("realtimesuite.corp")

# Collection name -> (table, SQL). Column names must match the Supabase schema.
COLLECTIONS: dict[str, tuple[str, str]] = {
    "employees": (
        "corp_employees",
        """
        select p.id, p.email, p.full_name, p.role::text as role, p.hourly_rate,
               p.onboarding_completed_at, coalesce(p.is_training_manager, false) as is_training_manager,
               true as is_active, p.created_at as created_at_local, p.updated_at as updated_at_local
        from public.profiles p
        """,
    ),
    "work_areas": (
        "corp_work_areas",
        """
        select id, name, color, coalesce(is_active, true) as is_active
        from public.work_areas
        """,
    ),
    "shifts": (
        "corp_shifts",
        """
        select s.id, s.employee_id, p.full_name as employee_name,
               s.work_area_id, wa.name as work_area_name,
               s.start_at, s.end_at, s.status::text as status,
               coalesce(s.break_minutes, 0) as break_minutes, s.worked_minutes,
               s.pay_multiplier, s.clocked_in_at, s.clocked_out_at,
               coalesce(s.is_unscheduled_overtime, false) as is_unscheduled_overtime
        from public.shifts s
        left join public.profiles p on p.id = s.employee_id
        left join public.work_areas wa on wa.id = s.work_area_id
        where s.start_at >= now() - interval '120 days'
          and s.start_at < now() + interval '60 days'
        """,
    ),
    "tasks": (
        "corp_tasks",
        """
        select t.id, t.title, t.description, t.status::text as status, t.priority::text as priority,
               t.start_at, t.end_at, t.work_area_id, wa.name as work_area_name,
               ta.employee_id as assignee_id, p.full_name as assignee_name,
               ta.acknowledged_at, t.source_system
        from public.tasks t
        left join public.work_areas wa on wa.id = t.work_area_id
        left join lateral (
          select a.employee_id, a.acknowledged_at
          from public.task_assignments a
          where a.task_id = t.id
          order by a.assigned_at desc nulls last
          limit 1
        ) ta on true
        left join public.profiles p on p.id = ta.employee_id
        where t.start_at >= now() - interval '120 days'
          and t.start_at < now() + interval '60 days'
        """,
    ),
    "time_off_requests": (
        "corp_time_off_requests",
        """
        select r.id, r.employee_id, p.full_name as employee_name,
               r.start_date, r.end_date, r.request_type, r.reason,
               r.status::text as status, r.created_at as created_at_local, r.reviewed_at
        from public.time_off_requests r
        left join public.profiles p on p.id = r.employee_id
        where r.created_at >= now() - interval '180 days'
        """,
    ),
    "exception_requests": (
        "corp_exception_requests",
        """
        select r.id, r.employee_id, p.full_name as employee_name,
               r.exception_code::text as exception_code, r.exception_type::text as exception_type,
               r.title, r.details, r.start_date, r.end_date,
               r.status::text as status, r.created_at as created_at_local
        from public.exception_requests r
        left join public.profiles p on p.id = r.employee_id
        where r.created_at >= now() - interval '180 days'
        """,
    ),
    "overtime_requests": (
        "corp_overtime_requests",
        """
        select r.id, r.employee_id, p.full_name as employee_name,
               r.start_at, r.end_at, r.overtime_type::text as overtime_type, r.note,
               r.status::text as status, r.created_at as created_at_local
        from public.overtime_requests r
        left join public.profiles p on p.id = r.employee_id
        where r.created_at >= now() - interval '180 days'
        """,
    ),
    "discipline_actions": (
        "corp_discipline_actions",
        """
        select d.id, d.employee_id, p.full_name as employee_name,
               d.title, d.details, d.severity::text as severity,
               d.punishment_type::text as punishment_type, d.status::text as status,
               d.leave_starts_on, d.leave_ends_on, d.created_at as created_at_local
        from public.discipline_actions d
        left join public.profiles p on p.id = d.employee_id
        """,
    ),
    "training_assignments": (
        "corp_training_assignments",
        """
        select a.id, a.employee_id, p.full_name as employee_name,
               c.title as course_title, a.status::text as status, a.due_at, a.completed_at
        from public.training_assignments a
        left join public.profiles p on p.id = a.employee_id
        left join public.training_courses c on c.id = a.course_id
        """,
    ),
    "board_notes": (
        "corp_board_notes",
        """
        select n.id, n.note_date, n.body, n.is_public, n.created_at as created_at_local
        from public.board_notes n
        where n.note_date >= current_date - 90
        """,
    ),
    "announcements": (
        "corp_announcements",
        """
        select a.id, a.message, a.is_active, a.starts_at, a.ends_at
        from public.site_announcements a
        """,
    ),
}

# Current local configuration, mirrored so the console can edit from real values.
SETTINGS_SQL = """
select
  experience_builder_config->'feature_flags' as feature_flags,
  enable_extended_leave_lock, extended_leave_threshold_days,
  enable_retail_floor_simulation, enable_admin_realtime_notifications,
  default_shift_break_minutes, default_timeline_window_hours,
  training_time_multiplier, training_fake_employee_count,
  training_no_show_rate_percent, training_task_ack_rate_percent,
  training_clock_in_early_min, training_clock_in_late_min,
  training_clock_out_early_min, training_clock_out_late_min
from public.organizations
order by created_at
limit 1
"""

_state_lock = threading.Lock()
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

_dirty = threading.Event()
_stop = threading.Event()


class CorpSyncError(RuntimeError):
    pass


def _jsonable(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, UUID):
        return str(value)
    return value


def _request(
    method: str,
    path: str,
    payload: Any = None,
    prefer: str | None = None,
) -> None:
    url = f"{settings.corp_supabase_url}{path}"
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("apikey", settings.corp_supabase_key)
    request.add_header("Authorization", f"Bearer {settings.corp_supabase_key}")
    request.add_header("Content-Type", "application/json")
    if prefer:
        request.add_header("Prefer", prefer)
    timeout = max(5, settings.corp_timeout_seconds)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise CorpSyncError(f"{method} {path} failed ({exc.code}): {detail}") from exc
    except urllib.error.URLError as exc:
        raise CorpSyncError(f"{method} {path} failed: {exc.reason}") from exc


def _with_retries(action: Callable[[], None], label: str) -> None:
    attempts = 3
    delay = 0.5
    for attempt in range(1, attempts + 1):
        try:
            action()
            return
        except CorpSyncError:
            if attempt == attempts:
                raise
            logger.warning("Corp sync %s failed (attempt %s/%s), retrying", label, attempt, attempts)
            time.sleep(delay)
            delay *= 2


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


def build_settings(stamp: str) -> dict[str, Any] | None:
    """The site's feature flags and corporate-owned policy settings."""
    with session_scope() as session:
        row = session.execute(text(SETTINGS_SQL)).mappings().first()
    if row is None:
        return None
    data = dict(row)
    flags = normalize_feature_flags(data.get("feature_flags"))
    policy = {
        key: data.get(key)
        for key in CORP_OWNED_ORG_SETTINGS
        if data.get(key) is not None
    }
    policy["training_mode"] = {
        key: data.get(key) for key in CORP_OWNED_TRAINING_SETTINGS if data.get(key) is not None
    }
    return {
        "site_id": settings.corp_site_id,
        "company_id": settings.corp_company_id,
        "feature_flags": flags,
        "policy_settings": policy,
        "synced_at": stamp,
    }


def build_snapshot() -> tuple[dict[str, Any], dict[str, int], str]:
    """Read the local database and return (site row, collection rows, timestamp)."""
    started = datetime.now(timezone.utc)
    stamp = started.isoformat()
    site_id = settings.corp_site_id
    company_id = settings.corp_company_id

    collections: dict[str, list[dict[str, Any]]] = {}
    counts: dict[str, int] = {}
    with session_scope() as session:
        organization = session.execute(
            text("select name from public.organizations order by created_at limit 1")
        ).scalar()
        for name, (_, sql) in COLLECTIONS.items():
            rows = session.execute(text(sql)).mappings().all()
            prepared = []
            for row in rows:
                item = {key: _jsonable(value) for key, value in row.items()}
                item["site_id"] = site_id
                item["company_id"] = company_id
                item["synced_at"] = stamp
                prepared.append(item)
            collections[name] = prepared
            counts[name] = len(prepared)

    site_row = {
        "id": site_id,
        "company_id": company_id,
        "location_id": settings.corp_location_id or None,
        "name": settings.corp_site_name or organization or settings.organization_name,
        "app_version": settings.app_version,
        "last_sync_at": stamp,
        "record_counts": counts,
        "updated_at": stamp,
    }
    return site_row, collections, stamp


def sync_now(trigger: str = "manual") -> dict[str, Any]:
    """Build and deliver one snapshot. Returns a result dict, never raises."""
    if not settings.corp_enabled:
        return {
            "ok": False,
            "error": (
                "Corporate sync is not configured. Set CORP_SUPABASE_URL, "
                "CORP_SUPABASE_SERVICE_ROLE_KEY, CORP_SITE_ID and CORP_COMPANY_ID."
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
        _upsert("corp_sites", [site_row])
        for name, (table, _sql) in COLLECTIONS.items():
            _upsert(table, collections[name])
        # corp_settings is keyed by site, not by a source row id.
        site_settings = build_settings(stamp)
        if site_settings is not None:
            _upsert("corp_settings", [site_settings], conflict="site_id")

        # Rows that no longer exist locally were not touched by this snapshot.
        for name, (table, _sql) in COLLECTIONS.items():
            _with_retries(
                lambda table=table: _request(
                    "DELETE",
                    f"/rest/v1/{table}?site_id=eq.{settings.corp_site_id}"
                    f"&synced_at=lt.{stamp}",
                    prefer="return=minimal",
                ),
                f"prune {table}",
            )

        counts = {name: len(rows) for name, rows in collections.items()}
        _request(
            "POST",
            "/rest/v1/corp_sync_events",
            [
                {
                    "site_id": settings.corp_site_id,
                    "company_id": settings.corp_company_id,
                    "kind": trigger,
                    "status": "ok",
                    "record_counts": counts,
                    "message": None,
                    "received_at": stamp,
                }
            ],
            prefer="return=minimal",
        )

        duration = int((time.monotonic() - started) * 1000)
        with _state_lock:
            _state["last_success_at"] = stamp
            _state["last_error"] = None
            _state["last_counts"] = counts
            _state["last_duration_ms"] = duration
        logger.info("Corp sync (%s) delivered %s records in %sms", trigger, sum(counts.values()), duration)
        return {"ok": True, "counts": counts, "at": stamp, "durationMs": duration}

    except Exception as exc:  # noqa: BLE001 - surfaced through status/response
        message = str(exc) or exc.__class__.__name__
        with _state_lock:
            _state["last_error"] = message
            _state["failures"] += 1
        logger.warning("Corp sync (%s) failed: %s", trigger, message)
        # Best effort: record the failure so corporate users see it.
        try:
            _request(
                "POST",
                "/rest/v1/corp_sync_events",
                [
                    {
                        "site_id": settings.corp_site_id,
                        "company_id": settings.corp_company_id,
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


def status() -> dict[str, Any]:
    with _state_lock:
        snapshot = dict(_state)
    return {
        "configured": settings.corp_enabled,
        "siteId": settings.corp_site_id or None,
        "companyId": settings.corp_company_id or None,
        "locationId": settings.corp_location_id or None,
        "supabaseUrl": settings.corp_supabase_url or None,
        "intervalMinutes": settings.corp_sync_minutes,
        "changeSync": settings.corp_change_sync,
        **snapshot,
    }


def _listener_loop() -> None:
    """Mark the snapshot dirty whenever any public table changes."""
    while not _stop.is_set():
        try:
            with psycopg.connect(psycopg_dsn(), autocommit=True) as connection:
                connection.execute("listen suite_realtime")
                logger.info("Corp sync listening for local changes")
                while not _stop.is_set():
                    for _notify in connection.notifies(timeout=5.0, stop_after=1):
                        _dirty.set()
        except Exception:  # noqa: BLE001 - reconnect forever
            if _stop.is_set():
                return
            logger.warning("Corp sync listener disconnected; retrying in 10s", exc_info=True)
            _stop.wait(10)


def _worker_loop() -> None:
    interval = max(1, settings.corp_sync_minutes) * 60
    sync_now("startup")
    next_full = time.monotonic() + interval
    while not _stop.is_set():
        if settings.corp_change_sync and _dirty.wait(2.0):
            _dirty.clear()
            # Let a burst of writes settle before reading the database.
            _stop.wait(2.0)
            sync_now("change")
            next_full = time.monotonic() + interval
            continue
        if time.monotonic() >= next_full:
            sync_now("interval")
            next_full = time.monotonic() + interval


def start() -> None:
    if not settings.corp_enabled:
        return
    _stop.clear()
    threads = [
        threading.Thread(target=_listener_loop, name="corp-sync-listen", daemon=True),
        threading.Thread(target=_worker_loop, name="corp-sync-push", daemon=True),
    ]
    for thread in threads:
        thread.start()
    logger.info("Corporate snapshot sync started (every %s min)", settings.corp_sync_minutes)


def stop() -> None:
    _stop.set()
