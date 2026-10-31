from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    def __init__(self) -> None:
        self.database_url = os.getenv(
            "DATABASE_URL", "postgresql+psycopg://postgres@127.0.0.1:55432/suite"
        ).strip()
        self.jwt_secret = os.getenv("JWT_SECRET", "change-me-before-deploying")
        self.jwt_algorithm = os.getenv("JWT_ALGORITHM", "HS256")
        self.jwt_exp_minutes = int(os.getenv("JWT_EXP_MINUTES", "720"))
        self.host = os.getenv("HOST", "0.0.0.0")
        self.port = int(os.getenv("PORT", "8000"))
        self.cors_origins = [
            item.strip()
            for item in os.getenv(
                "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
            ).split(",")
            if item.strip()
        ]
        self.bootstrap_admin_email = os.getenv("BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
        self.bootstrap_admin_password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD", "")
        self.bootstrap_admin_name = os.getenv("BOOTSTRAP_ADMIN_NAME", "Administrator").strip()
        self.organization_name = os.getenv("ORGANIZATION_NAME", "RealtimeSuite").strip()
        self.opsboard_token = os.getenv("OPSBOARD_TOKEN", "").strip()
        self.github_token = os.getenv("GITHUB_TOKEN", "").strip()
        self.github_repos = [
            item.strip()
            for item in os.getenv("GITHUB_REPOS", "").replace(";", ",").replace("\n", ",").split(",")
            if item.strip()
        ]
        self.github_poll_minutes = max(1, int(os.getenv("GITHUB_POLL_MINUTES", "5") or 5))
        self.github_task_minutes = max(15, int(os.getenv("GITHUB_TASK_MINUTES", "60") or 60))
        self.github_api_url = os.getenv("GITHUB_API_URL", "https://api.github.com").strip().rstrip("/")
        self.app_version = "1.0.0"
        # RealtimeCorp snapshot delivery (off unless URL + key + ids are set).
        self.corp_supabase_url = os.getenv("CORP_SUPABASE_URL", "").strip().rstrip("/")
        self.corp_supabase_key = os.getenv("CORP_SUPABASE_SERVICE_ROLE_KEY", "").strip()
        self.corp_site_id = os.getenv("CORP_SITE_ID", "").strip()
        self.corp_company_id = os.getenv("CORP_COMPANY_ID", "").strip()
        self.corp_location_id = os.getenv("CORP_LOCATION_ID", "").strip()
        self.corp_site_name = os.getenv("CORP_SITE_NAME", "").strip()
        self.corp_sync_minutes = max(1, int(os.getenv("CORP_SYNC_MINUTES", "5") or 5))
        self.corp_change_sync = _bool(os.getenv("CORP_CHANGE_SYNC"), True)
        self.corp_timeout_seconds = max(5, int(os.getenv("CORP_SYNC_TIMEOUT_SECONDS", "20") or 20))
        # Corporate-owned changes (pay, roles, flags, policy) arrive as queued
        # commands; this is how often each site asks for them.
        self.corp_command_poll_seconds = max(3, int(os.getenv("CORP_COMMAND_POLL_SECONDS", "10") or 10))
        # RTLink employee companion app (off unless URL + key + site id are set).
        self.rtlink_supabase_url = os.getenv("RTLINK_SUPABASE_URL", "").strip().rstrip("/")
        self.rtlink_supabase_key = os.getenv("RTLINK_SUPABASE_SERVICE_ROLE_KEY", "").strip()
        self.rtlink_site_id = os.getenv("RTLINK_SITE_ID", "").strip()
        self.rtlink_site_name = os.getenv("RTLINK_SITE_NAME", "").strip()
        self.rtlink_sync_minutes = max(1, int(os.getenv("RTLINK_SYNC_MINUTES", "5") or 5))
        self.rtlink_change_sync = _bool(os.getenv("RTLINK_CHANGE_SYNC"), True)
        self.rtlink_poll_seconds = max(3, int(os.getenv("RTLINK_POLL_SECONDS", "15") or 15))
        self.rtlink_timeout_seconds = max(5, int(os.getenv("RTLINK_SYNC_TIMEOUT_SECONDS", "20") or 20))
        self.upload_dir = Path(os.getenv("UPLOAD_DIR", str(BACKEND_DIR / "uploads")))
        self.smtp_host = os.getenv("SMTP_HOST", "").strip()
        self.smtp_port = int(os.getenv("SMTP_PORT", "587"))
        self.smtp_username = os.getenv("SMTP_USERNAME", "").strip()
        self.smtp_password = os.getenv("SMTP_PASSWORD", "")
        self.smtp_from = os.getenv("SMTP_FROM", "realtimesuite@localhost").strip()
        self.smtp_use_tls = _bool(os.getenv("SMTP_USE_TLS"), True)
        self.schema_file = BACKEND_DIR / "sql" / "001_schema.sql"
        self.frontend_dist = Path(
            os.getenv("FRONTEND_DIST", str(BACKEND_DIR.parent / "frontend" / "dist"))
        )

    @property
    def github_enabled(self) -> bool:
        return bool(self.github_token and self.github_repos)

    @property
    def rtlink_enabled(self) -> bool:
        return bool(
            self.rtlink_supabase_url
            and self.rtlink_supabase_key
            and self.rtlink_site_id
        )

    @property
    def corp_enabled(self) -> bool:
        return bool(
            self.corp_supabase_url
            and self.corp_supabase_key
            and self.corp_site_id
            and self.corp_company_id
        )


settings = Settings()
