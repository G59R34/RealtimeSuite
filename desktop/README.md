# RealtimeSuite Server Manager

A small desktop control panel for the RealtimeSuite LAN server. It runs on macOS,
Windows and Linux (Electron) and handles the parts that are awkward from a
terminal:

- start / stop / restart the FastAPI server and watch its live log
- show the LAN addresses employees should open
- create the Python virtual environment and install backend dependencies
- test the Postgres connection and initialize the database schema
- create the first administrator or reset a password
- add and remove employee accounts without touching the command line
- toggle scheduling, people, communication and reporting features on or off
- edit server settings (`PORT`, `HOST`, `DATABASE_URL`, JWT secret, board token)
- open the web app or the live board kiosk in a browser

## Requirements

| Component | Version | Notes |
| --- | --- | --- |
| Python | 3.10+ | `python3` on macOS/Linux, `py`/`python` on Windows |
| PostgreSQL | 13+ | running locally or reachable on the LAN |
| Node.js | 20+ | only needed to run or package the manager itself |

The manager does **not** bundle Python or PostgreSQL. It detects Python and
installs the backend's Python packages into `backend/.venv`.

## Run from source

```bash
# 1) build the web app once so the server can serve it
cd frontend
npm install
npm run build

# 2) launch the manager
cd ../desktop
npm install
npm start
```

On first launch the **Setup** tab walks through the three required steps:

1. **Python environment** – creates `backend/.venv` and runs `pip install -r requirements.txt`.
2. **Database** – enter `DATABASE_URL` (for example
   `postgresql+psycopg://postgres@127.0.0.1:5432/suite`), test the connection,
   then **Initialize Schema**. The schema is applied automatically by the
   backend on startup as well, so a fresh empty database works too.
3. **Administrator account** – creates the first admin. Additional accounts can
   then be added from the **Users** tab.

Then return to **Overview** and press **Start Server**. The LAN addresses are
listed with **Open** and **Board** buttons; share those with employees.

## Users

The **Users** tab lists every account with its role, onboarding state and how
many shifts and tasks are linked to it. Administrators can:

- create an employee or administrator account with a temporary password
  (the **Generate** button makes one)
- delete an account after a second confirmation click

The backend refuses to delete the last administrator. Deleting a person also
deletes their schedules through the existing foreign keys; the CLI clears
references first, so historical records that only name the account keep their
remaining data. User actions run through the same `app.cli` commands the app
uses, so they work even while the server is stopped (the database must be up).

Command-line equivalents, run from `backend/` with the virtual environment:

```bash
.venv/bin/python -m app.cli list-users
.venv/bin/python -m app.cli create-user --email jordan@example.com --name "Jordan Smith" --role employee --password-stdin
.venv/bin/python -m app.cli delete-user --email jordan@example.com
```

## Feature toggles

The **Features** tab exposes every feature flag, grouped as Scheduling, People,
Communication and Insight. Each row has a label and description from the backend
schema, so the list stays in sync with `backend/app/features.py`. Toggle what
this installation needs and press **Save Changes**; **Reset to Defaults** loads
the defaults into the form without saving them.

Flags are stored in `organizations.experience_builder_config.feature_flags` and
need no server restart. The web app reads them on sign-in and hides the matching
tabs, buttons and sections while keeping the underlying data:

- admin navigation (Employee Portal preview, Roster, Scheduling, Clock-In Audit,
  Reports, announcements, notifications, quick actions, the live-board link)
- the employee portal tabs and submenus (tasks, shift pool, overtime, swaps, time
  off, exceptions, messages, preferences, training) and the clock-in button
- timeline task creation, task bars, filters and the unassigned panel
- scheduling subpages (Schedule, Operations, Requests, Payroll, Onboarding)
- the kiosk board (`/opsboard.html`) hides disabled task, shift and announcement
  panels on its next refresh

Reload the browser tab after saving to see the changes. `geofence_clock_in` is
off by default because it needs configured clock-in locations; everything else
starts on. Existing records are never deleted by turning a flag off.

Command-line equivalents:

```bash
.venv/bin/python -m app.cli feature-schema
.venv/bin/python -m app.cli get-features --json
echo '{"tasks": false}' | .venv/bin/python -m app.cli set-features
```

## Server configuration

In development the manager reads and writes `backend/.env`. A packaged install
keeps its configuration in the OS user-data folder instead, because the app
bundle is read-only:

- macOS: `~/Library/Application Support/RealtimeSuite Server Manager/.env`
- Windows: `%APPDATA%\RealtimeSuite Server Manager\.env`
- Linux: `~/.config/RealtimeSuite Server Manager/.env`

Packaged installs also keep their Python virtual environment in that same
user-data folder (`python-venv`), because the application bundle is read-only.
Server logs are written under `logs/server.log`. Environment variables are
passed directly to the server process, so changes take effect after a restart.

## Package the desktop app

```bash
cd desktop
npm run pack          # unpacked app for the current OS (quick check)
npm run dist:mac      # .dmg
npm run dist:win      # NSIS installer
npm run dist:linux    # AppImage
```

Packaging copies `backend/` and `frontend/dist/` into the app resources; the
`.env`, `.venv`, uploads and caches are excluded. Build the frontend before
packaging.

Notes:

- Build each installer on its target OS where possible. Windows installers can
  be produced on macOS/Linux but require Wine; macOS installers require macOS.
- The packaged app still expects Python and PostgreSQL on the machine.
- Code signing/notarization is not configured; macOS Gatekeeper will warn on
  unsigned builds.

## Tests

```bash
cd desktop
npm test
```

The tests cover `.env` parsing/updating, platform Python discovery, version
checks, the packaged env-file location, readiness checks, CLI output parsing and
input validation for account and feature commands.

## Troubleshooting

**`Electron failed to install correctly`** – npm may have skipped Electron's
postinstall script. Run `node node_modules/electron/install.js` inside
`desktop/`, then `npm start` again.

**Python not found** – install Python 3.10+ and reopen the manager. On Windows
the installer option "Add python.exe to PATH" must be enabled. The manager
searches the standard python.org, Homebrew and system locations.

**Users or Features tab says the environment is not ready** – run step 1 of
Setup (or `npm run pack` after installing dependencies) so `backend/.venv`
exists. Both tabs execute `app.cli`, which needs SQLAlchemy, psycopg and the
database driver installed.

**A feature is off but a screen still appears** – reload the app; flags are read
when the page loads. If the kiosk still shows a panel, wait for its refresh
interval or press its refresh button.

**Port already in use** – another copy of the server is running. Stop it, or
change the port in Settings and save the server config.

**Database connection failed** – confirm Postgres is running and the URL uses
the `postgresql+psycopg://` scheme, the correct user/password/database and port.

**The web app does not load** – run `npm run build` in `frontend/`. The manager's
Readiness panel reports when `frontend/dist/index.html` is missing.

**Kiosk access** – if `OPSBOARD_TOKEN` is set, open
`http://<lan-ip>:<port>/opsboard.html?token=<token>`. Leave it blank to allow
open access on the trusted LAN.
