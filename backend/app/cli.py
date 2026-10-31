from __future__ import annotations

import argparse
import getpass
import json
import sys
from typing import Any

from sqlalchemy import text

from .db import apply_schema, create_user, ensure_seed, get_organization, session_scope
from .features import DEFAULT_FEATURE_FLAGS, FEATURE_GROUPS, FEATURE_META, normalize_feature_flags
from .security import hash_password

# Columns that reference profiles without ON DELETE handling and must be cleared
# before the account row can be removed.
PROFILE_REFERENCES: list[tuple[str, str]] = [
    ("discipline_actions", "issued_by"),
    ("discipline_actions", "reviewed_by"),
    ("discipline_actions", "updated_by"),
    ("exception_requests", "reviewed_by"),
    ("overtime_requests", "reviewed_by"),
    ("shift_break_schedules", "created_by"),
    ("shift_break_schedules", "updated_by"),
    ("shifts", "created_by"),
    ("shifts", "updated_by"),
    ("site_announcements", "created_by"),
    ("site_announcements", "updated_by"),
    ("task_assignments", "acknowledged_by"),
    ("task_assignments", "assigned_by"),
    ("tasks", "created_by"),
    ("tasks", "updated_by"),
    ("time_off_requests", "reviewed_by"),
    ("training_assignments", "assigned_by"),
    ("training_courses", "created_by"),
    ("training_courses", "updated_by"),
    ("work_areas", "created_by"),
]


def _read_password(password: str | None, password_stdin: bool) -> str:
    if password_stdin:
        value = sys.stdin.readline().rstrip("\r\n")
    elif password:
        value = password
    else:
        value = getpass.getpass("Password: ")
    if len(value) < 8:
        raise SystemExit("Password must be at least 8 characters.")
    return value


def _create_admin(email: str, password: str, name: str) -> None:
    if _has_admin():
        raise SystemExit(
            "This site already has an administrator; that account manages it. "
            + CORP_ROLE_MESSAGE
        )
    with session_scope() as session:
        existing = session.execute(
            text("select id from public.profiles where lower(email) = lower(:email)"),
            {"email": email},
        ).scalar()
    if existing:
        raise SystemExit("An account with that email already exists. Use reset-password instead.")
    create_user(email, password, name, role="admin")
    print(f"Created administrator {email}")


CORP_ROLE_MESSAGE = (
    "Roles and permissions are managed in RealtimeCorp. "
    "Create an employee here, then grant the role from the corporate console."
)


def _has_admin() -> bool:
    with session_scope() as session:
        return bool(
            session.execute(text("select 1 from public.profiles where role = 'admin' limit 1")).scalar()
        )


def _create_user(email: str, password: str, name: str, role: str) -> None:
    if role not in {"admin", "employee"}:
        raise SystemExit("Role must be admin or employee.")
    if "@" not in email:
        raise SystemExit("Enter a valid email address.")
    if role == "admin" and _has_admin():
        # The first administrator is the only local role assignment; every later
        # promotion is a corporate decision (see AGENTS.md).
        raise SystemExit(CORP_ROLE_MESSAGE)
    try:
        user_id = create_user(email, password, name, role=role)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    print(json.dumps({"id": user_id, "email": email.lower(), "role": role}))


def _reset_password(email: str, password: str) -> None:
    with session_scope() as session:
        user_id = session.execute(
            text("select id from public.profiles where lower(email) = lower(:email)"),
            {"email": email},
        ).scalar()
        if not user_id:
            raise SystemExit("No account with that email.")
        session.execute(
            text("update auth.users set encrypted_password = :password where id = :id"),
            {"password": hash_password(password), "id": user_id},
        )
    print(f"Password updated for {email}")


def _list_users(as_json: bool) -> None:
    with session_scope() as session:
        rows = session.execute(
            text(
                """
                select p.id, p.email, p.full_name, p.role::text as role, p.created_at,
                       p.onboarding_completed_at,
                       (select count(*) from public.shifts s where s.employee_id = p.id) as shifts,
                       (select count(*) from public.task_assignments ta where ta.employee_id = p.id) as tasks
                from public.profiles p
                order by lower(p.full_name), lower(p.email)
                """
            )
        ).mappings().all()
    users = [
        {
            "id": str(row["id"]),
            "email": row["email"],
            "full_name": row["full_name"],
            "role": row["role"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "onboarding_complete": row["onboarding_completed_at"] is not None,
            "shifts": int(row["shifts"] or 0),
            "tasks": int(row["tasks"] or 0),
        }
        for row in rows
    ]
    if as_json:
        print(json.dumps(users))
        return
    if not users:
        print("No accounts.")
        return
    print(f"{'EMAIL':32} {'NAME':24} {'ROLE':9} SHIFTS TASKS")
    for user in users:
        print(
            f"{user['email'][:32]:32} {user['full_name'][:24]:24} {user['role']:9} "
            f"{user['shifts']:>6} {user['tasks']:>5}"
        )


def _delete_user(email: str) -> None:
    with session_scope() as session:
        row = session.execute(
            text("select id, role::text as role from public.profiles where lower(email) = lower(:email)"),
            {"email": email},
        ).mappings().first()
        if row is None:
            raise SystemExit("No account with that email.")
        user_id = str(row["id"])
        if row["role"] == "admin":
            admins = session.execute(
                text("select count(*) from public.profiles where role = 'admin'")
            ).scalar()
            if admins is not None and int(admins) <= 1:
                raise SystemExit("Cannot delete the last administrator account.")
        for table, column in PROFILE_REFERENCES:
            session.execute(
                text(f"update public.{table} set {column} = null where {column} = :id"),
                {"id": user_id},
            )
        session.execute(text("delete from auth.users where id = :id"), {"id": user_id})
    print(json.dumps({"deleted": email.lower()}))


def _features_payload(session) -> dict[str, bool]:
    org = get_organization(session)
    config = org.get("experience_builder_config") or {}
    stored = config.get("feature_flags") if isinstance(config, dict) else {}
    return normalize_feature_flags(stored)


def _get_features(as_json: bool) -> None:
    with session_scope() as session:
        flags = _features_payload(session)
    if as_json:
        print(json.dumps(flags))
        return
    for key, value in flags.items():
        print(f"{key}={'on' if value else 'off'}")


def _set_features(raw: str) -> None:
    # Feature flags are corporate-owned; the console applies them through a
    # `set_feature_flags` command. Kept as a command so existing scripts fail
    # loudly instead of silently pretending to save.
    try:
        json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid feature JSON: {exc}") from exc
    raise SystemExit(
        "Feature flags are managed in RealtimeCorp. Turn them on or off under "
        "Policies → Site configuration; this site applies the change within seconds."
    )


def _set_org_name(raw: str) -> None:
    name = " ".join(str(raw or "").split())
    if not name:
        raise SystemExit("Organization name cannot be empty.")
    if len(name) > 120:
        raise SystemExit("Organization name must be 120 characters or fewer.")
    with session_scope() as session:
        org = get_organization(session)
        session.execute(
            text(
                "update public.organizations set name = :name, updated_at = now() where id = :id"
            ),
            {"name": name, "id": org["id"]},
        )
    print(json.dumps({"name": name}))


def main() -> None:
    parser = argparse.ArgumentParser(prog="realtimesuite", description="RealtimeSuite admin CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    admin = sub.add_parser("create-admin", help="Create the first administrator")
    admin.add_argument("--email", required=True)
    admin.add_argument("--password")
    admin.add_argument("--password-stdin", action="store_true")
    admin.add_argument("--name", default="Administrator")

    user = sub.add_parser("create-user", help="Create an employee or administrator")
    user.add_argument("--email", required=True)
    user.add_argument("--name", required=True)
    user.add_argument("--role", choices=["admin", "employee"], default="employee")
    user.add_argument("--password")
    user.add_argument("--password-stdin", action="store_true")

    delete = sub.add_parser("delete-user", help="Delete an account and its schedules")
    delete.add_argument("--email", required=True)

    listing = sub.add_parser("list-users", help="List accounts")
    listing.add_argument("--json", action="store_true")

    reset = sub.add_parser("reset-password", help="Reset an account password")
    reset.add_argument("--email", required=True)
    reset.add_argument("--password")
    reset.add_argument("--password-stdin", action="store_true")

    features = sub.add_parser("get-features", help="Print effective feature flags")
    features.add_argument("--json", action="store_true")

    set_features = sub.add_parser("set-features", help="Update feature flags from JSON on stdin")
    set_features.add_argument("--json", help="JSON object of flags (otherwise read stdin)")

    org_name = sub.add_parser("set-org-name", help="Rename the organization shown across the app")
    org_name.add_argument("--name", required=True)

    sub.add_parser("corp-sync", help="Push a snapshot to RealtimeCorp now")
    sub.add_parser(
        "corp-commands", help="Show corporate-owned changes applied to this site"
    )
    sub.add_parser("corp-apply", help="Apply pending RealtimeCorp changes now")
    sub.add_parser("init", help="Create the schema, organization and default work areas")
    sub.add_parser("describe-features", help="Print feature flag defaults as JSON")
    sub.add_parser("feature-schema", help="Print feature defaults, groups and labels as JSON")
    sub.add_parser(
        "corp-site-id", help="Print a new corporate site id and the env lines to paste"
    )
    sub.add_parser("rtlink-sync", help="Push an RTLink snapshot now")
    sub.add_parser("rtlink-pull", help="Apply pending RTLink employee actions now")
    sub.add_parser("rtlink-actions", help="Show employee actions applied from RTLink")
    sub.add_parser(
        "rtlink-site-id",
        help="Print a new RTLink site id and the env lines to paste",
    )

    args = parser.parse_args()

    if args.command == "describe-features":
        print(json.dumps(DEFAULT_FEATURE_FLAGS))
        return
    if args.command == "feature-schema":
        print(json.dumps({"defaults": DEFAULT_FEATURE_FLAGS, "groups": FEATURE_GROUPS, "meta": FEATURE_META}))
        return
    if args.command == "corp-site-id":
        from uuid import uuid4

        site_id = uuid4()
        print(site_id)
        print()
        print("Add these to backend/.env, using the company id shown in RealtimeCorp:")
        print(f"CORP_SITE_ID={site_id}")
        print("CORP_COMPANY_ID=<company id from RealtimeCorp → Sites & locations>")
        print("CORP_SUPABASE_URL=https://<project>.supabase.co")
        print("CORP_SUPABASE_SERVICE_ROLE_KEY=<service_role key>")
        return

    apply_schema()
    ensure_seed()

    if args.command == "init":
        print("Database initialized.")
        return
    if args.command == "list-users":
        _list_users(args.json)
        return
    if args.command == "delete-user":
        _delete_user(args.email)
        return
    if args.command == "get-features":
        _get_features(args.json)
        return
    if args.command == "set-features":
        _set_features(args.json if args.json is not None else sys.stdin.read())
        return
    if args.command == "set-org-name":
        _set_org_name(args.name)
        return
    if args.command == "rtlink-site-id":
        from uuid import uuid4

        site_id = uuid4()
        print(site_id)
        print()
        print("Add these to backend/.env:")
        print(f"RTLINK_SITE_ID={site_id}")
        print("RTLINK_SUPABASE_URL=https://<project>.supabase.co")
        print("RTLINK_SUPABASE_SERVICE_ROLE_KEY=<service_role key>")
        print("RTLINK_SITE_NAME=<the site name employees should see>")
        return
    if args.command == "rtlink-sync":
        from .rtlink_bridge import sync_now

        result = sync_now("cli")
        print(json.dumps(result, indent=2, default=str))
        if not result.get("ok"):
            raise SystemExit(1)
        return
    if args.command == "rtlink-pull":
        from .rtlink_bridge import run_once

        result = run_once("cli")
        print(json.dumps(result, indent=2, default=str))
        if not result.get("ok"):
            raise SystemExit(1)
        return
    if args.command == "rtlink-actions":
        from .rtlink_bridge import recent, status

        print(json.dumps({"status": status(), "recent": recent(50)}, indent=2, default=str))
        return
    if args.command == "corp-sync":
        from .corp_sync import sync_now

        result = sync_now("cli")
        print(json.dumps(result, indent=2, default=str))
        if not result.get("ok"):
            raise SystemExit(1)
        return
    if args.command == "corp-commands":
        from .corp_commands import recent, status

        print(json.dumps({"status": status(), "recent": recent(50)}, indent=2, default=str))
        return
    if args.command == "corp-apply":
        from .corp_commands import run_once

        result = run_once("cli")
        print(json.dumps(result, indent=2, default=str))
        if not result.get("ok"):
            raise SystemExit(1)
        return

    password = _read_password(args.password, getattr(args, "password_stdin", False))
    if args.command == "create-admin":
        _create_admin(args.email, password, args.name)
    elif args.command == "create-user":
        _create_user(args.email, password, args.name, args.role)
    else:
        _reset_password(args.email, password)


if __name__ == "__main__":
    main()
