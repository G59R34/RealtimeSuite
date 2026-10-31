# RTLink

The employee app for a RealtimeSuite installation.

RTLink is a separate, mobile-first website. Employees sign in with Supabase Auth
and see only their own schedule, tasks, announcements and requests. The LAN
RealtimeSuite server remains the source of truth: it pushes each employee's data
to Supabase, and it applies anything the employee queues there.

```
RealtimeSuite (LAN, Postgres)                     RTLink (hosted)
┌──────────────────────────┐    snapshots       ┌────────────────────────────┐
│ shifts, tasks, requests, │ ─────────────────▶ │ Supabase Postgres          │
│ announcements, training, │  service_role      │ rtlink_* mirror tables     │
│ work areas, profile      │  upserts           │ RLS: one employee per row  │
│                          │ ◀───────────────── │ rtlink_requests (actions)  │
└──────────────────────────┘  poll every 15 s   └──────────────┬─────────────┘
        applies through the                                    │ anon key + RLS
        same SQL functions                                     ▼
        the LAN app uses                                 React app (this folder)
```

Two rules keep it safe:

1. The browser only ever holds the **anon** key and row level security decides
   what a signed-in employee can read. `service_role` stays in `backend/.env`.
2. Employees never write scheduling data. They insert rows into
   `rtlink_requests`; the LAN server validates and applies them with the same SQL
   functions the desktop app calls (clock in/out, shift claims, swaps, task
   acknowledgement), so business rules are not duplicated.

## What employees get

| Screen | What it answers |
| --- | --- |
| Today | Am I on the clock? Next shift, clock in/out, today's tasks, announcement, board note |
| Schedule | This week at a glance, upcoming shifts, swap requests, open shifts to claim |
| Tasks | Everything assigned, with acknowledge, plus what was already acknowledged |
| Requests | Time off, overtime, exceptions and swaps, with the status of every request |
| Me | Profile, site and sync details, training, recent actions, sign out |

Clock-in can require a location: when the site has active clock-in locations,
RTLink asks the browser for a position and the LAN server verifies it with
`verify_clock_in_location` before applying the punch.

## 1. Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com) (one project per
   RealtimeSuite installation).
2. Open **SQL Editor** and run
   [`supabase/migrations/0001_rtlink.sql`](supabase/migrations/0001_rtlink.sql).
   It creates the mirror tables, the action queue, the RLS policies and the
   identity helpers. It is safe to re-run.
3. Under **Authentication → Providers**, keep email/password enabled. Either turn
   off "Confirm email" for internal rollouts or approve accounts manually.
4. Under **Authentication → Users**, create an account for each employee **using
   the same email address as their RealtimeSuite profile**. That email is what
   links a Supabase user to a local employee; an account with no matching profile
   sees the "Almost there" screen.
5. Copy **Project URL** and the **anon** key into `rtlink/.env`:

```bash
cd rtlink
cp .env.example .env
# VITE_SUPABASE_URL=https://xxxx.supabase.co
# VITE_SUPABASE_ANON_KEY=eyJ...
npm install
npm run dev     # http://localhost:5175
```

## 2. Point the RealtimeSuite site at RTLink

On the LAN server, add the RTLink values to `backend/.env`. The site id is
generated once and then kept forever:

```bash
cd backend
.venv/bin/python -m app.cli rtlink-site-id
```

```ini
RTLINK_SUPABASE_URL=https://xxxx.supabase.co
RTLINK_SUPABASE_SERVICE_ROLE_KEY=<service_role key, never the anon key>
RTLINK_SITE_ID=<uuid from rtlink-site-id; keep it>
RTLINK_SITE_NAME=Denver Flagship
RTLINK_SYNC_MINUTES=5
RTLINK_CHANGE_SYNC=true
RTLINK_POLL_SECONDS=15
```

Restart the server. It pushes a baseline snapshot at startup, then every
`RTLINK_SYNC_MINUTES`, and about two seconds after any local change (it LISTENs on
the same `suite_realtime` channel as the rest of the suite). Employee actions are
polled every `RTLINK_POLL_SECONDS`.

### What is mirrored

`employees` (role `employee` only), `work_areas`, `shifts` (45 days back, 60
forward, including shift-pool openings), `tasks` with their assignment,
`announcements`, public `board_notes` (45 days), `time_off_requests`,
`overtime_requests`, `exception_requests`, `shift_swap_requests`,
`training_assignments`, plus the site row and the organization's feature flags.

Delivery is idempotent: rows are upserted on `id`, every row carries `synced_at`,
and rows that disappeared locally are deleted with `synced_at < snapshot_start`.
Pruning only happens after every upsert succeeded, so a partial failure cannot
delete live data.

### What employees can do

| Action | Applied with |
| --- | --- |
| Request time off | insert into `time_off_requests` (`pending`) |
| Request overtime | insert into `overtime_requests` (`pending`) |
| Report an exception | insert into `exception_requests` (`submitted`) |
| Ask for a swap | `create_shift_swap_request()` |
| Acknowledge a task | `acknowledge_task_assignment()` |
| Claim an open shift | `claim_shift_pool_shift()` |
| Clock in / out | `clock_in_shift()` / `clock_out_shift()`, with location check |
| Clock in (unscheduled) | `clock_in_unscheduled_shift()` |

Suspended, probationary and on-leave employees are blocked by the same
`require_active_employee` rule the LAN app uses — the message comes back into
RTLink as the error on that request.

Every action id is recorded in `public.rtlink_action_log` on the LAN database
before the result is acknowledged, so a redelivered action is never applied twice.
Three failed attempts mark the action `failed` with the reason, which the employee
sees in **Requests → History**.

### Checking sync

```bash
# manager/admin session on the LAN server
curl -H "Authorization: Bearer $TOKEN" localhost:8000/api/integrations/rtlink/status
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:8000/api/integrations/rtlink/sync
curl -X POST -H "Authorization: Bearer $TOKEN" localhost:8000/api/integrations/rtlink/pull

# from the server itself, even while the app is stopped
cd backend
.venv/bin/python -m app.cli rtlink-sync
.venv/bin/python -m app.cli rtlink-pull
.venv/bin/python -m app.cli rtlink-actions
```

`status` reports the last attempt/success, trigger, record counts, last error,
failure count and the last actions applied. If Supabase is unreachable the LAN
app is unaffected — scheduling keeps working and the failure shows up here.

## 3. Local development without a Supabase project

`scripts/mock-supabase.mjs` answers the slice of the Supabase API this app uses,
with sample data for Jordan Avery and a colleague. It also simulates the LAN
bridge: queued actions are applied about five seconds after they are sent (shift
claims, clock in/out, acknowledgements and new request rows), so the full loop is
visible without a backend.

```bash
cd rtlink
npm run mock    # http://127.0.0.1:54321
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=local-anon-key npm run dev
```

Accounts: `jordan@northwind.test` (the demo employee) and
`sam@northwind.test` (colleague for swaps) — password `RTLinkDemo!2026`.

It has no RLS and no persistence; never use it with real data.

## 4. Build and host

```bash
cd rtlink
npm run build     # tsc --noEmit && vite build → dist/
```

`dist/` is a static bundle; host it anywhere (Netlify, Vercel, Cloudflare Pages,
internal nginx). Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are
embedded and both are public by design.

Add the deployed origin to Supabase **Authentication → URL Configuration** so
confirmation and password-reset links return to RTLink.

## Verification

```bash
npm run typecheck
npm run build
```

The Supabase migration was applied twice against a scratch Postgres database with a
stubbed `auth` schema (16 tables, 16 policies), then probed as an `authenticated`
employee: only their own shift plus the open pool were visible, another employee's
request was hidden, a spoofed `rtlink_requests` insert was rewritten to the caller's
employee and site, and UPDATE/DELETE were denied.

The app was exercised against the mock for all five screens plus a full clock-in round
trip: the action was queued, applied by the simulated bridge, and the schedule refreshed
to "On the clock" without a manual reload.

For a real deployment, sign in with two employee accounts and confirm each sees only
their own shifts, tasks and requests, and that a non-employee Supabase account sees the
"Almost there" screen.
