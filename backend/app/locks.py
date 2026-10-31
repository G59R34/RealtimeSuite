"""Fields that only RealtimeCorp may change.

Pay, permissions, policy and feature flags are corporate-owned. This module is
the single place that lists them, so every router rejects the same set with the
same message. The lock is unconditional: a site with no corporate connection is
still read-only for these fields (see AGENTS.md, "Corporate-owned controls").

Corporate changes arrive through ``app.corp_commands``; nothing in the LAN app
writes these fields from a local request.
"""

from __future__ import annotations

from collections.abc import Iterable

from fastapi import HTTPException

_SUFFIX = " Change it in the RealtimeCorp console; this site applies it within seconds."

_PAY = "Pay rates are managed in RealtimeCorp."
_MULTIPLIER = "Shift pay multipliers are managed in RealtimeCorp."
_PERMISSIONS = "Roles and permissions are managed in RealtimeCorp."
_FEATURES = "Feature flags are managed in RealtimeCorp."
_POLICY = "Organization policy settings are managed in RealtimeCorp."
_TRAINING = "Training mode tuning is managed in RealtimeCorp."

CORP_OWNED_FIELDS: dict[str, str] = {
    "hourly_rate": _PAY,
    "pay_multiplier": _MULTIPLIER,
    "role": _PERMISSIONS,
    "is_training_manager": _PERMISSIONS,
    "admin_training_only": _PERMISSIONS,
    "feature_flags": _FEATURES,
    "training_mode": _TRAINING,
    "enable_extended_leave_lock": _POLICY,
    "extended_leave_threshold_days": _POLICY,
    "enable_retail_floor_simulation": _POLICY,
    "enable_admin_realtime_notifications": _POLICY,
    "default_shift_break_minutes": _POLICY,
    "default_timeline_window_hours": _POLICY,
}

# Organization columns the corporate console may set through a policy command.
CORP_OWNED_ORG_SETTINGS = {
    "enable_extended_leave_lock",
    "extended_leave_threshold_days",
    "enable_retail_floor_simulation",
    "enable_admin_realtime_notifications",
    "default_shift_break_minutes",
    "default_timeline_window_hours",
}

# Training-mode tuning (organization columns, written through the SQL function)
# with the defaults `update_training_mode_settings` applies.
CORP_OWNED_TRAINING_SETTINGS: dict[str, int] = {
    "training_time_multiplier": 10,
    "training_fake_employee_count": 18,
    "training_no_show_rate_percent": 12,
    "training_task_ack_rate_percent": 82,
    "training_clock_in_early_min": -7,
    "training_clock_in_late_min": 9,
    "training_clock_out_early_min": -4,
    "training_clock_out_late_min": 14,
}


def corp_owned_message(field: str) -> str:
    return CORP_OWNED_FIELDS.get(field, _POLICY)


def reject_corp_owned(payload: dict, fields: Iterable[str] | None = None) -> None:
    """Raise 403 when a local request tries to write a corporate-owned field."""
    keys = list(fields) if fields is not None else list(CORP_OWNED_FIELDS)
    for key in keys:
        if key in payload:
            raise HTTPException(
                status_code=403, detail=corp_owned_message(key) + _SUFFIX
            )


def reject_field(payload: dict, field: str) -> None:
    reject_corp_owned(payload, [field])


def corp_managed_payload() -> dict:
    """What the UI needs to explain why a control is read-only."""
    return {
        "locked": True,
        "fields": {key: value + _SUFFIX for key, value in CORP_OWNED_FIELDS.items()},
    }
