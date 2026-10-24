from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import psycopg
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .security import hash_password

engine = create_engine(settings.database_url, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


def psycopg_dsn() -> str:
    return settings.database_url.replace("postgresql+psycopg://", "postgresql://", 1)


def apply_schema() -> None:
    """Create the application schema on an empty database."""
    with engine.connect() as conn:
        exists = conn.execute(
            text("select to_regclass('public.profiles') is not null")
        ).scalar()
    if exists:
        return
    sql = settings.schema_file.read_text(encoding="utf-8")
    with psycopg.connect(psycopg_dsn(), autocommit=True) as conn:
        conn.execute(sql)


def apply_additions() -> None:
    """Apply idempotent additions to databases created before they existed."""
    sql_dir = settings.schema_file.parent
    if not sql_dir.is_dir():
        return
    # The base schema file is applied by apply_schema(); everything else in the folder
    # is an idempotent addition and must run in filename order on every startup so a
    # database created before a column existed picks it up.
    additions = sorted(
        path for path in sql_dir.glob("*.sql") if path.name != settings.schema_file.name
    )
    if not additions:
        return
    with psycopg.connect(psycopg_dsn(), autocommit=True) as conn:
        for additions_file in additions:
            conn.execute(additions_file.read_text(encoding="utf-8"))


def _set_actor(session: Session, user_id: str | None, role: str | None = None) -> None:
    if not user_id:
        return
    session.execute(
        text("select set_config('request.jwt.claim.sub', :sub, true)"),
        {"sub": str(user_id)},
    )
    session.execute(
        text("select set_config('request.jwt.claim.role', :role, true)"),
        {"role": role or "authenticated"},
    )


@contextmanager
def session_scope(user_id: str | None = None, role: str | None = None) -> Iterator[Session]:
    session = SessionLocal()
    try:
        _set_actor(session, user_id, role)
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_db_unauthenticated() -> Iterator[Session]:
    with session_scope() as session:
        yield session


def row_to_dict(row) -> dict:
    return dict(row) if row is not None else {}


def get_organization(session: Session) -> dict:
    row = session.execute(
        text("select * from public.organizations order by created_at limit 1")
    ).mappings().first()
    if row is None:
        raise RuntimeError("No organization configured. Run the bootstrap step.")
    return dict(row)


def ensure_seed() -> None:
    """Create the single organization, default work areas and first admin."""
    with session_scope() as session:
        org = session.execute(
            text("select id from public.organizations order by created_at limit 1")
        ).scalar()

        if org is None:
            org = session.execute(
                text(
                    """
                    insert into public.organizations
                      (name, admin_portal_label, login_heading, login_subheading,
                       onboarding_title, onboarding_description,
                       onboarding_required_acknowledgements, onboarding_custom_questions)
                    values
                      (:name, 'OPERATIONS CENTER', 'RealtimeSuite', 'Scheduling and Time Operations',
                       'Welcome to RealtimeSuite',
                       'Complete these steps so your administrator knows you are ready to work.',
                       array['I have read the employee handbook.',
                             'I understand the attendance and clock-in policy.'],
                       '[]'::jsonb)
                    returning id
                    """
                ),
                {"name": settings.organization_name or "RealtimeSuite"},
            ).scalar()

            # Work areas seeded by the base schema predate organizations.
            session.execute(
                text("update public.work_areas set organization_id = :org where organization_id is null"),
                {"org": org},
            )
        else:
            session.execute(
                text(
                    """
                    update public.organizations
                    set login_heading = case when login_heading in ('', 'WaterSuite') then 'RealtimeSuite' else login_heading end,
                        login_subheading = case when login_subheading in ('', 'Employee and Resource Operations') then 'Scheduling and Time Operations' else login_subheading end
                    where id = :org
                    """
                ),
                {"org": org},
            )

        for name, description, color in [
            ("Operations", "Operations floor", "#86d56e"),
            ("Management", "Management coverage", "#7bb7ea"),
        ]:
            exists = session.execute(
                text("select 1 from public.work_areas where name = :name"),
                {"name": name},
            ).scalar()
            if not exists:
                session.execute(
                    text(
                        """
                        insert into public.work_areas (name, description, color, organization_id)
                        values (:name, :description, :color, :org)
                        """
                    ),
                    {"name": name, "description": description, "color": color, "org": org},
                )

        has_user = session.execute(text("select exists (select 1 from public.profiles)")).scalar()
        if not has_user and settings.bootstrap_admin_password:
            email = (settings.bootstrap_admin_email or "admin@realtimesuite.local").lower()
            user_id = session.execute(
                text(
                    """
                    insert into auth.users (email, encrypted_password)
                    values (:email, :password)
                    returning id
                    """
                ),
                {"email": email, "password": hash_password(settings.bootstrap_admin_password)},
            ).scalar()
            session.execute(
                text(
                    """
                    insert into public.profiles (id, email, full_name, role, organization_id)
                    values (:id, :email, :name, 'admin', :org)
                    """
                ),
                {
                    "id": user_id,
                    "email": email,
                    "name": settings.bootstrap_admin_name or "Administrator",
                    "org": org,
                },
            )


def create_user(email: str, password: str, full_name: str, role: str = "employee") -> str:
    with session_scope() as session:
        org = get_organization(session)["id"]
        existing = session.execute(
            text("select id from public.profiles where lower(email) = lower(:email)"),
            {"email": email},
        ).scalar()
        if existing:
            raise ValueError("An account with that email already exists.")
        user_id = session.execute(
            text("insert into auth.users (email, encrypted_password) values (:email, :password) returning id"),
            {"email": email.lower(), "password": hash_password(password)},
        ).scalar()
        session.execute(
            text(
                """
                insert into public.profiles (id, email, full_name, role, organization_id)
                values (:id, :email, :full_name, cast(:role as public.app_role), :org)
                """
            ),
            {
                "id": user_id,
                "email": email.lower(),
                "full_name": full_name,
                "role": role,
                "org": org,
            },
        )
        return str(user_id)
