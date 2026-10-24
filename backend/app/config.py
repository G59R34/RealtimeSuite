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


settings = Settings()
