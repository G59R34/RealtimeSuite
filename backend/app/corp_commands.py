"""Apply corporate-owned changes queued by RealtimeCorp.

Pay rates, roles/permissions, shift pay multipliers, feature flags and
organization policy can no longer be edited on the LAN (see ``app.locks``). The
corporate console queues a command in ``corp_commands``; this worker polls its
own site's pending commands with the service_role key, applies each one locally,
writes the outcome back (applied / failed + error) and then pushes a snapshot so
corporate users see the new value immediately.

Delivery is at-least-once: every applied command id is recorded in
``public.corp_command_log`` so a redelivered command is acknowledged rather than
applied twice. Nothing here is required for the LAN app to run; when corporate
is unreachable the site keeps scheduling and the failure is visible in
``GET /api/integrations/corp/status``.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings
from .db import session_scope
from .features import DEFAULT_FEATURE_FLAGS, normalize_feature_flags
from .locks import CORP_OWNED_ORG_SETTINGS, CORP_OWNED_TRAINING_SETTINGS

logger = logging.getLogger("realtimesuite.corp.commands")

COMMAND_KINDS = {
    "set_pay_rate",
    "set_employee_permissions",
    "set_shift_multiplier",
    "set_feature_flags",
    "set_policy_settings",
}

MAX_ATTEMPTS = 3

_TRAINING_FIELDS = CORP_OWNED_TRAINING_SETTINGS

_state_lock = threading.Lock()
_run_lock = threading.Lock()
_stop = threading.Event()

_state: dict[str, Any] = {
    "last_poll_at": None,
    "last_success_at": None,
    "last_error": None,
    "last_trigger": None,
    "polls": 0,
    "applied": 0,
    "failed": 0,
    "last_result": None,
}


class CommandError(RuntimeError):
    """A command could not be applied; the message is shown in RealtimeCorp."""


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def _request(
    method: str,
    path: str,
    payload: Any = None,
    prefer: str | None = None,
) -> Any:
    url = f"{settings.corp_supabase_url}{path}"
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("apikey", settings.corp_supabase_key)
    request.add_header("Authorization", f"Bearer {settings.corp_supabase_key}")
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "application/json")
    if prefer:
        request.add_header("Prefer", prefer)
    timeout = max(5, settings.corp_timeout_seconds)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise CommandError(f"{method} {path} failed ({exc.code}): {detail}") from exc
    except urllib.error.URLError as exc:
        raise CommandError(f"{method} {path} failed: {exc.reason}") from exc
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def fetch_pending(limit: int = 25) -> list[dict]:
    rows = _request(
        "GET",
        "/rest/v1/corp_commands"
        "?select=id,kind,target_id,payload,note,requested_at,attempts"
        f"&site_id=eq.{settings.corp_site_id}"
        "&status=eq.pending"
        "&order=requested_at.asc"
        f"&limit={limit}",
    )
    return rows if isinstance(rows, list) else []


def _report(command_id: str, body: dict) -> None:
    _request(
        "PATCH",
        f"/rest/v1/corp_commands?id=eq.{command_id}",
        body,
        prefer="return=minimal",
    )


# ---------------------------------------------------------------------------
# Local log (idempotency + audit)
# ---------------------------------------------------------------------------


def _log_row(session: Session, command_id: str) -> dict | None:
    row = session.execute(
        text(
            "select status, attempts from public.corp_command_log where command_id = :id"
        ),
        {"id": command_id},
    ).mappings().first()
    return dict(row) if row else None


def _write_log(
    session: Session,
    command: dict,
    status: str,
    attempts: int,
    error: str | None,
) -> None:
    session.execute(
        text(
            """
            insert into public.corp_command_log
              (command_id, kind, target_id, payload, status, attempts, error,
               received_at, applied_at)
            values
              (:id, :kind, :target, cast(:payload as jsonb), :status, :attempts,
               :error, now(), case when :status = 'applied' then now() else null end)
            on conflict (command_id) do update
              set status = excluded.status,
                  attempts = excluded.attempts,
                  error = excluded.error,
                  applied_at = excluded.applied_at
            """
        ),
        {
            "id": command["id"],
            "kind": command.get("kind") or "unknown",
            "target": command.get("target_id"),
            "payload": json.dumps(command.get("payload") or {}),
            "status": status,
            "attempts": attempts,
            "error": error,
        },
    )


# ---------------------------------------------------------------------------
# Appliers
# ---------------------------------------------------------------------------


def _as_float(value: Any, label: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise CommandError(f"{label} must be a number.") from exc


def _apply_pay_rate(session: Session, command: dict) -> str:
    payload = command.get("payload") or {}
    if "hourly_rate" not in payload:
        raise CommandError("The command did not include an hourly rate.")
    raw = payload["hourly_rate"]
    rate = None if raw in (None, "") else _as_float(raw, "Hourly rate")
    if rate is not None and rate < 0:
        raise CommandError("Hourly rate cannot be negative.")
    row = session.execute(
        text(
            "update public.profiles set hourly_rate = :rate where id = :id returning id"
        ),
        {"rate": rate, "id": command.get("target_id")},
    ).first()
    if row is None:
        raise CommandError("That employee does not exist on this site any more.")
    return "Pay rate updated."


def _apply_permissions(session: Session, command: dict) -> str:
    payload = command.get("payload") or {}
    employee_id = command.get("target_id")
    if not employee_id:
        raise CommandError("A target employee is required.")
    allowed = {"role", "is_training_manager", "admin_training_only"}
    updates = {key: payload[key] for key in allowed if key in payload}
    if not updates:
        raise CommandError("The command did not include a role or permission change.")

    if "role" in updates and updates["role"] not in {"admin", "employee"}:
        raise CommandError("Role must be 'admin' or 'employee'.")

    current = session.execute(
        text("select role::text as role from public.profiles where id = :id"),
        {"id": employee_id},
    ).scalar()
    if current is None:
        raise CommandError("That employee does not exist on this site any more.")

    if updates.get("role") == "employee" and current == "admin":
        others = session.execute(
            text(
                "select count(*) from public.profiles "
                "where role = 'admin' and id <> :id"
            ),
            {"id": employee_id},
        ).scalar()
        if not others:
            raise CommandError(
                "That is the last administrator on this site; promote someone else first."
            )

    assignments = []
    params: dict[str, Any] = {"id": employee_id}
    for key, value in updates.items():
        if key == "role":
            assignments.append("role = cast(:role as public.app_role)")
        else:
            assignments.append(f"{key} = :{key}")
        params[key] = value
    session.execute(
        text(
            f"update public.profiles set {', '.join(assignments)} where id = :id"
        ),
        params,
    )
    return "Permissions updated."


def _apply_shift_multiplier(session: Session, command: dict) -> str:
    payload = command.get("payload") or {}
    value = _as_float(payload.get("pay_multiplier"), "Pay multiplier")
    if value <= 0 or value > 10:
        raise CommandError("Pay multiplier must be greater than 0 and at most 10.")
    row = session.execute(
        text(
            "update public.shifts set pay_multiplier = :value where id = :id returning id"
        ),
        {"value": value, "id": command.get("target_id")},
    ).first()
    if row is None:
        raise CommandError("That shift does not exist on this site any more.")
    return f"Shift multiplier set to {value}x."


def _organization(session: Session) -> dict:
    row = session.execute(
        text("select * from public.organizations order by created_at limit 1")
    ).mappings().first()
    if row is None:
        raise CommandError("This site has no organization row.")
    return dict(row)


def _apply_feature_flags(session: Session, command: dict) -> str:
    payload = command.get("payload") or {}
    flags = payload.get("flags")
    if not isinstance(flags, dict) or not flags:
        raise CommandError("The command did not include any feature flags.")
    unknown = sorted(set(flags) - set(DEFAULT_FEATURE_FLAGS))
    if unknown:
        raise CommandError(f"Unknown feature flags: {', '.join(unknown)}.")
    org = _organization(session)
    config = dict(org.get("experience_builder_config") or {})
    stored = config.get("feature_flags") if isinstance(config, dict) else {}
    merged = {**normalize_feature_flags(stored), **{k: bool(v) for k, v in flags.items()}}
    config["feature_flags"] = merged
    session.execute(
        text(
            "update public.organizations set experience_builder_config = cast(:config as jsonb) "
            "where id = :id"
        ),
        {"config": json.dumps(config), "id": org["id"]},
    )
    return "Feature flags updated."


def _admin_actor(session: Session) -> str | None:
    return session.execute(
        text(
            "select id from public.profiles where role = 'admin' "
            "order by created_at nulls last limit 1"
        )
    ).scalar()


def _apply_policy_settings(session: Session, command: dict) -> str:
    payload = command.get("payload") or {}
    settings_payload = payload.get("settings") or {}
    training_payload = payload.get("training_mode") or {}
    if not isinstance(settings_payload, dict) or not isinstance(training_payload, dict):
        raise CommandError("Policy settings must be an object.")
    if not settings_payload and not training_payload:
        raise CommandError("The command did not include any policy settings.")

    org = _organization(session)
    updated: list[str] = []

    settings_updates = {
        key: value for key, value in settings_payload.items() if key in CORP_OWNED_ORG_SETTINGS
    }
    unknown = sorted(set(settings_payload) - CORP_OWNED_ORG_SETTINGS)
    if unknown:
        raise CommandError(f"Unknown policy settings: {', '.join(unknown)}.")
    if settings_updates:
        assignments = []
        params: dict[str, Any] = {"id": org["id"]}
        for key, value in settings_updates.items():
            assignments.append(f"{key} = :{key}")
            params[key] = value
        session.execute(
            text(
                f"update public.organizations set {', '.join(assignments)} where id = :id"
            ),
            params,
        )
        updated.extend(sorted(settings_updates))
        org = _organization(session)

    unknown_training = sorted(set(training_payload) - set(_TRAINING_FIELDS))
    if unknown_training:
        raise CommandError(f"Unknown training settings: {', '.join(unknown_training)}.")
    if training_payload:
        values = {
            key: training_payload.get(key, org.get(key) if org.get(key) is not None else default)
            for key, default in _TRAINING_FIELDS.items()
        }
        # The SQL function is the business rule for training tuning and resolves
        # auth.uid(); run it as this site's first admin on the same transaction.
        actor = _admin_actor(session)
        if actor is None:
            raise CommandError("This site has no administrator to authorize the change.")
        session.execute(
            text("select set_config('request.jwt.claim.sub', :sub, true)"),
            {"sub": str(actor)},
        )
        session.execute(
            text("select set_config('request.jwt.claim.role', 'authenticated', true)")
        )
        session.execute(
            text(
                "select public.update_training_mode_settings("
                + ", ".join(f":{key}" for key in _TRAINING_FIELDS)
                + ")"
            ),
            {key: int(values[key]) for key in _TRAINING_FIELDS},
        )
        updated.extend(sorted(training_payload))

    return f"Policy settings updated ({', '.join(updated)})."


APPLIERS = {
    "set_pay_rate": _apply_pay_rate,
    "set_employee_permissions": _apply_permissions,
    "set_shift_multiplier": _apply_shift_multiplier,
    "set_feature_flags": _apply_feature_flags,
    "set_policy_settings": _apply_policy_settings,
}


# ---------------------------------------------------------------------------
# Run loop
# ---------------------------------------------------------------------------


def _apply_one(command: dict) -> tuple[bool, str | None, str | None]:
    """Apply one command. Returns (applied, message, error)."""
    command_id = str(command["id"])
    kind = str(command.get("kind") or "")
    payload = command.get("payload") or {}
    if not isinstance(payload, dict):
        payload = {}

    with session_scope() as session:
        logged = _log_row(session, command_id)
        if logged and logged["status"] == "applied":
            # Already applied but the acknowledgement never landed.
            return True, "Already applied.", None
        attempts = int(logged["attempts"]) + 1 if logged else 1

    if kind not in APPLIERS:
        with session_scope() as session:
            _write_log(session, {**command, "payload": payload}, "failed", 1,
                       f"Unsupported command kind: {kind or 'missing'}.")
        return False, None, f"Unsupported command kind: {kind or 'missing'}."

    try:
        with session_scope() as session:
            message = APPLIERS[kind](session, {**command, "payload": payload})
            _write_log(session, {**command, "payload": payload}, "applied", attempts, None)
        return True, message, None
    except Exception as exc:  # noqa: BLE001 - reported to corporate
        error = str(exc) or exc.__class__.__name__
        if isinstance(exc, CommandError):
            error = str(exc)
        terminal = attempts >= MAX_ATTEMPTS
        with session_scope() as session:
            _write_log(
                session,
                {**command, "payload": payload},
                "failed" if terminal else "pending",
                attempts,
                error,
            )
        return False, None, error


def run_once(trigger: str = "poll") -> dict[str, Any]:
    """Poll and apply this site's pending corporate commands. Never raises."""
    if not settings.corp_enabled:
        return {
            "ok": False,
            "error": (
                "Corporate sync is not configured. Set CORP_SUPABASE_URL, "
                "CORP_SUPABASE_SERVICE_ROLE_KEY, CORP_SITE_ID and CORP_COMPANY_ID."
            ),
        }
    with _run_lock:
        at = datetime.now(timezone.utc).isoformat()
        with _state_lock:
            _state["last_poll_at"] = at
            _state["last_trigger"] = trigger
            _state["polls"] += 1
        applied = 0
        failed = 0
        messages: list[str] = []
        try:
            commands = fetch_pending()
        except Exception as exc:  # noqa: BLE001
            message = str(exc) or exc.__class__.__name__
            with _state_lock:
                _state["last_error"] = message
            logger.warning("Corp command poll failed: %s", message)
            return {"ok": False, "error": message}

        for command in commands:
            ok, message, error = _apply_one(command)
            next_attempts = 0
            try:
                with session_scope() as session:
                    logged = _log_row(session, str(command["id"]))
                    next_attempts = int(logged["attempts"]) if logged else 1
            except Exception:  # noqa: BLE001
                next_attempts = 1
            body: dict[str, Any] = {
                "attempts": next_attempts,
                "applied_at": at if ok else None,
            }
            if ok:
                applied += 1
                body["status"] = "applied"
                body["error"] = None
                if message:
                    messages.append(message)
            else:
                failed += 1
                body["status"] = "failed" if next_attempts >= MAX_ATTEMPTS else "pending"
                body["error"] = error
            try:
                _report(str(command["id"]), body)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Corp command %s could not be acknowledged: %s", command["id"], exc)

        result: dict[str, Any] = {
            "ok": True,
            "trigger": trigger,
            "polled": len(commands),
            "applied": applied,
            "failed": failed,
            "messages": messages,
            "at": at,
        }
        with _state_lock:
            _state["last_success_at"] = at
            _state["last_error"] = None
            _state["applied"] += applied
            _state["failed"] += failed
            _state["last_result"] = result

        if applied:
            # Corporate should see the new value without waiting for the next pass.
            try:
                from . import corp_sync

                corp_sync.sync_now("command")
            except Exception:  # noqa: BLE001
                logger.warning("Snapshot after corporate command failed", exc_info=True)

        return result


def status() -> dict[str, Any]:
    with _state_lock:
        snapshot = dict(_state)
    return {
        "enabled": settings.corp_enabled,
        "pollSeconds": settings.corp_command_poll_seconds,
        "kinds": sorted(COMMAND_KINDS),
        "maxAttempts": MAX_ATTEMPTS,
        **snapshot,
    }


def recent(limit: int = 20) -> list[dict]:
    """Locally applied corporate changes, newest first."""
    with session_scope() as session:
        rows = session.execute(
            text(
                "select command_id, kind, target_id, payload, status, attempts, error, "
                "received_at, applied_at from public.corp_command_log "
                "order by received_at desc limit :limit"
            ),
            {"limit": max(1, min(200, limit))},
        ).mappings().all()
    return [
        {
            **dict(row),
            "command_id": str(row["command_id"]),
            "target_id": str(row["target_id"]) if row["target_id"] else None,
            "received_at": row["received_at"].isoformat() if row["received_at"] else None,
            "applied_at": row["applied_at"].isoformat() if row["applied_at"] else None,
        }
        for row in rows
    ]


def _loop() -> None:
    interval = max(3, settings.corp_command_poll_seconds)
    while not _stop.is_set():
        try:
            run_once("poll")
        except Exception:  # noqa: BLE001 - the poller must survive anything
            logger.warning("Corp command poll crashed; continuing", exc_info=True)
        _stop.wait(interval)


def start() -> None:
    if not settings.corp_enabled:
        return
    _stop.clear()
    threading.Thread(target=_loop, name="corp-command-poll", daemon=True).start()
    logger.info("Corporate command polling started (every %ss)", settings.corp_command_poll_seconds)


def stop() -> None:
    _stop.set()
