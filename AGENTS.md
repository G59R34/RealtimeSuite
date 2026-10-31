# AGENTS.md — RealtimeSuite

Working guide for anyone (human or AI agent) changing this repository. It explains what
each part does, how the pieces talk to each other, and the rules that keep existing
installations working.

---

## 1. What this project is

RealtimeSuite is a **LAN-hosted workforce scheduling and time-operations suite** for a
single organization:

- **Backend** — FastAPI + SQLAlchemy + PostgreSQL (`backend/`). Also serves the built
  frontend and the kiosk board as static files, runs an in-process scheduler thread, and
  optionally mirrors GitHub pull requests into tasks.
- **Frontend** — React 18 + TypeScript + Vite (`frontend/`), compiled to `frontend/dist`
  and served by the backend at `/`.
- **Kiosk board** — plain HTML/CSS/JS in `frontend/public/opsboard.html|css|js`, served at
  `/opsboard.html`. No build step, no framework, no login (optional shared token).
- **Desktop manager** — Electron control panel (`desktop/`) that starts/stops the server,
  bundles PostgreSQL 16 binaries, manages accounts, feature flags, raw DB rows, and
  `.env` configuration without a terminal.
- **RealtimeCorp** — a separate, hosted corporate console (`corp/`): React + Vite +
  supabase-js against a Supabase project. It is read-only oversight of the data each
  RealtimeSuite installation pushes to it, plus corporate policy administration. See §9.
- **RTLink** — a separate, hosted employee app (`rtlink/`): React + Vite +
  supabase-js against its own Supabase project. One employee signs in to see their
  shifts, tasks and requests, and to queue requests and clock in/out back to the
  installation. See §10.
- **Schema generator** — `scripts/build-schema.sh`, a dev-only script that regenerates
  `backend/sql/001_schema.sql` from a reference Supabase migration set. Normal work never
  needs to run it.

There is **no Supabase, no Postgres RLS enforcement, and no cloud dependency** in the LAN
app at runtime. Its only optional outbound paths are the RealtimeCorp snapshot push and the
RTLink employee-app bridge, and it stays fully functional when either is unconfigured or
unreachable.
The schema is a Postgres dump that *looks* like Supabase (it keeps an `auth.users` table and
`auth.uid()` helpers), and the API emulates the Supabase JWT claim context so those SQL
helpers keep working. All authorization is enforced in Python (`backend/app/deps.py`).

---

## 2. Repository map

```
backend/
  app/
    main.py            FastAPI app, lifespan bootstrap, CORS, static mounts, job threads
    config.py          Settings loaded from backend/.env (single `settings` instance)
    db.py              engine/session factory, schema + addition runner, seed, create_user
    security.py        bcrypt hashing, JWT create/decode
    deps.py            RequestUser, get_db, role checks (admin/manager/self/leave lock)
    features.py        DEFAULT_FEATURE_FLAGS, FEATURE_GROUPS, FEATURE_META, normalize
    realtime.py        Postgres LISTEN → SSE generator (channel `suite_realtime`)
    leave.py           leave/suspension windows, wiping shifts + task assignments
    github_sync.py     GitHub PR → task mirroring (urllib, no SDK)
    cli.py             `python -m app.cli ...` admin/ops commands
    routers/           one module per feature area (see §5)
  sql/
    001_schema.sql     full base schema; applied ONLY when public.profiles is missing
    002..005_*.sql     idempotent additions; applied on EVERY startup, filename order
    ref/               reference-only SQL, never applied automatically
  .env.example         documented environment variables
  requirements.txt     pinned Python dependencies

frontend/
  index.html           Vite entry (title: RealtimeSuite)
  public/              copied verbatim into dist/: opsboard.html/css/js
  src/
    main.tsx           React root
    App.tsx            session, data loading, view routing, realtime wiring, mutations
    types.ts           every shared row/payload type (mirror of API shapes)
    lib/api.ts         the ONLY HTTP layer: auth, all endpoints, SSE subscriptions
    lib/features.ts    feature flags (must stay in sync with backend/app/features.py)
    lib/time.ts        HH:MM parsing, local day ranges, formatters
    lib/views.ts       ViewMode union
    components/        one file per screen/area (see §6)
    styles.css         single global stylesheet (no CSS modules, no Tailwind)

desktop/               Electron manager (main.cjs, preload.cjs, server-manager.cjs, renderer/)
corp/                  RealtimeCorp corporate console (separate app, see §9)
  supabase/migrations/0001_realtimecorp.sql   tables, RLS, helper RPCs (run once in Supabase)
  scripts/mock-supabase.mjs                   dev-only Supabase stand-in with sample data
  src/
    App.tsx            session, company scope (corp_my_scope), data load, view routing
    lib/data.ts        the ONLY Supabase read/write layer
    lib/metrics.ts     payroll, operations and sync-health derivations
    components/        AuthScreen, AppShell and one view per nav item
    styles.css         single global stylesheet
rtlink/                RTLink employee app (separate Vite app, see §10)
  supabase/migrations/0001_rtlink.sql   mirrors, action queue, RLS (run once in Supabase)
  scripts/mock-supabase.mjs             dev-only Supabase stand-in with sample data
  src/
    App.tsx            session, workspace load, 30 s poll, action submission
    lib/data.ts        the ONLY Supabase read/write layer
    components/        Today, Schedule, Tasks, Requests, Me, AppShell, AuthScreen
    styles.css         single global stylesheet
scripts/build-schema.sh
```

`corp/` shares nothing with `frontend/` at build time — it is a separate npm project with its
own `package.json`, port (5174) and deployment target.

`rtlink/` is likewise independent: its own npm project, port (5175) and static deployment. It
talks only to Supabase, never to the LAN server, and its schema lives in
`rtlink/supabase/migrations/`.

Sizes for orientation: `backend/app` ≈ 5.6k lines; `frontend/src` ≈ 11.7k lines, dominated by
`TimelineBoard.tsx` (~2.7k), `AdminSchedulingPortal.tsx` (~2.4k), `EmployeePortal.tsx` (~2.3k),
and `lib/api.ts` (~1.7k).

---

## 3. Running it

### Backend (development)

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then edit
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

On startup the lifespan hook does, in order:

1. `apply_schema()` — creates `auth` shim + all tables **only if `public.profiles` does not exist**.
2. `apply_additions()` — runs every other `backend/sql/*.sql` file (sorted) on every boot.
3. `ensure_seed()` — creates the single organization, default work areas (`Operations`,
   `Management`), and the bootstrap admin **only if `profiles` is empty and
   `BOOTSTRAP_ADMIN_PASSWORD` is set**.
4. Creates `UPLOAD_DIR`, starts the `suite-scheduler` thread (30 s tick) and, when
   `GITHUB_TOKEN` + `GITHUB_REPOS` are set, the `github-sync` thread.

The frontend build is mounted at `/` if `frontend/dist` exists, otherwise `/` returns HTTP 503
with a "build the frontend" message. Uploads are mounted at `/uploads`.

### Frontend (development)

```bash
cd frontend
npm install
npm run dev        # Vite on 0.0.0.0:5173, proxies /api, /uploads, /opsboard → 127.0.0.1:8000
npm run typecheck  # tsc --noEmit
npm run build      # tsc --noEmit && vite build → dist/
```

Set `VITE_API_BASE` to point at a different API origin; the default is `/api` (same origin,
which is how production runs behind FastAPI).

### Single-process production

```bash
cd frontend && npm install && npm run build && cd ..
cd backend && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Employees open `http://<lan-ip>:8000/`; the kiosk is `http://<lan-ip>:8000/opsboard.html`
(append `?token=...` when `OPSBOARD_TOKEN` is set).

### CLI (`backend/` with the venv active)

```bash
python -m app.cli init
python -m app.cli create-admin --email admin@example.com --name "Admin" --password-stdin
python -m app.cli create-user  --email jane@example.com --name "Jane" --role employee --password-stdin
python -m app.cli reset-password --email jane@example.com --password-stdin
python -m app.cli list-users [--json]
python -m app.cli delete-user --email jane@example.com
python -m app.cli get-features [--json]
echo '{"tasks": false}' | python -m app.cli set-features
python -m app.cli feature-schema
python -m app.cli corp-site-id        # new CORP_SITE_ID + the .env lines to paste
python -m app.cli corp-sync           # push one snapshot to RealtimeCorp now
python -m app.cli set-org-name --name "Acme Ops"
```

`delete-user` refuses to remove the last admin and nulls every historical reference listed in
`PROFILE_REFERENCES` before deleting the account.

### RealtimeCorp (development)

The corporate console is a separate project; it needs a Supabase project (or the local
mock) and is not part of the LAN build.

```bash
cd corp
npm install
cp .env.example .env       # VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (anon key only)
npm run dev                # Vite on 0.0.0.0:5174
npm run mock               # optional: local Supabase stand-in on 127.0.0.1:54321
npm run typecheck && npm run build
```

The migration in `corp/supabase/migrations/` is applied once in the Supabase SQL editor.
Full setup (accounts, roles, pointing a site at the console) is in [corp/README.md](corp/README.md).

### Desktop manager

```bash
cd desktop && npm install && npm start     # tests: npm test
```

It shells out to `app.cli` for account/feature/database actions and to `uvicorn` for the
server, so those commands must keep their current flags and JSON output.

---

## 4. Configuration (`backend/.env`)

`backend/app/config.py` reads these once at import. Packaged desktop installs keep the same
keys in the OS user-data folder instead of the app bundle.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | `postgresql+psycopg://...` DSN. Desktop local default uses port 55432, no password. |
| `JWT_SECRET` / `JWT_ALGORITHM` / `JWT_EXP_MINUTES` | Session signing (HS256, 720 min default). |
| `HOST` / `PORT` | Uvicorn bind. |
| `CORS_ORIGINS` | Comma-separated browser origins (only needed when the UI is served by Vite). |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` / `BOOTSTRAP_ADMIN_NAME` | First admin, first boot only. |
| `ORGANIZATION_NAME` | Name of the organization row created on first boot. |
| `OPSBOARD_TOKEN` | When set, `/api/opsboard` and the kiosk require `?token=`. |
| `UPLOAD_DIR` | Where login logo/background uploads are written (default `backend/uploads`). |
| `FRONTEND_DIST` | Directory mounted at `/` (default `../frontend/dist`). |
| `SMTP_*` | Optional onboarding-credentials email. Blank = in-app only. |
| `GITHUB_TOKEN`, `GITHUB_REPOS`, `GITHUB_POLL_MINUTES`, `GITHUB_TASK_MINUTES`, `GITHUB_API_URL` | Pull-request → task mirroring. Sync is off unless token *and* repos are set. |
| `CORP_SUPABASE_URL`, `CORP_SUPABASE_SERVICE_ROLE_KEY`, `CORP_SITE_ID`, `CORP_COMPANY_ID` | RealtimeCorp snapshot sync (§9). All four required for sync; blank = fully offline. |
| `CORP_LOCATION_ID`, `CORP_SITE_NAME`, `CORP_SYNC_MINUTES`, `CORP_CHANGE_SYNC`, `CORP_SYNC_TIMEOUT_SECONDS` | Optional sync shape: location mapping, console display name, reconciliation interval (5), push-after-change (true), HTTP timeout (20). |
| `RTLINK_SUPABASE_URL`, `RTLINK_SUPABASE_SERVICE_ROLE_KEY`, `RTLINK_SITE_ID` | RTLink employee-app sync (§10). All three required; blank = fully offline. One Supabase project per installation. |
| `RTLINK_SITE_NAME`, `RTLINK_SYNC_MINUTES`, `RTLINK_CHANGE_SYNC`, `RTLINK_POLL_SECONDS`, `RTLINK_SYNC_TIMEOUT_SECONDS` | Snapshot display name, reconciliation interval (5), push-after-change (true), employee-action poll interval (15 s), HTTP timeout (20). |

`backend/.env` holds real secrets. Never print it, copy values into code, commit changes to it,
or move secrets into the frontend bundle.

---

## 5. Backend architecture

### 5.1 Request path

```
HTTP → router (prefix /api...) → Depends(get_current_user) [JWT] → Depends(get_db) [session with actor GUCs]
     → SQL via SQLAlchemy text() → commit (session_scope) → JSON response
```

- `db.session_scope(user_id, role)` opens a session and sets `request.jwt.claim.sub` and
  `request.jwt.claim.role` as **transaction-local** config, then commits on exit and rolls
  back on exception. This is what makes `auth.uid()` / `auth.role()` work inside SQL
  functions and triggers. Any endpoint that calls a SQL helper expecting an actor must use
  `get_db` (authenticated) rather than a bare `session_scope()`.
- `main.py` registers one exception handler: `DBAPIError` → HTTP 400 with
  `diag.message_primary`. That means raw Postgres errors (constraint/trigger violations)
  surface as ordinary API errors — write clear `raise exception` messages in SQL when you add
  triggers.
- Routers are included in a fixed order in `main.py`; the static mounts (`/uploads`, `/`) are
  registered **after** routers so API paths win.

### 5.2 Authentication and authorization (`deps.py`, `security.py`)

- Passwords: bcrypt hashes in `auth.users.encrypted_password`; `public.profiles` holds the
  app-level account (`id` = `auth.users.id`, email, full name, role, organization).
- Login (`POST /api/auth/login`) verifies the hash, then issues a JWT with `sub`, `role`,
  `email`, `iat`, `exp`. There is no refresh token and no server-side session store; logout is
  purely client-side.
- Tokens are accepted as `Authorization: Bearer <token>` **or** `X-Suite-Token: <token>`
  (legacy/kiosk path). `get_db_optional` allows anonymous access for branding and kiosk reads.
- `RequestUser` = id, email, role, organization_id, full_name, is_training_manager.
- Role helpers, all requiring a session for context:
  - `is_effective_admin` / `require_admin` — role `admin` **or** SQL `public.is_admin(uid)`
    (which also grants admin when the user has operator/management shift access). Always use
    this, not `user.role == 'admin'`, for admin gates.
  - `require_manager` — effective admin **or** `is_training_manager` (used by the admin
    dashboard and reports so training managers can read data without full admin).
  - `require_self_or_admin`, `require_active_employee` — the latter blocks employees who are
    suspended/on probation or on approved `VAUT`/`DO` leave from clocking in, messaging
    management, or submitting requests.
- There are **zero** RLS policies in the shipped schema. Do not assume the database stops a
  query; scope every query by `employee_id` / `organization_id` / ownership in Python.

### 5.3 Features (`features.py` + `lib/features.ts`)

- Flags live in `organizations.experience_builder_config->'feature_flags'` (JSONB), *not* in a
  table of their own. `normalize_feature_flags` fills missing keys from
  `DEFAULT_FEATURE_FLAGS` and drops unknown ones.
- **The same key list and defaults exist twice** — `backend/app/features.py` and
  `frontend/src/lib/features.ts` (`DEFAULT_FEATURES`). Adding a flag means editing both. The
  frontend defaults only apply before the flags load; the backend is authoritative.
- Flags are read on sign-in (`GET /api/settings/features`, public) and hide UI only. Data is
  never deleted when a flag is turned off, and nothing is enforced server-side by a flag
  except where a router explicitly checks it.
- Groups (`FEATURE_GROUPS`) and human labels (`FEATURE_META`) drive the desktop manager's
  Features tab and the admin settings UI; keep them updated with new flags.

### 5.4 Routers

| Module | Prefix | Responsibility |
| --- | --- | --- |
| `system.py` | `/api` | `GET /health`, `GET /time` (server clock for drift correction), `GET /realtime/stream` (SSE). |
| `auth.py` | `/api/auth` | login, `me`, logout, change-password. |
| `settings.py` | `/api/settings` | organization settings read/patch, branding, feature flags, login asset upload, announcements CRUD, clock-in locations CRUD, training-mode tuning. |
| `employees.py` | `/api` | employee list/create/patch, own profile, effective-admin check, work preferences, extended-leave status, onboarding credentials email, training-manager flags. |
| `reports.py` | `/api` | `GET /dashboard?date=` (admin board payload) and `GET /portal?date=` (employee payload). These two hydrate the entire UI — the biggest read paths in the app. |
| `shifts.py` | `/api` | work areas, shifts CRUD, month reset, clock in/out, breaks, auto-assign (day/month), shift pool create/claim, unscheduled clock-in, geofence verification. |
| `tasks.py` | `/api/tasks` | assign/update/reassign/unassign/delete tasks, acknowledgements, note tasks. |
| `staff_requests.py` | `/api` | time-off (incl. coverage preview), overtime, shift swaps, exception requests — submit and review paths. |
| `discipline.py` | `/api/discipline` | write-ups, apply/revoke punishments (pay-rate reduction, unpaid suspension, probation). |
| `nullifications.py` | `/api/nullifications` | requests to erase worked time inside a window; approve/deny/delete. |
| `comms.py` | `/api` | employee messages (threads, read receipts, recipients) and in-app notifications. |
| `training.py` | `/api/training` | courses and assignments, completion. |
| `integrations.py` | `/api/integrations/github` | status + manual `POST /sync`. |
| `corp_sync.py` | `/api/integrations/corp` | `GET /status` and `POST /sync` for the RealtimeCorp push (`require_manager`). See §9. |
| `rtlink_sync.py` | `/api/integrations/rtlink` | `GET /status`, `POST /sync`, `POST /pull` for the RTLink bridge (`require_manager`). See §10. |
| `opsboard.py` | `/api/opsboard` | unauthenticated (token-gated) aggregate for the kiosk: employees, areas, shifts, tasks, assignments, overtime/swaps, active announcement, public board notes, and the organization config (where the kiosk reads its layout and feature flags). |
| `board_notes.py` | `/api/board-notes` | public/private board notes shown on the timeline and kiosk. |

Most write endpoints take a raw `dict = Body(...)` payload rather than a Pydantic model; they
validate by reading keys and casting. Boolean/jsonb parameters are usually sent as **JSON text**
and cast in SQL (`cast(:config as jsonb)`) because psycopg will not adapt arbitrary dicts.
When adding a column with an enum type, cast explicitly: `cast(:status as public.task_status)`.

### 5.5 Background work (`main.py`)

- `_scheduler_loop` every 30 s: `process_due_shift_break_resumes()`,
  `process_due_shift_auto_clock_outs()`, then per-user
  `enqueue_my_shift_start_notifications(60)` (creates "shift starting soon" notifications).
  Failures are logged and swallowed so the thread keeps running.
- `_github_loop`: polls `GITHUB_POLL_MINUTES` and calls `sync_pull_requests()`. Open non-draft
  PRs become unassigned tasks (`source_system='github'`, `external_id='owner/repo#123'`,
  starting at the current quarter hour); merged → `done`, closed → `cancelled`.
- `rtlink_bridge.start()` runs three daemon threads when RTLink is configured: a
  `suite_realtime` listener (mark snapshot dirty), a push worker (startup, interval, debounced
  change), and an action poller (`RTLINK_POLL_SECONDS`). See §10.
- Both threads are daemon threads stopped via a module-level `threading.Event` at shutdown.
  There is no Celery/Redis/cron anywhere — long work must stay fast or move to SQL.

### 5.6 Database model (`backend/sql/001_schema.sql`)

Single organization per installation (`public.organizations`, `experience_builder_config`
JSONB carries feature flags, experience-builder modules, OpsBoard settings and training-mode
tuning).

Core tables:

- `auth.users` (email + bcrypt hash, Supabase-compatible shim) ↔ `public.profiles`
  (`role public.app_role` = `admin|employee`, `organization_id`, `hourly_rate`, onboarding
  fields, `is_training_manager`, `admin_training_only`, `retail_chaos_stationary`).
- `work_areas`, `shifts` (status enum `scheduled|on_duty|break|off_shift`, clock-in geo/device
  columns, break minutes, worked minutes, pay multiplier, shift-pool columns),
  `shift_break_schedules`, `shift_swap_requests`.
- `tasks` (+ `task_assignments`, acknowledgement columns, `source_system`/`external_*` for
  GitHub), `activity_tracking`.
- `time_off_requests`, `exception_requests` (`exception_code` enum `VAUT|NCNS|LTDR|DO`),
  `overtime_requests`, `time_nullification_requests` (002–005 addition), `discipline_actions`,
  `board_notes` (002 addition).
- `employee_messages`, `app_notifications`, `site_announcements`,
  `employee_work_preferences`, `training_courses`, `training_assignments`,
  `organization_clock_in_locations`, `employee_device_tokens`.

Notable SQL functions/triggers: `public.is_admin()`, `apply_discipline_action()`,
`process_due_shift_auto_clock_outs()`, `process_due_shift_break_resumes()`,
`enqueue_my_shift_start_notifications()`, `update_training_mode_settings()`, notification
triggers for messages/task assignments/training, validation triggers for task windows, and
`suite_notify()` attached to every public table to emit realtime events (see §8).

### 5.7 Migration rules (important)

- `001_schema.sql` is never re-run against an existing database. Do **not** edit it to add
  columns/tables for existing installs; anything you add there will only appear on fresh
  databases.
- Put every change in a new numbered file: `backend/sql/006_short_name.sql`,
  `007_...`. `apply_additions()` runs all non-001 files in filename order on **every** start,
  so each file must be **idempotent**: `create table if not exists`, `add column if not
  exists`, `create or replace function`, `drop trigger if exists` + `create trigger`,
  `insert ... on conflict do nothing`.
- Use `public.` qualification and the existing enum types; cast literals (`'scheduled'::public.shift_status`).
- Never put destructive statements in an addition file.
- `scripts/build-schema.sh` regenerates `001_schema.sql` from the external
  `WaterROC-NextGeneration` reference migrations and a temporary reference Postgres cluster
  (`backend/.pgdata-ref`). It is dev-only and will overwrite the base schema — do not run it
  as part of a feature change.

---

## 6. Frontend architecture

### 6.1 Boot and session

`main.tsx` → `App.tsx`. `App` is the whole application shell:

1. `getCurrentSession()` reads `localStorage` (`realtime_suite_token`, `realtime_suite_user`).
2. If a session exists → `fetchProfile` → `fetchMyEffectiveAdminAccess` → organization
   settings → feature flags → active announcement.
3. Chooses the shell:
   - **not signed in** → `AuthScreen` (branding, colors, logo/background, announcement,
     experience-builder login modules).
   - **employee** (and managers previewing) → `EmployeePortal` full-screen.
   - **admin/manager** → `TopBar` + view switch + status bar.
4. Loads data based on role: admin → `GET /api/dashboard?date=<selectedDate>`, employee →
   `GET /api/portal?date=<selectedDate>`.
5. Refreshes every 20 s (silent) and on every realtime SSE event; `runMutation()` wraps each
   write (busy flag → call → silent reload → error banner → rethrow).

`ViewMode` (`lib/views.ts`): `operations | roster | scheduling | reports | shift-audit |
opsboard-settings | settings | employee-portal`. Admin views are additionally gated by feature
flags in an effect that bounces to `operations` when a flag turns a view off; mobile viewports
(<760 px) force managers into `employee-portal`.

### 6.2 `lib/api.ts` — the single HTTP boundary

- `API_BASE = VITE_API_BASE || '/api'`; `apiFetch` attaches the bearer token, parses JSON,
  converts non-2xx into `ApiError` using `detail` (string or Pydantic array), and **clears the
  session on 401**.
- `signIn`/`signOut`/`getCurrentSession`/`onAuthStateChanged` implement a tiny in-memory +
  localStorage session store with listener callbacks (there is no Supabase client).
- Every backend capability has a typed wrapper here (`fetchAdminDashboardData`,
  `upsertShift`, `reviewTimeOffRequest`, `createDisciplineAction`, …). Components never call
  `fetch` directly; add new endpoints here, not in components.
- `openEventStream` connects to `/api/realtime/stream` with `EventSource`-style streaming,
  auto-reconnects with exponential backoff, and exposes `subscribeToAppRealtime` (any change to
  a whitelisted table → reload) and `subscribeToAdminRealtimeNotifications` (interprets raw row
  changes into clock-in/clock-out/request events for the header feed).

### 6.3 Components

| Component | Role |
| --- | --- |
| `TopBar.tsx` | Brand, main nav (Employee Portal, Operations Board, Roster, Scheduling, Clock-In Audit, Reports, Settings), date picker, timeline zoom, filters, search, quick actions, announcements, notification tray, Live Board link, connection state, presence KPIs. |
| `TimelineBoard.tsx` | The operations board: day timeline per employee/work area, shift + task bars, edit dialogs, break tasks, clock in/out, board notes, time nullification review, create work area, message + note-task modals. Largest and most stateful component. |
| `AdminSchedulingPortal.tsx` | Admin "Scheduling" area with its own subpage tabs. |
| `EmployeeRoster.tsx` | Searchable roster with assignments/contact info. |
| `ClockInAudit.tsx` | Punch review: scheduled vs actual, lateness, location/device. |
| `AdminReports.tsx` | Admin reporting over the loaded shifts/tasks (attendance, hours, payroll-ish summaries). |
| `OrgSettings.tsx` | Organization profile, scheduling defaults, sign-in page branding + asset upload, clock-in locations. |
| `OpsBoardSettingsPage.tsx` | Kiosk configuration (layout preset, horizon, refresh, alerts, branding text) stored under `experience_builder_config.opsboard_settings`. |
| `EmployeePortal.tsx` | The entire employee experience (see §7.3). |
| `AuthScreen.tsx` | Sign-in screen with organization branding and experience-builder modules. |
| `ExperienceModules.tsx` | Renders `announcement | hero | image` modules for login/employee surfaces. |

Styling is one global `styles.css` (class names like `ops-editor-modal`,
`scheduling-admin-card`, `employee-portal-shell`). No CSS framework, no component library, no
router, no state library. Inline styles are used sparingly for layout-only cases.

### 6.4 Kiosk board

`frontend/public/opsboard.html|css|js` is framework-free and ships as-is. It polls
`/api/opsboard?date=...&token=...` on an interval from `opsboard_settings.default_refresh_seconds`,
applies `opsboard_settings` (layout, branding, alerts), reads feature flags from the payload to
hide panels, and shows KPI cards, active/upcoming shifts and tasks, unassigned tasks,
exceptions, and board notes. Keep it dependency-free; it must run on a TV browser with no build.

---

## 7. How the admin side works

### 7.1 Who is an admin

- `profiles.role = 'admin'` → full access.
- `public.is_admin(uid)` also returns true for users with operator/management shift access, so
  the UI calls `fetchMyEffectiveAdminAccess()` in addition to reading `role`. `isAdmin` in
  `App.tsx` = `role === 'admin' || effectiveAdmin`.
- `is_training_manager` → manager-level read access (`require_manager`) but not admin writes.
- Employee list on the dashboard is `role = 'employee'`, so admins do not appear in the board,
  roster, payroll, or auto-assign pools. Managers can still open their own Employee Portal.

### 7.2 Admin navigation and data

`TopBar` shows admin tabs, each disabled/hidden by a feature flag:
`employee_portal`, `roster`, `scheduling` (any of `shifts|shift_pool|auto_assign`), `reports`,
`clock_in_audit`; Settings is always visible to admins.

All admin screens read from the single `AdminDashboardData` payload
(`GET /api/dashboard?date=`): employees, work areas, day shifts, month shifts, tasks, task
assignments, messages, time-off/exception/overtime/swap requests, discipline actions, board
notes, time nullifications, activity tracking, and the `shiftIntelligence` snapshot (fatigue
risk, overtime forecast, staffing gaps, cover-now suggestions). Mutations go through
`runMutation`, which refreshes that payload.

**Operations Board (`TimelineBoard`)** — the live floor view: one row per employee/resource over
a selectable window (1–24 h), shift bars colored by work area/status, task bars with
acknowledgement state, unassigned-task column, conflicts/late markers. From here an admin can
create/edit shifts and tasks, assign breaks, clock employees in/out, create work areas, post
board notes, review time nullifications, and message employees.

**Scheduling (`AdminSchedulingPortal`)** — subpages:
- `schedule` — Shift Intelligence snapshot (fatigue risk, staffing gaps) + the monthly schedule
  editor for one employee (create/edit/delete shifts, "Fill Entire Month", "Create Shift Pool
  Month", "Delete Month & Reset").
- `operations` — day shift list for the selected date, shift assignment/edit form, and
  "Auto Assign Missing Shifts" (`POST /api/shifts/auto-assign`, mode day/month: every employee
  without a shift that day gets one in round-robin work areas with the chosen start/end/break).
- `requests` — exception requests, overtime assignment and review, shift-swap review, employee
  write-ups/punishments, and all time-off requests with approve/deny/edit/delete.
- `payroll` — per-employee hourly rate editing and worked-hours → gross pay for the month.
- `hiring` — employee account provisioning: full name, email, generated temp password →
  `POST /api/employees` + optional `POST /api/employees/onboarding-email`; the employee signs in
  and completes first-login onboarding.

**Reports** — `AdminReports` computes from the loaded board data (attendance, task completion,
hours). The server-side reporting endpoint is the same `/api/dashboard` payload; there is no
separate warehouse.

**Clock-In Audit** — compares `start_at`/`end_at` with `clocked_in_at`/`clocked_out_at` and
shows drift, lateness, break minutes, and captured location/device metadata.

**Discipline and leave** — issuing a write-up can apply a punishment
(`none | pay_rate_reduction | unpaid_suspension | probation`). Applying one runs
`apply_discipline_action` and, for suspension/probation, `leave.wipe_employee_window` deletes
that employee's shifts and task assignments inside the leave dates. While the leave or an
approved `VAUT`/`DO` exception is active, `require_active_employee` blocks clock-in, messaging
management, and new requests. Revoking restores access but **does not** restore deleted shifts.

**Settings** — `OrgSettings` (name, portal label, sign-in branding with uploaded logo/background,
default break minutes, default timeline window, clock-in locations, extended-leave lock) and
`OpsBoardSettingsPage` (kiosk). Both PATCH `/api/settings`; only keys in `ORG_EDITABLE` are
accepted. Feature flags are stored in `experience_builder_config.feature_flags` and can also be
toggled from the desktop manager.

### 7.3 Employee side (for contrast)

`EmployeePortal` has three top tabs — `operations`, `scheduling`, `training` — with submenus
(overview, profile & preferences, messages/inbox, my shifts, my tasks, shift pool, alerts,
calendar, requests, time off, overtime, shift swaps, exceptions, my trainings). It offers clock
in/out (scheduled, unscheduled, geofenced), task acknowledgement, time-off and no-task-time
requests with coverage preview, exception requests, overtime requests and responses, swap
marketplace, messages to managers, notifications, work preferences (weekly hour cap, preferred
areas, availability notes), and training completion. All labels can be overridden through
`experience_builder_config.employee_elements`, and flags hide individual features. If the user
is restricted, the portal shows a banner from `restriction` in the portal payload.

---

## 8. Realtime pipeline

```
INSERT/UPDATE/DELETE on any public table
  → trigger suite_notify_row → public.suite_notify()
  → pg_notify('suite_realtime', {table, op, new, old})
  → GET /api/realtime/stream (FastAPI StreamingResponse, LISTEN loop, 15 s timeout, keepalives)
  → api.ts openEventStream() (auto-reconnect, backoff)
  → subscribeToAppRealtime: table in REALTIME_TABLES → silent reload of dashboard/portal
  → subscribeToAdminRealtimeNotifications: shifts/time_off/exception inserts → header feed
```

If you add a table the UI should react to, add it to `REALTIME_TABLES` in `lib/api.ts` and make
sure the trigger creation loop in the schema covers it (it iterates public tables). The 20 s
poll in `App.tsx` is the fallback when SSE is unavailable.

---

## 9. RealtimeCorp (corporate console)

`corp/` is a separate hosted app for corporate users. It never talks to a LAN server
directly: RealtimeSuite pushes snapshots to one Supabase project, and the console reads
that project as a signed-in Supabase user. Setup and operations are documented in
[corp/README.md](corp/README.md); the points that matter when changing code:

- **Two credential realms, never mixed.** The console ships `VITE_SUPABASE_URL` and the
  public **anon** key; row level security decides what each user reads. The LAN server
  uses the **service_role** key (which bypasses RLS) and it must never reach a browser,
  `frontend/`, `corp/src` or a log line.
- **Schema** — `corp/supabase/migrations/0001_realtimecorp.sql` is applied once in the
  Supabase SQL editor. It creates `corp_companies`, `corp_locations`, `corp_members`,
  `corp_sites`, the snapshot mirrors (`corp_employees`, `corp_work_areas`, `corp_shifts`,
  `corp_tasks`, `corp_time_off_requests`, `corp_exception_requests`,
  `corp_overtime_requests`, `corp_discipline_actions`, `corp_training_assignments`,
  `corp_board_notes`, `corp_announcements`), `corp_sync_events` and `corp_policies`. Like
  the RealtimeSuite additions, keep the file idempotent (`if not exists`, drop/create
  policies, `create or replace function`).
- **Access control** lives in RLS, not the client: `corp_is_member(company_id)`,
  `corp_can_manage` and `corp_is_admin` wrap `corp_members` (roles `corp_admin`,
  `corp_manager`, `corp_viewer`). Mirror tables are read-only to everyone but the service
  role. The UI hides controls by role, but the database is the boundary.
- **`corp_my_scope()`** returns one row per membership (company, location, role) and is what
  the console loads after sign-in. **`corp_bootstrap_company(name, location)`** lets an
  account with no membership create the first company and become its admin.
- **Sync** lives in `backend/app/corp_sync.py`: `COLLECTIONS` maps a collection name to its
  Supabase table and the local SQL that fills it. Adding a mirrored field means editing
  both that SQL and the Supabase column list — the two are not generated from each other.
- **Delivery contract** — every pushed row carries `site_id`, `company_id` and `synced_at`;
  upserts are `POST /rest/v1/<table>?on_conflict=id` with
  `Prefer: resolution=merge-duplicates`, and after a successful pass rows with
  `synced_at < snapshot_start` are deleted for that site. Preserve that ordering: prune only
  after every upsert succeeded, or a partial failure would delete live data.
- **Triggers** — the push worker is woken by a `LISTEN suite_realtime` thread (the same
  trigger fan-out as §8) with a 2 s debounce, plus a full reconciliation every
  `CORP_SYNC_MINUTES`. Any table added to `COLLECTIONS` is picked up automatically, but it
  must have the `suite_notify_row` trigger for change-triggered delivery.
- **Failure is contained**: `sync_now()` never raises to the caller, keeps the last error in
  module state (`GET /api/integrations/corp/status`), records a failed `corp_sync_events`
  row, and never blocks scheduling. Do not make the LAN app depend on network calls.
- **Local development** uses `corp/scripts/mock-supabase.mjs` (`npm run mock` in `corp/`),
  a dev-only stand-in with sample data and no RLS. It is not shipped and must never hold
  real credentials or data.
- **Snapshot window** (change deliberately): shifts/tasks 120 days back + 60 forward,
  requests/notes 180/90 days back, everything else full. Corporate payroll and reports
  assume roughly a quarter of history.

---

## 10. RTLink (employee app)

`rtlink/` is the employee-facing companion website. It is hosted separately and talks only to
Supabase; the LAN installation stays the source of truth. Setup is in
[rtlink/README.md](rtlink/README.md); the points that matter when changing code:

- **Two credential realms.** The browser ships only `VITE_SUPABASE_URL` and the anon key, and
  RLS decides what an employee reads. `RTLINK_SUPABASE_SERVICE_ROLE_KEY` stays in
  `backend/.env` and must never reach `rtlink/`, a log line or a browser. One Supabase project
  serves one installation.
- **Identity is the email.** `rtlink_current_employee_id()` / `rtlink_current_site_id()` match
  `auth.jwt()->>'email'` against `rtlink_employees.email`. A Supabase user without a matching
  `profiles.email` sees the "Almost there" screen. Changing an employee's email means updating
  both sides.
- **Employees only insert into `rtlink_requests`.** A before-insert trigger overwrites
  `employee_id`/`site_id` from the helpers and forces `status='pending'`, so a client cannot
  spoof attribution or mark its own action applied. There are no update/delete policies on any
  mirror.
- **Mirror tables are read-only and pruned by `synced_at`.** `backend/app/rtlink_bridge.py`
  `COLLECTIONS` maps a collection to its Supabase table and local SQL; adding a mirrored field
  means editing both the SQL and `rtlink/supabase/migrations/0001_rtlink.sql` (they are not
  generated from each other). Prune only after every upsert succeeded.
- **Action kinds** — `time_off.create`, `overtime.create`, `exception.create`, `swap.create`,
  `task.acknowledge`, `shift.claim`, `shift.clock_in`, `shift.clock_out`,
  `shift.clock_in_unscheduled`. Add a kind in three places: the Supabase `check`, the
  `APPLIERS` map, and the RTLink action types/UI.
- **Business rules stay in SQL.** Appliers call `create_shift_swap_request`,
  `acknowledge_task_assignment`, `claim_shift_pool_shift`, `clock_in_shift`,
  `clock_out_shift`, `clock_in_unscheduled_shift` with the employee's actor GUC set via
  `session_scope(employee_id, 'authenticated')`. `require_active_employee` blocks suspended,
  probationary and on-leave employees exactly as on the LAN.
- **Delivery is at-least-once.** `public.rtlink_action_log` (SQL addition 007) records every
  action id before the result is acknowledged; three failures mark it `failed` with a message
  the employee sees. Never apply a logged `applied` action again.
- **Clock-in location.** When the organization has active clock-in locations, a clock-in without
  coordinates is rejected and coordinates are checked with `verify_clock_in_location` before the
  punch. `rtlink_settings.clock_in_required` tells the UI to ask for permission.
- **Failure is contained.** `sync_now()` and `run_once()` never raise to the caller; the last
  error lands in `GET /api/integrations/rtlink/status`. Do not make scheduling depend on
  Supabase.
- **Local development** uses `rtlink/scripts/mock-supabase.mjs` (`npm run mock`), which also
  simulates the bridge by applying queued actions after a few seconds. It has no RLS and no
  persistence; never point it at real data.

## 11. Conventions and gotchas

- **Keep feature keys duplicated in sync** (`backend/app/features.py` ⇄
  `frontend/src/lib/features.ts`) and update `FEATURE_META`/`FEATURE_GROUPS`.
- **New schema change ⇒ new numbered idempotent SQL file.** Never mutate `001_schema.sql` for
  existing installs.
- **Authorization lives in Python.** Call `require_admin` / `require_manager` /
  `require_active_employee` explicitly; remember `is_effective_admin`, not `role == 'admin'`.
- **Scope every query.** Filter by `employee_id` for employee-facing reads and by
  `organization_id` where the table has it; never trust an id from the client.
- **Dates and times**: the API returns ISO timestamps; the UI works in "HH:MM" plus a
  `YYYY-MM-DD` day value and builds local-day bounds (`lib/time.ts`, `reports._bounds`). Day
  boundaries are local time via `.astimezone()`, while leave windows in `leave.py` use UTC
  dates. Be deliberate about which you need.
- **JSONB and enums**: send JSON as text and `cast(:x as jsonb)`; cast enum params to their
  type. Avoid `text()` f-strings with user input — only table/column names are interpolated
  (e.g. `ORG_EDITABLE`, `PROFILE_REFERENCES`).
- **SQL functions are the business rules** for discipline, auto clock-out, break resume, shift
  start notifications and notification fan-out. Change them in SQL, not by re-implementing in
  Python; then call them through an authenticated session so `auth.uid()` resolves.
- **No new frontend dependencies** unless clearly necessary — the app deliberately ships React +
  Vite only, with a hand-rolled API layer, SSE client and CSS.
- **`frontend/public/*` has no build step**; anything you put there ships verbatim to `dist/`.
- **Desktop manager depends on CLI output/JSON**; changing `app.cli` output shape breaks it.
- **Feature flags hide UI, they do not delete data**; warn in UI copy rather than blocking reads.
- Generated/ignored folders: `frontend/dist`, `backend/.venv`, `backend/uploads`,
  `backend/.pgdata-ref`, `__pycache__`, `desktop/node_modules`. Don't hand-edit build output.

## 12. Verification

Run the smallest check that covers your change:

```bash
# frontend (required for any TSX/TS change)
cd frontend && npm run typecheck          # or: npm run build

# backend (import-time errors, router wiring)
cd backend && .venv/bin/python -c "from app.main import app; print(len(app.routes))"

# SQL additions: apply against a scratch database and re-run twice to prove idempotency
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/006_my_change.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/006_my_change.sql

# desktop manager tests (only when touching desktop/)
cd desktop && npm test

# RealtimeCorp (any corp/ change)
cd corp && npm run typecheck && npm run build

# RTLink (any rtlink/ change)
cd rtlink && npm run typecheck && npm run build

# RTLink Supabase migration: apply twice against a scratch database
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f rtlink/supabase/migrations/0001_rtlink.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f rtlink/supabase/migrations/0001_rtlink.sql

# RealtimeCorp Supabase migration: apply twice against a scratch database
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f corp/supabase/migrations/0001_realtimecorp.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f corp/supabase/migrations/0001_realtimecorp.sql

# snapshot sync: status, manual push, and what the site last delivered
curl -H "Authorization: Bearer $TOKEN" localhost:8000/api/integrations/corp/status
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:8000/api/integrations/corp/sync
```

There is no backend test suite in the repo; verify backend changes by starting uvicorn
(`uvicorn app.main:app --reload`) and exercising the endpoint, and by checking that startup
still applies schema additions without errors.
