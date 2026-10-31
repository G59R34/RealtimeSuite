-- RTLink schema (Supabase / Postgres).
--
-- RTLink is the employee-facing companion app for one RealtimeSuite
-- installation. The LAN server remains the source of truth: it pushes a
-- snapshot of the employee's schedule, tasks and requests into the mirror
-- tables below with the service_role key. Employees sign in with Supabase Auth
-- and read only their own rows.
--
-- Employees never write scheduling data directly. A request, acknowledgement or
-- clock-in becomes a row in public.rtlink_requests; the LAN server polls its
-- site's pending rows, applies them through the same SQL functions the LAN app
-- uses, and writes the outcome back.
--
-- Run once in the Supabase SQL editor (or `supabase db push`). Idempotent.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Site and settings
-- ---------------------------------------------------------------------------

create table if not exists public.rtlink_sites (
  id uuid primary key,
  name text not null default 'RealtimeSuite site',
  organization_name text,
  timezone text,
  app_version text,
  last_sync_at timestamptz,
  record_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rtlink_settings (
  site_id uuid primary key references public.rtlink_sites(id) on delete cascade,
  organization_name text,
  portal_label text,
  feature_flags jsonb not null default '{}'::jsonb,
  clock_in_required boolean not null default false,
  synced_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Mirrored RealtimeSuite records
--
-- Every mirror carries site_id and synced_at: repeated snapshots upsert on the
-- source id, and rows that disappeared locally are removed by
-- synced_at < snapshot_start.
-- ---------------------------------------------------------------------------

create table if not exists public.rtlink_employees (
  id uuid primary key,
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  email text,
  full_name text,
  role text,
  hourly_rate numeric(12, 2),
  is_training_manager boolean not null default false,
  onboarding_completed_at timestamptz,
  created_at_local timestamptz,
  updated_at_local timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists rtlink_employees_site_idx on public.rtlink_employees (site_id);
create unique index if not exists rtlink_employees_site_email_idx
  on public.rtlink_employees (site_id, lower(email));

create table if not exists public.rtlink_work_areas (
  id uuid primary key,
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  name text,
  color text,
  is_active boolean not null default true,
  synced_at timestamptz not null default now()
);

create index if not exists rtlink_work_areas_site_idx on public.rtlink_work_areas (site_id);

create table if not exists public.rtlink_shifts (
  id uuid primary key,
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  employee_id uuid,
  work_area_id uuid,
  work_area_name text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'scheduled',
  break_minutes integer not null default 0,
  worked_minutes integer,
  clocked_in_at timestamptz,
  clocked_out_at timestamptz,
  is_unscheduled_overtime boolean not null default false,
  is_shift_pool boolean not null default false,
  shift_pool_posted_at timestamptz,
  notes text,
  synced_at timestamptz not null default now()
);

create index if not exists rtlink_shifts_site_start_idx on public.rtlink_shifts (site_id, start_at);
create index if not exists rtlink_shifts_employee_idx on public.rtlink_shifts (employee_id);
create index if not exists rtlink_shifts_pool_idx on public.rtlink_shifts (site_id, is_shift_pool);

create table if not exists public.rtlink_tasks (
  id uuid primary key,
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  title text,
  description text,
  status text,
  priority text,
  start_at timestamptz,
  end_at timestamptz,
  work_area_id uuid,
  work_area_name text,
  assignee_id uuid,
  assignment_id uuid,
  acknowledged_at timestamptz,
  acknowledgment_note text,
  source_system text,
  synced_at timestamptz not null default now()
);

create index if not exists rtlink_tasks_assignee_idx on public.rtlink_tasks (assignee_id, start_at);
create index if not exists rtlink_tasks_site_idx on public.rtlink_tasks (site_id);

create table if not exists public.rtlink_announcements (
  id uuid primary key,
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  message text,
  is_active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists rtlink_announcements_site_idx on public.rtlink_announcements (site_id);

create table if not exists public.rtlink_board_notes (
  id uuid primary key,
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  note_date date,
  body text,
  created_at_local timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists rtlink_board_notes_site_idx on public.rtlink_board_notes (site_id, note_date);

create table if not exists public.rtlink_time_off_requests (
  id uuid primary key,
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  employee_id uuid not null,
  start_date date,
  end_date date,
  request_type text,
  reason text,
  status text,
  review_notes text,
  created_at_local timestamptz,
  reviewed_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists rtlink_time_off_employee_idx
  on public.rtlink_time_off_requests (employee_id, created_at_local desc);

create table if not exists public.rtlink_overtime_requests (
  id uuid primary key,
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  employee_id uuid not null,
  start_at timestamptz,
  end_at timestamptz,
  overtime_type text,
  note text,
  status text,
  review_notes text,
  created_at_local timestamptz,
  reviewed_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists rtlink_overtime_employee_idx
  on public.rtlink_overtime_requests (employee_id, created_at_local desc);

create table if not exists public.rtlink_exception_requests (
  id uuid primary key,
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  employee_id uuid not null,
  exception_code text,
  exception_type text,
  title text,
  details text,
  start_date date,
  end_date date,
  status text,
  review_notes text,
  created_at_local timestamptz,
  reviewed_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists rtlink_exception_employee_idx
  on public.rtlink_exception_requests (employee_id, created_at_local desc);

create table if not exists public.rtlink_swap_requests (
  id uuid primary key,
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  requester_id uuid not null,
  shift_id uuid,
  requested_employee_id uuid,
  status text,
  request_note text,
  review_note text,
  shift_start_at timestamptz,
  created_at_local timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists rtlink_swap_requester_idx
  on public.rtlink_swap_requests (requester_id, created_at_local desc);

create table if not exists public.rtlink_training_assignments (
  id uuid primary key,
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  employee_id uuid not null,
  course_title text,
  course_description text,
  status text,
  due_at timestamptz,
  completed_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists rtlink_training_employee_idx
  on public.rtlink_training_assignments (employee_id);

-- ---------------------------------------------------------------------------
-- Employee → site action queue
--
-- One row per employee action. The LAN server polls its own site's pending
-- rows with the service_role key, applies them locally and writes the outcome
-- back. Employees only ever insert.
-- ---------------------------------------------------------------------------

create table if not exists public.rtlink_requests (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  employee_id uuid not null,
  kind text not null check (
    kind in (
      'time_off.create',
      'overtime.create',
      'exception.create',
      'swap.create',
      'task.acknowledge',
      'shift.claim',
      'shift.clock_in',
      'shift.clock_out',
      'shift.clock_in_unscheduled'
    )
  ),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'failed', 'cancelled')),
  result text,
  error text,
  attempts integer not null default 0,
  requested_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists rtlink_requests_pending_idx
  on public.rtlink_requests (site_id, status, requested_at);
create index if not exists rtlink_requests_employee_idx
  on public.rtlink_requests (employee_id, requested_at desc);

create table if not exists public.rtlink_sync_events (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.rtlink_sites(id) on delete cascade,
  kind text not null,
  status text not null,
  record_counts jsonb not null default '{}'::jsonb,
  message text,
  received_at timestamptz not null default now()
);

create index if not exists rtlink_sync_events_site_idx
  on public.rtlink_sync_events (site_id, received_at desc);

-- ---------------------------------------------------------------------------
-- Identity helpers
--
-- One Supabase project serves one installation, so an employee is identified by
-- the email Supabase authenticated. site_id scopes every policy to this site.
-- ---------------------------------------------------------------------------

create or replace function public.rtlink_current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.id
  from public.rtlink_employees e
  where lower(e.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  order by e.created_at_local nulls last
  limit 1
$$;

create or replace function public.rtlink_current_site_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.site_id
  from public.rtlink_employees e
  where lower(e.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  order by e.created_at_local nulls last
  limit 1
$$;

-- Colleagues the employee may name on a shift swap, without exposing rates or
-- contact details from the employee mirror.
create or replace view public.rtlink_directory as
  select e.id, e.full_name, e.site_id
  from public.rtlink_employees e
  where e.site_id = public.rtlink_current_site_id();

-- A queued request is always attributed to the signed-in employee's own site
-- and starts pending, whatever the client sent.
create or replace function public.rtlink_requests_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee uuid := public.rtlink_current_employee_id();
  v_site uuid := public.rtlink_current_site_id();
begin
  if v_employee is null or v_site is null then
    raise exception 'This account is not linked to an employee on any site.';
  end if;
  if tg_op = 'INSERT' then
    new.employee_id := v_employee;
    new.site_id := v_site;
    new.status := 'pending';
    new.result := null;
    new.error := null;
    new.attempts := 0;
    new.requested_at := coalesce(new.requested_at, now());
    new.processed_at := null;
  end if;
  if jsonb_typeof(new.payload) <> 'object' then
    raise exception 'The request payload must be a JSON object.';
  end if;
  return new;
end;
$$;

drop trigger if exists rtlink_requests_validate on public.rtlink_requests;
create trigger rtlink_requests_validate
  before insert or update on public.rtlink_requests
  for each row execute function public.rtlink_requests_validate();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.rtlink_sites enable row level security;
alter table public.rtlink_settings enable row level security;
alter table public.rtlink_employees enable row level security;
alter table public.rtlink_work_areas enable row level security;
alter table public.rtlink_shifts enable row level security;
alter table public.rtlink_tasks enable row level security;
alter table public.rtlink_announcements enable row level security;
alter table public.rtlink_board_notes enable row level security;
alter table public.rtlink_time_off_requests enable row level security;
alter table public.rtlink_overtime_requests enable row level security;
alter table public.rtlink_exception_requests enable row level security;
alter table public.rtlink_swap_requests enable row level security;
alter table public.rtlink_training_assignments enable row level security;
alter table public.rtlink_requests enable row level security;
alter table public.rtlink_sync_events enable row level security;

drop policy if exists rtlink_sites_read on public.rtlink_sites;
create policy rtlink_sites_read on public.rtlink_sites
  for select to authenticated
  using (id = public.rtlink_current_site_id());

drop policy if exists rtlink_settings_read on public.rtlink_settings;
create policy rtlink_settings_read on public.rtlink_settings
  for select to authenticated
  using (site_id = public.rtlink_current_site_id());

drop policy if exists rtlink_employees_read on public.rtlink_employees;
create policy rtlink_employees_read on public.rtlink_employees
  for select to authenticated
  using (id = public.rtlink_current_employee_id());

drop policy if exists rtlink_work_areas_read on public.rtlink_work_areas;
create policy rtlink_work_areas_read on public.rtlink_work_areas
  for select to authenticated
  using (site_id = public.rtlink_current_site_id());

drop policy if exists rtlink_shifts_read on public.rtlink_shifts;
create policy rtlink_shifts_read on public.rtlink_shifts
  for select to authenticated
  using (
    site_id = public.rtlink_current_site_id()
    and (
      employee_id = public.rtlink_current_employee_id()
      or (is_shift_pool and employee_id is null)
    )
  );

drop policy if exists rtlink_tasks_read on public.rtlink_tasks;
create policy rtlink_tasks_read on public.rtlink_tasks
  for select to authenticated
  using (
    site_id = public.rtlink_current_site_id()
    and assignee_id = public.rtlink_current_employee_id()
  );

drop policy if exists rtlink_announcements_read on public.rtlink_announcements;
create policy rtlink_announcements_read on public.rtlink_announcements
  for select to authenticated
  using (site_id = public.rtlink_current_site_id());

drop policy if exists rtlink_board_notes_read on public.rtlink_board_notes;
create policy rtlink_board_notes_read on public.rtlink_board_notes
  for select to authenticated
  using (site_id = public.rtlink_current_site_id());

drop policy if exists rtlink_time_off_read on public.rtlink_time_off_requests;
create policy rtlink_time_off_read on public.rtlink_time_off_requests
  for select to authenticated
  using (employee_id = public.rtlink_current_employee_id());

drop policy if exists rtlink_overtime_read on public.rtlink_overtime_requests;
create policy rtlink_overtime_read on public.rtlink_overtime_requests
  for select to authenticated
  using (employee_id = public.rtlink_current_employee_id());

drop policy if exists rtlink_exception_read on public.rtlink_exception_requests;
create policy rtlink_exception_read on public.rtlink_exception_requests
  for select to authenticated
  using (employee_id = public.rtlink_current_employee_id());

drop policy if exists rtlink_swap_read on public.rtlink_swap_requests;
create policy rtlink_swap_read on public.rtlink_swap_requests
  for select to authenticated
  using (
    requester_id = public.rtlink_current_employee_id()
    or requested_employee_id = public.rtlink_current_employee_id()
  );

drop policy if exists rtlink_training_read on public.rtlink_training_assignments;
create policy rtlink_training_read on public.rtlink_training_assignments
  for select to authenticated
  using (employee_id = public.rtlink_current_employee_id());

drop policy if exists rtlink_requests_read on public.rtlink_requests;
create policy rtlink_requests_read on public.rtlink_requests
  for select to authenticated
  using (
    employee_id = public.rtlink_current_employee_id()
    and site_id = public.rtlink_current_site_id()
  );

drop policy if exists rtlink_requests_insert on public.rtlink_requests;
create policy rtlink_requests_insert on public.rtlink_requests
  for insert to authenticated
  with check (
    employee_id = public.rtlink_current_employee_id()
    and site_id = public.rtlink_current_site_id()
    and status = 'pending'
  );

drop policy if exists rtlink_sync_events_read on public.rtlink_sync_events;
create policy rtlink_sync_events_read on public.rtlink_sync_events
  for select to authenticated
  using (site_id = public.rtlink_current_site_id());

-- No update or delete policy anywhere: employees read their data and queue
-- actions. The LAN server's service_role key bypasses RLS to refresh the mirror
-- and write outcomes back.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant select on public.rtlink_sites to authenticated;
grant select on public.rtlink_settings to authenticated;
grant select on public.rtlink_employees to authenticated;
grant select on public.rtlink_work_areas to authenticated;
grant select on public.rtlink_shifts to authenticated;
grant select on public.rtlink_tasks to authenticated;
grant select on public.rtlink_announcements to authenticated;
grant select on public.rtlink_board_notes to authenticated;
grant select on public.rtlink_time_off_requests to authenticated;
grant select on public.rtlink_overtime_requests to authenticated;
grant select on public.rtlink_exception_requests to authenticated;
grant select on public.rtlink_swap_requests to authenticated;
grant select on public.rtlink_training_assignments to authenticated;
grant select, insert on public.rtlink_requests to authenticated;
grant select on public.rtlink_sync_events to authenticated;
grant select on public.rtlink_directory to authenticated;
grant execute on function public.rtlink_current_employee_id() to authenticated;
grant execute on function public.rtlink_current_site_id() to authenticated;
