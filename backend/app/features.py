DEFAULT_FEATURE_FLAGS: dict[str, bool] = {
    # Scheduling
    "shifts": True,
    "tasks": True,
    "shift_pool": True,
    "auto_assign": True,
    "breaks": True,
    "time_off": True,
    "exceptions": True,
    "overtime": True,
    "shift_swaps": True,
    "clock_in": True,
    "unscheduled_clock_in": True,
    "geofence_clock_in": False,
    "task_acknowledgements": True,
    # People
    "roster": True,
    "payroll": True,
    "discipline": True,
    "onboarding": True,
    "training": True,
    "work_preferences": True,
    # Communication
    "messages": True,
    "notifications": True,
    "announcements": True,
    # Insight
    "reports": True,
    "clock_in_audit": True,
    "live_board": True,
    "employee_portal": True,
}

FEATURE_META: dict[str, dict[str, str]] = {
    "shifts": {"label": "Shift scheduling", "description": "Create and edit shifts on the operations board."},
    "tasks": {"label": "Task assignment", "description": "Assign tasks and show them on the timeline."},
    "shift_pool": {"label": "Shift pool", "description": "Post open shifts for employees to claim."},
    "auto_assign": {"label": "Auto-assign", "description": "Generate shift plans and fill them automatically."},
    "breaks": {"label": "Break tasks", "description": "Create break tasks from a shift."},
    "time_off": {"label": "Time off", "description": "Time-off requests and approvals."},
    "exceptions": {"label": "Exceptions", "description": "Attendance and task exception requests."},
    "overtime": {"label": "Overtime", "description": "Overtime offers, requests and approvals."},
    "shift_swaps": {"label": "Shift swaps", "description": "Employee-to-employee swap requests."},
    "clock_in": {"label": "Clock in / out", "description": "Let employees punch their scheduled shifts."},
    "unscheduled_clock_in": {"label": "Unscheduled clock-in", "description": "Allow clocking in without a scheduled shift."},
    "geofence_clock_in": {"label": "Location clock-in", "description": "Require clock-ins at a configured location."},
    "task_acknowledgements": {"label": "Task acknowledgements", "description": "Employees confirm they have seen a task."},
    "roster": {"label": "Employee roster", "description": "Roster view with assignments and contact details."},
    "payroll": {"label": "Pay rates", "description": "Hourly rates and pay-rate editing."},
    "discipline": {"label": "Discipline", "description": "Discipline actions and pay-rate consequences."},
    "onboarding": {"label": "Onboarding", "description": "First-login onboarding steps and acknowledgements."},
    "training": {"label": "Training", "description": "Training courses and assigned training."},
    "work_preferences": {"label": "Work preferences", "description": "Weekly hour limits and availability preferences."},
    "messages": {"label": "Messages", "description": "Admin-to-employee messages."},
    "notifications": {"label": "Notifications", "description": "In-app notification feed in the header."},
    "announcements": {"label": "Announcements", "description": "Announcements shown in the header and kiosk."},
    "reports": {"label": "Reports", "description": "Attendance, task and payroll reporting."},
    "clock_in_audit": {"label": "Clock-in audit", "description": "Review punch records and discrepancies."},
    "live_board": {"label": "Live board", "description": "Kiosk operations board at /opsboard.html."},
    "employee_portal": {"label": "Employee portal", "description": "Employees can view shifts, tasks and requests."},
}


FEATURE_GROUPS: dict[str, list[str]] = {
    "Scheduling": [
        "shifts",
        "tasks",
        "shift_pool",
        "auto_assign",
        "breaks",
        "time_off",
        "exceptions",
        "overtime",
        "shift_swaps",
        "clock_in",
        "unscheduled_clock_in",
        "geofence_clock_in",
        "task_acknowledgements",
    ],
    "People": [
        "roster",
        "payroll",
        "discipline",
        "onboarding",
        "training",
        "work_preferences",
    ],
    "Communication": ["messages", "notifications", "announcements"],
    "Insight": ["reports", "clock_in_audit", "live_board", "employee_portal"],
}


def normalize_feature_flags(value: object) -> dict[str, bool]:
    stored = value if isinstance(value, dict) else {}
    return {
        key: bool(stored[key]) if isinstance(stored.get(key), bool) else default
        for key, default in DEFAULT_FEATURE_FLAGS.items()
    }
