from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from .config import settings
from .db import apply_additions, apply_schema, ensure_seed, session_scope
from .github_sync import sync_pull_requests
from .routers import (
    auth,
    board_notes,
    comms,
    discipline,
    employees,
    integrations,
    nullifications,
    opsboard,
    reports,
    staff_requests,
    settings as settings_router,
    shifts,
    system,
    tasks,
    training,
)

logger = logging.getLogger("realtimesuite")

_stop = threading.Event()


def _run_jobs() -> None:
    with session_scope() as session:
        for fn in (
            "select public.process_due_shift_break_resumes()",
            "select public.process_due_shift_auto_clock_outs()",
        ):
            try:
                session.execute(text(fn))
                session.commit()
            except Exception:  # noqa: BLE001 - keep the scheduler alive
                session.rollback()
    with session_scope() as session:
        user_ids = [
            str(row[0])
            for row in session.execute(text("select id from public.profiles")).all()
        ]
    for user_id in user_ids:
        try:
            with session_scope(user_id, "authenticated") as session:
                session.execute(
                    text("select public.enqueue_my_shift_start_notifications(60)")
                )
        except Exception:  # noqa: BLE001
            continue


def _scheduler_loop() -> None:
    while not _stop.wait(30):
        try:
            _run_jobs()
        except Exception:  # noqa: BLE001
            logger.exception("scheduler tick failed")


def _github_loop() -> None:
    """Mirror configured GitHub pull requests into tasks on a fixed interval."""
    interval = max(60, settings.github_poll_minutes * 60)
    while not _stop.is_set():
        if settings.github_enabled:
            try:
                result = sync_pull_requests()
                for error in result.get("errors", []):
                    logger.warning("GitHub sync: %s", error)
            except Exception:  # noqa: BLE001 - keep the poller alive
                logger.exception("GitHub pull request sync failed")
        if _stop.wait(interval):
            break


@asynccontextmanager
async def lifespan(_: FastAPI):
    apply_schema()
    apply_additions()
    ensure_seed()
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    thread = threading.Thread(target=_scheduler_loop, name="suite-scheduler", daemon=True)
    thread.start()
    if settings.github_enabled:
        github_thread = threading.Thread(target=_github_loop, name="github-sync", daemon=True)
        github_thread.start()
    yield
    _stop.set()


app = FastAPI(title="RealtimeSuite", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(DBAPIError)
async def db_error_handler(_: Request, exc: DBAPIError) -> JSONResponse:
    message = "Request failed."
    orig = getattr(exc, "orig", None)
    if orig is not None and getattr(orig, "diag", None) is not None:
        message = orig.diag.message_primary or str(orig)
    elif orig is not None:
        message = str(orig)
    return JSONResponse(status_code=400, content={"detail": message})


for router in (
    system.router,
    auth.router,
    settings_router.router,
    employees.router,
    shifts.router,
    tasks.router,
    nullifications.router,
    staff_requests.router,
    comms.router,
    training.router,
    discipline.router,
    integrations.router,
    reports.router,
    opsboard.router,
    board_notes.router,
):
    app.include_router(router)

uploads_dir = settings.upload_dir
uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=uploads_dir), name="uploads")

dist_dir = Path(settings.frontend_dist)
if dist_dir.is_dir():
    app.mount("/", StaticFiles(directory=dist_dir, html=True), name="frontend")
else:

    @app.get("/")
    def missing_frontend() -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={
                "detail": "Frontend build not found. Run `npm install && npm run build` in frontend/."
            },
        )
