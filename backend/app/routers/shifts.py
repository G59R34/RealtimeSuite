from __future__ import annotations

import calendar
import hashlib
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..db import get_organization
from ..deps import (
    RequestUser,
    get_current_user,
    get_db,
    is_effective_admin,
    require_admin,
    require_manager,
)

router = APIRouter(prefix="/api", tags=["shifts"])

SHIFT_COLUMNS = """
  s.id, s.employee_id, s.work_area_id, s.start_at, s.end_at, s.status::text as status,
  s.clocked_in_at, s.clocked_out_at, s.clock_in_latitude, s.clock_in_longitude,
  s.clock_in_accuracy_meters, s.clock_in_device, s.clock_in_is_mobile,
  s.is_unscheduled_overtime, s.pay_multiplier, s.worked_minutes, s.break_minutes,
  s.is_shift_pool, s.shift_pool_posted_at, s.shift_pool_posted_by,
  s.shift_pool_claimed_at, s.shift_pool_claimed_by, s.notes,
  s.created_by, s.updated_by, s.created_at, s.updated_at
"""


def _local_datetime(day: date, value: str) -> datetime:
    parsed = time.fromisoformat(value if len(value) > 5 else f"{value}:00")
    return datetime.combine(day, parsed).astimezone()


def _month_days(value: str) -> list[date]:
    year, month = (int(part) for part in value.split("-")[:2])
    days = calendar.monthrange(year, month)[1]
    return [date(year, month, day) for day in range(1, days + 1)]


def _day_bounds(value: str) -> tuple[datetime, datetime]:
    day = date.fromisoformat(value)
    start = datetime.combine(day, time.min).astimezone()
    return start, start + timedelta(days=1)


def _month_bounds(value: str) -> tuple[datetime, datetime]:
    year, month = (int(part) for part in value.split("-")[:2])
    start = datetime(year, month, 1).astimezone()
    end = datetime(year + (1 if month == 12 else 0), 1 if month == 12 else month + 1, 1).astimezone()
    return start, end


def _shift_rows(session: Session, start: datetime, end: datetime) -> list[dict]:
    rows = session.execute(
        text(
            f"""
            select {SHIFT_COLUMNS}
            from public.shifts s
            where s.start_at >= :start and s.start_at < :end
            order by s.start_at, s.employee_id
            """
        ),
        {"start": start, "end": end},
    ).mappings().all()
    return [dict(row) for row in rows]


@router.get("/work-areas")
def list_work_areas(session: Session = Depends(get_db)) -> list[dict]:
    rows = session.execute(
        text("select * from public.work_areas order by name")
    ).mappings().all()
    return [dict(row) for row in rows]


@router.post("/work-areas")
def create_work_area(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    name = str(payload.get("name", "")).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Work area name is required.")
    color = str(payload.get("color", "#86d56e")).strip() or "#86d56e"
    if len(color) != 7 or not color.startswith("#"):
        raise HTTPException(status_code=400, detail="Color must be a hex value like #86d56e.")
    org = get_organization(session)
    row = session.execute(
        text(
            """
            insert into public.work_areas (name, description, color, organization_id, created_by)
            values (:name, :description, :color, :org, :actor)
            returning *
            """
        ),
        {
            "name": name,
            "description": str(payload.get("description", "")),
            "color": color,
            "org": org["id"],
            "actor": user.id,
        },
    ).mappings().first()
    return dict(row)


@router.get("/shifts")
def list_shifts(
    selected_date: str | None = Query(default=None, alias="date"),
    from_value: str | None = Query(default=None, alias="from"),
    to_value: str | None = Query(default=None, alias="to"),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> list[dict]:
    if not is_effective_admin(session, user):
        raise HTTPException(status_code=403, detail="Admin access required.")
    if from_value and to_value:
        start = datetime.fromisoformat(from_value).astimezone()
        end = datetime.fromisoformat(to_value).astimezone()
    else:
        start, end = _day_bounds(selected_date or date.today().isoformat())
    return _shift_rows(session, start, end)


@router.post("/shifts")
def upsert_shift(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    shift_id = payload.get("shift_id")
    params = {
        "employee_id": payload.get("employee_id"),
        "work_area_id": payload.get("work_area_id"),
        "start_at": payload.get("start_at"),
        "end_at": payload.get("end_at"),
        "status": payload.get("status", "scheduled"),
        "break_minutes": int(payload.get("break_minutes", 30)),
        "notes": payload.get("notes", ""),
    }
    if shift_id:
        session.execute(
            text(
                """
                select public.admin_update_shift_live(
                  :shift_id, :employee_id, :work_area_id, :start_at, :end_at,
                  cast(:status as public.shift_status), :break_minutes, :notes
                )
                """
            ),
            {**params, "shift_id": shift_id},
        )
        return {"ok": True, "id": shift_id}

    org = get_organization(session)
    row = session.execute(
        text(
            """
            insert into public.shifts
              (organization_id, employee_id, work_area_id, start_at, end_at,
               status, break_minutes, notes, is_unscheduled_overtime, created_by, updated_by)
            values
              (:org, :employee_id, :work_area_id, :start_at, :end_at,
               cast(:status as public.shift_status), :break_minutes, :notes,
               :is_unscheduled, :actor, :actor)
            returning id
            """
        ),
        {
            **params,
            "org": org["id"],
            "is_unscheduled": bool(payload.get("is_unscheduled_overtime", False)),
            "actor": user.id,
        },
    ).scalar()
    return {"ok": True, "id": str(row)}


@router.delete("/shifts/{shift_id}")
def delete_shift(
    shift_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    session.execute(text("delete from public.shifts where id = :id"), {"id": shift_id})
    return {"ok": True}


@router.post("/shifts/month/reset")
def reset_month(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    start, end = _month_bounds(str(payload.get("date", date.today().isoformat())))
    shift_ids = [
        str(row[0])
        for row in session.execute(
            text("select id from public.shifts where start_at >= :start and start_at < :end"),
            {"start": start, "end": end},
        ).all()
    ]
    if not shift_ids:
        return {"deleted": 0}
    session.execute(
        text("delete from public.task_assignments where task_id in (select id from public.tasks where shift_id = any(:ids))"),
        {"ids": shift_ids},
    )
    session.execute(text("delete from public.tasks where shift_id = any(:ids)"), {"ids": shift_ids})
    session.execute(text("delete from public.shifts where id = any(:ids)"), {"ids": shift_ids})
    return {"deleted": len(shift_ids)}


@router.patch("/shifts/{shift_id}/work-area")
def update_shift_work_area(
    shift_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    session.execute(
        text("select public.update_shift_work_area(:id, :area)"),
        {"id": shift_id, "area": payload.get("work_area_id")},
    )
    return {"ok": True}


@router.post("/shifts/{shift_id}/clock-in")
def admin_clock_in(
    shift_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    session.execute(
        text(
            """
            update public.shifts
            set status = 'on_duty', clocked_in_at = now(), clocked_out_at = null,
                updated_by = :actor
            where id = :id
            """
        ),
        {"id": shift_id, "actor": user.id},
    )
    return {"ok": True}


@router.post("/shifts/{shift_id}/clock-out")
def admin_clock_out(
    shift_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    row = session.execute(
        text("select start_at, is_unscheduled_overtime from public.shifts where id = :id"),
        {"id": shift_id},
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Shift not found.")
    now = datetime.now(tz=timezone.utc)
    end_at = max(row["start_at"], now) if row["is_unscheduled_overtime"] else None
    session.execute(
        text(
            """
            update public.shifts
            set status = 'off_shift', clocked_out_at = :now,
                end_at = coalesce(:end_at, end_at), updated_by = :actor
            where id = :id
            """
        ),
        {"now": now, "end_at": end_at, "actor": user.id, "id": shift_id},
    )
    return {"ok": True}


@router.post("/shifts/{shift_id}/break")
def assign_break(
    shift_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_manager(session, user)
    task_id = session.execute(
        text("select public.assign_shift_break_task(:id, :minutes, :note)"),
        {
            "id": shift_id,
            "minutes": max(1, int(payload.get("break_minutes", 30))),
            "note": str(payload.get("note", "")),
        },
    ).scalar()
    return {"task_id": str(task_id) if task_id else None}


@router.post("/shifts/auto-assign")
def auto_assign(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    mode = str(payload.get("mode", "day"))
    date_value = str(payload.get("date", date.today().isoformat()))
    if mode == "month":
        created = _auto_assign_month(session, user, payload)
    else:
        created = _auto_assign_day(session, user, payload, date_value)
    return {"created": created}


def _auto_assign_day(session: Session, user: RequestUser, payload: dict, date_value: str) -> int:
    day = date.fromisoformat(date_value)
    start = datetime.combine(day, time.min).astimezone()
    end = start + timedelta(days=1)
    employees = [
        str(row[0])
        for row in session.execute(
            text("select id from public.profiles where role = 'employee' order by full_name")
        ).all()
    ]
    areas = [
        str(row[0])
        for row in session.execute(
            text("select id from public.work_areas where is_active order by name")
        ).all()
    ]
    existing = {
        str(row[0])
        for row in session.execute(
            text("select employee_id from public.shifts where start_at >= :start and start_at < :end and employee_id is not null"),
            {"start": start, "end": end},
        ).all()
    }
    missing = [emp for emp in employees if emp not in existing]
    if not missing:
        return 0
    org = get_organization(session)
    start_at = _local_datetime(day, str(payload.get("start_time", "08:00")))
    end_at = _local_datetime(day, str(payload.get("end_time", "16:00")))
    if end_at <= start_at:
        end_at += timedelta(days=1)
    preferred = payload.get("preferred_work_area_id")
    rows = []
    for index, employee_id in enumerate(missing):
        work_area_id = preferred or (areas[index % len(areas)] if areas else None)
        rows.append(
            {
                "org": org["id"],
                "employee_id": employee_id,
                "work_area_id": work_area_id,
                "start_at": start_at,
                "end_at": end_at,
                "status": str(payload.get("status", "scheduled")),
                "break_minutes": int(payload.get("break_minutes", 30)),
                "notes": str(payload.get("notes", "")),
                "actor": user.id,
            }
        )
    session.execute(
        text(
            """
            insert into public.shifts
              (organization_id, employee_id, work_area_id, start_at, end_at, status,
               break_minutes, notes, created_by, updated_by)
            values
              (:org, :employee_id, :work_area_id, :start_at, :end_at,
               cast(:status as public.shift_status), :break_minutes, :notes, :actor, :actor)
            """
        ),
        rows,
    )
    return len(rows)


def _auto_assign_month(session: Session, user: RequestUser, payload: dict) -> int:
    date_value = str(payload.get("date", date.today().isoformat()))
    days = _month_days(date_value)
    start, end = _month_bounds(date_value)
    employees = [
        str(row[0])
        for row in session.execute(
            text("select id from public.profiles where role = 'employee' order by full_name")
        ).all()
    ]
    if not employees:
        return 0
    areas = [
        str(row[0])
        for row in session.execute(
            text("select id from public.work_areas where is_active order by name")
        ).all()
    ]
    existing_shift_rows = session.execute(
        text(
            "select employee_id, start_at from public.shifts where start_at >= :start and start_at < :end and employee_id is not null"
        ),
        {"start": start, "end": end},
    ).all()
    existing_keys = {
        f"{row[0]}|{row[1].astimezone().date().isoformat()}" for row in existing_shift_rows
    }

    templates = [
        {
            "start": str(item.get("startTime", "")),
            "end": str(item.get("endTime", "")),
            "headcount": max(0, int(item.get("headcount", 0))),
            "break_minutes": int(item.get("breakMinutes", payload.get("break_minutes", 30))),
        }
        for item in (payload.get("shift_templates") or [])
    ]
    templates = [item for item in templates if item["start"] and item["end"] and item["headcount"] > 0]

    base_start = _local_datetime(days[0], str(payload.get("start_time", "08:00")))
    base_end = _local_datetime(days[0], str(payload.get("end_time", "16:00")))
    if base_end <= base_start:
        base_end += timedelta(days=1)
    shift_minutes = int((base_end - base_start).total_seconds() // 60)
    work_minutes = max(1, shift_minutes - int(payload.get("break_minutes", 30)))

    weekly_target = max(0.0, float(payload.get("weekly_hours_target", 40) or 0))
    rdo_days = min(6, max(0, int(payload.get("rdo_days_per_week", 2) or 0)))
    max_by_hours = min(7, int((weekly_target * 60) // work_minutes)) if work_minutes else 0
    max_by_rdo = 7 - rdo_days
    shifts_per_week = max(0, min(max_by_hours, max_by_rdo)) if not templates else 0
    effective_rdo = 7 - shifts_per_week

    demand = [0.55, 0.78, 0.92, 1.0, 0.98, 0.88, 0.62]
    staggers = [-90, -60, -30, 0, 30, 60, 90]
    org = get_organization(session)
    preferred = payload.get("preferred_work_area_id")
    area_offset = 0
    rows = []

    def hash_seed(value: str) -> int:
        return int(hashlib.md5(value.encode()).hexdigest()[:8], 16)

    for day_index, day in enumerate(days):
        week_index = day_index // 7
        day_of_week = day.weekday()  # Monday=0 .. Sunday=6
        demand_factor = demand[day_of_week]
        candidates = []
        for employee_index, employee_id in enumerate(employees):
            key = f"{employee_id}|{day.isoformat()}"
            if key in existing_keys:
                continue
            if not templates and effective_rdo > 0:
                off_start = (employee_index + week_index) % 7
                if any((off_start + offset) % 7 == day_of_week for offset in range(effective_rdo)):
                    continue
            candidates.append(employee_id)
        if not candidates:
            continue

        ranked = sorted(candidates, key=lambda emp: hash_seed(f"{day.isoformat()}|{emp}"))

        if templates:
            ranked_index = 0
            for template in templates:
                for _slot in range(template["headcount"]):
                    if ranked_index >= len(ranked):
                        break
                    employee_id = ranked[ranked_index]
                    ranked_index += 1
                    key = f"{employee_id}|{day.isoformat()}"
                    if key in existing_keys:
                        continue
                    work_area_id = preferred or (areas[area_offset % len(areas)] if areas else None)
                    area_offset += 1
                    shift_start = _local_datetime(day, template["start"])
                    shift_end = _local_datetime(day, template["end"])
                    if shift_end <= shift_start:
                        shift_end += timedelta(days=1)
                    rows.append(
                        {
                            "org": org["id"],
                            "employee_id": employee_id,
                            "work_area_id": work_area_id,
                            "start_at": shift_start,
                            "end_at": shift_end,
                            "status": str(payload.get("status", "scheduled")),
                            "break_minutes": template["break_minutes"],
                            "notes": f"{payload.get('notes', '')} | slot {template['start']}-{template['end']}".strip(" |"),
                            "actor": user.id,
                        }
                    )
                    existing_keys.add(key)
            continue

        target_count = max(1, min(len(candidates), round(len(candidates) * demand_factor)))
        for employee_id in ranked[:target_count]:
            work_area_id = preferred or (areas[area_offset % len(areas)] if areas else None)
            area_offset += 1
            offset_minutes = staggers[hash_seed(f"{day.isoformat()}|{employee_id}|{work_area_id or ''}") % len(staggers)]
            shift_start = base_start.replace(year=day.year, month=day.month, day=day.day) + timedelta(minutes=offset_minutes)
            shift_end = shift_start + timedelta(minutes=shift_minutes)
            rows.append(
                {
                    "org": org["id"],
                    "employee_id": employee_id,
                    "work_area_id": work_area_id,
                    "start_at": shift_start,
                    "end_at": shift_end,
                    "status": str(payload.get("status", "scheduled")),
                    "break_minutes": int(payload.get("break_minutes", 30)),
                    "notes": str(payload.get("notes", "")),
                    "actor": user.id,
                }
            )
            existing_keys.add(f"{employee_id}|{day.isoformat()}")

    if not rows:
        return 0
    session.execute(
        text(
            """
            insert into public.shifts
              (organization_id, employee_id, work_area_id, start_at, end_at, status,
               break_minutes, notes, created_by, updated_by)
            values
              (:org, :employee_id, :work_area_id, :start_at, :end_at,
               cast(:status as public.shift_status), :break_minutes, :notes, :actor, :actor)
            """
        ),
        rows,
    )
    return len(rows)


@router.post("/shifts/pool")
def create_pool(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    date_value = str(payload.get("date", date.today().isoformat()))
    openings = max(1, int(payload.get("openings_per_day", 1)))
    start_time = str(payload.get("start_time", "08:00"))
    end_time = str(payload.get("end_time", "16:00"))
    work_area_id = payload.get("work_area_id")
    break_minutes = max(0, int(payload.get("break_minutes", 30)))
    notes = str(payload.get("notes", ""))
    org = get_organization(session)
    created = 0
    for day in _month_days(date_value):
        start_at = _local_datetime(day, start_time)
        end_at = _local_datetime(day, end_time)
        if end_at <= start_at:
            end_at += timedelta(days=1)
        existing = session.execute(
            text(
                """
                select count(*) from public.shifts
                where is_shift_pool and start_at = :start and end_at = :end
                  and work_area_id is not distinct from :area
                """
            ),
            {"start": start_at, "end": end_at, "area": work_area_id},
        ).scalar() or 0
        for _ in range(max(0, openings - int(existing))):
            session.execute(
                text(
                    """
                    insert into public.shifts
                      (organization_id, employee_id, work_area_id, start_at, end_at, status,
                       break_minutes, notes, is_shift_pool, shift_pool_posted_at,
                       shift_pool_posted_by, created_by, updated_by)
                    values
                      (:org, null, :area, :start, :end, 'scheduled', :break_minutes, :notes,
                       true, now(), :actor, :actor, :actor)
                    """
                ),
                {
                    "org": org["id"],
                    "area": work_area_id,
                    "start": start_at,
                    "end": end_at,
                    "break_minutes": break_minutes,
                    "notes": notes,
                    "actor": user.id,
                },
            )
            created += 1
    return {"created": created}


@router.post("/shifts/{shift_id}/pool")
def set_pool_status(
    shift_id: str,
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    require_admin(session, user)
    session.execute(
        text("select public.set_shift_pool_status(:id, :enable)"),
        {"id": shift_id, "enable": bool(payload.get("enabled", True))},
    )
    return {"ok": True}


@router.post("/shifts/{shift_id}/claim")
def claim_shift(
    shift_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    session.execute(text("select public.claim_shift_pool_shift(:id)"), {"id": shift_id})
    return {"ok": True}


@router.post("/shifts/{shift_id}/clock-in-own")
def clock_in_own(
    shift_id: str,
    payload: dict = Body(default={}),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    location = payload or {}
    coords = (
        location.get("latitude") is not None and location.get("longitude") is not None
    )
    if location.get("isMobile") and coords:
        org = get_organization(session)
        verification = session.execute(
            text(
                """
                select * from public.verify_clock_in_location(
                  :org, :shift, :lat, :lon, :accuracy, false
                )
                """
            ),
            {
                "org": org["id"],
                "shift": shift_id,
                "lat": location.get("latitude"),
                "lon": location.get("longitude"),
                "accuracy": location.get("accuracyMeters"),
            },
        ).mappings().first()
        if verification and not verification["is_allowed"]:
            raise HTTPException(status_code=400, detail=verification["message"] or "Clock-in denied by location policy.")
    session.execute(
        text(
            """
            select public.clock_in_shift(
              :shift, :lat, :lon, :accuracy, :device, :is_mobile
            )
            """
        ),
        {
            "shift": shift_id,
            "lat": location.get("latitude") if coords else None,
            "lon": location.get("longitude") if coords else None,
            "accuracy": location.get("accuracyMeters"),
            "device": location.get("device"),
            "is_mobile": location.get("isMobile"),
        },
    )
    return {"ok": True}


@router.post("/shifts/{shift_id}/clock-out-own")
def clock_out_own(
    shift_id: str,
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    session.execute(text("select public.clock_out_shift(:id)"), {"id": shift_id})
    return {"ok": True}


@router.post("/shifts/clock-in-unscheduled")
def clock_in_unscheduled(
    payload: dict = Body(default={}),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    location = payload or {}
    coords = location.get("latitude") is not None and location.get("longitude") is not None
    if location.get("isMobile") and coords:
        org = get_organization(session)
        verification = session.execute(
            text(
                """
                select * from public.verify_clock_in_location(
                  :org, null, :lat, :lon, :accuracy, true
                )
                """
            ),
            {
                "org": org["id"],
                "lat": location.get("latitude"),
                "lon": location.get("longitude"),
                "accuracy": location.get("accuracyMeters"),
            },
        ).mappings().first()
        if verification and not verification["is_allowed"]:
            raise HTTPException(status_code=400, detail=verification["message"] or "Clock-in denied by location policy.")
    session.execute(
        text(
            """
            select public.clock_in_unscheduled_shift(
              :note, :lat, :lon, :accuracy, :device, :is_mobile
            )
            """
        ),
        {
            "note": str(location.get("note", "")),
            "lat": location.get("latitude") if coords else None,
            "lon": location.get("longitude") if coords else None,
            "accuracy": location.get("accuracyMeters"),
            "device": location.get("device"),
            "is_mobile": location.get("isMobile"),
        },
    )
    return {"ok": True}


@router.post("/shifts/verify-location")
def verify_location(
    payload: dict = Body(...),
    user: RequestUser = Depends(get_current_user),
    session: Session = Depends(get_db),
) -> dict:
    org = get_organization(session)
    row = session.execute(
        text(
            """
            select * from public.verify_clock_in_location(
              :org, :shift, :lat, :lon, :accuracy, :unscheduled
            )
            """
        ),
        {
            "org": org["id"],
            "shift": payload.get("shift_id"),
            "lat": payload.get("latitude"),
            "lon": payload.get("longitude"),
            "accuracy": payload.get("accuracyMeters"),
            "unscheduled": bool(payload.get("isUnscheduled", False)),
        },
    ).mappings().first()
    return {
        "isAllowed": bool(row["is_allowed"]) if row else False,
        "message": row["message"] if row else "Location could not be verified.",
        "distanceMeters": float(row["distance_meters"]) if row and row["distance_meters"] is not None else None,
        "locationName": row["location_name"] if row else None,
    }
