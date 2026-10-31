# RealtimeCorp

The online corporate console for RealtimeSuite installations.

RealtimeSuite runs on a LAN and stays the operational source of truth. Each
installation pushes snapshots of its workforce data to this project's Supabase
database, and corporate users sign in here to see every company, location and
site they are responsible for.

```
RealtimeSuite (LAN, Postgres)                 RealtimeCorp (online)
┌──────────────────────────┐   snapshots    ┌───────────────────────────┐
│ shifts, tasks, people,   │ ─────────────▶ │ Supabase Postgres         │
│ requests, discipline,    │  service_role  │ corp_* mirror tables      │
│ training, notes          │  upserts       │ RLS by company membership │
└──────────────────────────┘                └─────────────┬─────────────┘
                                                          │ anon key + RLS
                                                          ▼
                                                    React console
```

## What corporate users get

| View | What it answers |
| --- | --- |
| Overview | Sites reporting, headcount, who is on shift, month hours and estimated payroll, pending requests, recent discipline |
| Sites & locations | Company profile, locations with time zones, connected sites with sync health and row counts |
| People & HR | Searchable employee roster across sites, onboarding state, rates, discipline history, training completion |
| Operations | Shifts, tasks and overtime for any date, per site |
| Payroll & finance | Monthly hours and gross pay estimate per employee, totals, CSV export, overtime and exception adjustments |
| Policies | Corporate policy library with draft/active/archived states (administrators and managers can edit) |
| Sync health | Per-site freshness, record counts of the latest snapshot, delivery history including failures |

The console is read-only for site data by design: the LAN server owns scheduling,
clock-in, discipline and payroll rates. Corporate users manage company details,
locations and policies.

## 1. Create the Supabase project

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run [`supabase/migrations/0001_realtimecorp.sql`](supabase/migrations/0001_realtimecorp.sql).
   It creates the `corp_*` tables, row level security and the helper RPCs, and is
   safe to re-run.
3. Under **Authentication → Providers** keep email/password enabled. Turn off
   "Confirm email" for internal rollouts, or keep it on and approve accounts
   manually. Under **Authentication → Users**, create the corporate accounts.
4. Copy **Project URL** and the **anon** key into `corp/.env`:

```bash
cd corp
cp .env.example .env
# VITE_SUPABASE_URL=https://xxxx.supabase.co
# VITE_SUPABASE_ANON_KEY=eyJ...
npm install
npm run dev     # http://localhost:5174
```

The first person to sign in has no company. The console asks for a company name,
creates it, and makes that account the first `corp_admin`
(`corp_bootstrap_company` RPC). Additional teammates are added to
`corp_members` with a role:

```sql
insert into public.corp_members (user_id, company_id, role, email, full_name)
values ('<auth user id>', '<company id>', 'corp_manager', 'ops@example.com', 'Ops Lead');
```

Roles: `corp_admin` (everything, including members and policies), `corp_manager`
(locations and policies), `corp_viewer` (read only). Row level security enforces
this in the database, not just in the UI.

## 2. Point a RealtimeSuite installation at the console

On the LAN server, open `backend/.env` and add the four required values. Get
`CORP_COMPANY_ID` from **Sites & locations → Company id**, and generate a stable
site id once:

```bash
cd backend
.venv/bin/python -m app.cli corp-site-id
```

```ini
CORP_SUPABASE_URL=https://xxxx.supabase.co
CORP_SUPABASE_SERVICE_ROLE_KEY=<service_role key, never the anon key>
CORP_SITE_ID=<uuid from corp-site-id; keep it forever>
CORP_COMPANY_ID=<company id from RealtimeCorp>
CORP_LOCATION_ID=<optional location id>
CORP_SITE_NAME=Denver Flagship
CORP_SYNC_MINUTES=5
CORP_CHANGE_SYNC=true
```

Restart the server. It pushes a baseline snapshot at startup, then:

- every `CORP_SYNC_MINUTES` (reconciliation, default 5), and
- about two seconds after any local change, detected by listening on the
  `suite_realtime` Postgres channel.

The service_role key stays on the LAN server. It is never sent to a browser.

### What is sent

`employees`, `work_areas`, `shifts`, `tasks`, `time_off_requests`,
`exception_requests`, `overtime_requests`, `discipline_actions`,
`training_assignments`, `board_notes` and `announcements` — with source ids and
timestamps preserved. Shifts and tasks cover 120 days back and 60 forward,
requests and notes 180/90 days back.

Delivery is idempotent: rows are upserted on `id`, every row carries `synced_at`,
and rows that disappeared locally are deleted with
`synced_at < snapshot_start`. A snapshot that fails part way is retried (three
attempts with backoff) and recorded as a failed `corp_sync_events` row instead of
pruning anything.

### Checking sync

```bash
# manager/admin session on the LAN server
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/integrations/corp/status
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/integrations/corp/sync

# from the server itself, even while the app is stopped
cd backend && .venv/bin/python -m app.cli corp-sync
```

`status` reports whether sync is configured, the last attempt/success time,
trigger (`startup` / `change` / `interval` / `manual` / `cli`), record counts, the
last error and failure count. If Supabase is unreachable the LAN app is
unaffected — scheduling keeps working and the failure shows up here and in the
console's Sync health view.

## 3. Local development without a Supabase project

`scripts/mock-supabase.mjs` is a dev-only stand-in that answers the slice of the
Supabase API this app uses, with in-memory sample data:

```bash
cd corp
npm run mock    # http://127.0.0.1:54321
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=local-anon-key npm run dev
```

Accounts: `corp@northwind.test` (administrator), `viewer@northwind.test`
(read only), `new@northwind.test` (no company, exercises the setup flow) — all
with password `CorpDemo!2026`. It has no row level security and no persistence;
never use it with real data.

## 4. Build and host

```bash
cd corp
npm run build     # tsc --noEmit && vite build → dist/
```

`dist/` is a static bundle. Host it anywhere (Netlify, Vercel, Cloudflare Pages,
an internal IIS/Nginx server). Only `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` are embedded, and both are public by design: row level
security decides what each signed-in user can read.

Add the deployed origin to Supabase **Authentication → URL Configuration** so
password reset and confirmation links return to the right place.

## Verification

```bash
npm run typecheck
npm run build
```

The Supabase migration was verified against a scratch Postgres database by
applying it twice (17 tables, RLS on all of them, 23 policies) and calling the
helper RPCs. The console was exercised against the mock: sign-in, all seven
views, creating a location and a policy, the read-only viewer role, and the
first-run company setup.
