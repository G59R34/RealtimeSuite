-- RealtimeCorp schema (Supabase / Postgres).
--
-- RealtimeCorp is the online corporate application. Each LAN RealtimeSuite
-- installation ("site") pushes a snapshot of its own workforce data into the
-- mirror tables below using the service_role key. Corporate users sign in with
-- Supabase Auth and read only the companies they are a member of.
--
-- Run this file once in the Supabase SQL editor (or `supabase db push`).
-- It is idempotent: safe to re-run after edits to policies/functions.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Companies, locations, membership
-- ---------------------------------------------------------------------------

create table if not exists public.corp_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  industry text,
  headquarters text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.corp_locations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  name text not null,
  code text,
  address text,
  timezone text not null default 'America/Denver',
  status text not null default 'active'
    check (status in ('active', 'paused', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists corp_locations_company_idx
  on public.corp_locations (company_id);

create table if not exists public.corp_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  location_id uuid references public.corp_locations(id) on delete set null,
  role text not null default 'corp_viewer'
    check (role in ('corp_admin', 'corp_manager', 'corp_viewer')),
  full_name text,
  email text,
  created_at timestamptz not null default now(),
  unique (user_id, company_id)
);

create index if not exists corp_members_user_idx on public.corp_members (user_id);
create index if not exists corp_members_company_idx on public.corp_members (company_id);

-- ---------------------------------------------------------------------------
-- Sites (one per RealtimeSuite installation)
-- ---------------------------------------------------------------------------

create table if not exists public.corp_sites (
  id uuid primary key,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  location_id uuid references public.corp_locations(id) on delete set null,
  name text not null default 'RealtimeSuite site',
  app_version text,
  last_sync_at timestamptz,
  record_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists corp_sites_company_idx on public.corp_sites (company_id);

-- ---------------------------------------------------------------------------
-- Mirrored RealtimeSuite records
--
-- Every mirror table carries (id, site_id, company_id, synced_at). The source
-- row ids are preserved so repeated snapshots upsert in place, and rows that
-- disappeared locally are removed by synced_at < snapshot time.
-- ---------------------------------------------------------------------------

create table if not exists public.corp_employees (
  id uuid primary key,
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  email text,
  full_name text,
  role text,
  hourly_rate numeric(12, 2),
  onboarding_completed_at timestamptz,
  is_training_manager boolean not null default false,
  is_active boolean not null default true,
  created_at_local timestamptz,
  updated_at_local timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists corp_employees_company_idx on public.corp_employees (company_id);
create index if not exists corp_employees_site_idx on public.corp_employees (site_id);

create table if not exists public.corp_work_areas (
  id uuid primary key,
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  name text,
  color text,
  is_active boolean not null default true,
  synced_at timestamptz not null default now()
);

create index if not exists corp_work_areas_company_idx on public.corp_work_areas (company_id);

create table if not exists public.corp_shifts (
  id uuid primary key,
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  employee_id uuid,
  employee_name text,
  work_area_id uuid,
  work_area_name text,
  start_at timestamptz,
  end_at timestamptz,
  status text,
  break_minutes integer not null default 0,
  worked_minutes integer,
  pay_multiplier numeric(6, 2),
  clocked_in_at timestamptz,
  clocked_out_at timestamptz,
  is_unscheduled_overtime boolean not null default false,
  synced_at timestamptz not null default now()
);

create index if not exists corp_shifts_company_idx on public.corp_shifts (company_id);
create index if not exists corp_shifts_site_start_idx on public.corp_shifts (site_id, start_at);
create index if not exists corp_shifts_employee_idx on public.corp_shifts (employee_id);

create table if not exists public.corp_tasks (
  id uuid primary key,
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  title text,
  description text,
  status text,
  priority text,
  start_at timestamptz,
  end_at timestamptz,
  work_area_id uuid,
  work_area_name text,
  assignee_id uuid,
  assignee_name text,
  acknowledged_at timestamptz,
  source_system text,
  synced_at timestamptz not null default now()
);

create index if not exists corp_tasks_company_idx on public.corp_tasks (company_id);
create index if not exists corp_tasks_site_start_idx on public.corp_tasks (site_id, start_at);

create table if not exists public.corp_time_off_requests (
  id uuid primary key,
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  employee_id uuid,
  employee_name text,
  start_date date,
  end_date date,
  request_type text,
  reason text,
  status text,
  created_at_local timestamptz,
  reviewed_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists corp_time_off_company_idx on public.corp_time_off_requests (company_id);

create table if not exists public.corp_exception_requests (
  id uuid primary key,
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  employee_id uuid,
  employee_name text,
  exception_code text,
  exception_type text,
  title text,
  details text,
  start_date date,
  end_date date,
  status text,
  created_at_local timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists corp_exception_company_idx on public.corp_exception_requests (company_id);

create table if not exists public.corp_overtime_requests (
  id uuid primary key,
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  employee_id uuid,
  employee_name text,
  start_at timestamptz,
  end_at timestamptz,
  overtime_type text,
  note text,
  status text,
  created_at_local timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists corp_overtime_company_idx on public.corp_overtime_requests (company_id);

create table if not exists public.corp_discipline_actions (
  id uuid primary key,
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  employee_id uuid,
  employee_name text,
  title text,
  details text,
  severity text,
  punishment_type text,
  status text,
  leave_starts_on date,
  leave_ends_on date,
  created_at_local timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists corp_discipline_company_idx on public.corp_discipline_actions (company_id);

create table if not exists public.corp_training_assignments (
  id uuid primary key,
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  employee_id uuid,
  employee_name text,
  course_title text,
  status text,
  due_at timestamptz,
  completed_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists corp_training_company_idx on public.corp_training_assignments (company_id);

create table if not exists public.corp_board_notes (
  id uuid primary key,
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  note_date date,
  body text,
  is_public boolean not null default false,
  created_at_local timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists corp_board_notes_company_idx on public.corp_board_notes (company_id);

create table if not exists public.corp_announcements (
  id uuid primary key,
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  message text,
  is_active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists corp_announcements_company_idx on public.corp_announcements (company_id);

create table if not exists public.corp_sync_events (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  kind text not null default 'snapshot',
  status text not null default 'ok',
  record_counts jsonb not null default '{}'::jsonb,
  message text,
  received_at timestamptz not null default now()
);

create index if not exists corp_sync_events_company_idx
  on public.corp_sync_events (company_id, received_at desc);

-- ---------------------------------------------------------------------------
-- Corporate policy administration (written by corporate users)
-- ---------------------------------------------------------------------------

create table if not exists public.corp_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  title text not null,
  category text not null default 'general',
  body text not null default '',
  version integer not null default 1,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'archived')),
  effective_on date,
  owner text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists corp_policies_company_idx on public.corp_policies (company_id);

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------

create or replace function public.corp_is_member(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.corp_members m
    where m.company_id = p_company and m.user_id = auth.uid()
  );
$$;

create or replace function public.corp_can_manage(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.corp_members m
    where m.company_id = p_company
      and m.user_id = auth.uid()
      and m.role in ('corp_admin', 'corp_manager')
  );
$$;

create or replace function public.corp_is_admin(p_company uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.corp_members m
    where m.company_id = p_company
      and m.user_id = auth.uid()
      and m.role = 'corp_admin'
  );
$$;

-- Everything the signed-in user may see, one row per company membership.
create or replace function public.corp_my_scope()
returns table (
  company_id uuid,
  company_name text,
  company_slug text,
  location_id uuid,
  location_name text,
  role text,
  email text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.name,
    c.slug,
    m.location_id,
    l.name,
    m.role,
    coalesce(m.email, u.email)
  from public.corp_members m
  join public.corp_companies c on c.id = m.company_id
  left join public.corp_locations l on l.id = m.location_id
  left join auth.users u on u.id = m.user_id
  where m.user_id = auth.uid()
  order by c.name;
$$;

-- First sign-in bootstrap: a user with no memberships may create one company and
-- become its administrator. Returns the new company id.
create or replace function public.corp_bootstrap_company(
  p_name text,
  p_location text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  if exists (select 1 from public.corp_members where user_id = auth.uid()) then
    raise exception 'This account already belongs to a company.';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'A company name is required.';
  end if;

  insert into public.corp_companies (name)
  values (trim(p_name))
  returning id into v_company;

  insert into public.corp_locations (company_id, name)
  values (v_company, coalesce(nullif(trim(p_location), ''), 'Headquarters'));

  select email into v_email from auth.users where id = auth.uid();

  insert into public.corp_members (user_id, company_id, role, email)
  values (auth.uid(), v_company, 'corp_admin', v_email);

  return v_company;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.corp_companies enable row level security;
alter table public.corp_locations enable row level security;
alter table public.corp_members enable row level security;
alter table public.corp_sites enable row level security;
alter table public.corp_employees enable row level security;
alter table public.corp_work_areas enable row level security;
alter table public.corp_shifts enable row level security;
alter table public.corp_tasks enable row level security;
alter table public.corp_time_off_requests enable row level security;
alter table public.corp_exception_requests enable row level security;
alter table public.corp_overtime_requests enable row level security;
alter table public.corp_discipline_actions enable row level security;
alter table public.corp_training_assignments enable row level security;
alter table public.corp_board_notes enable row level security;
alter table public.corp_announcements enable row level security;
alter table public.corp_sync_events enable row level security;
alter table public.corp_policies enable row level security;

-- Companies / locations: members read, administrators write.
drop policy if exists corp_companies_read on public.corp_companies;
create policy corp_companies_read on public.corp_companies
  for select to authenticated using (public.corp_is_member(id));

drop policy if exists corp_companies_update on public.corp_companies;
create policy corp_companies_update on public.corp_companies
  for update to authenticated
  using (public.corp_is_admin(id)) with check (public.corp_is_admin(id));

drop policy if exists corp_locations_read on public.corp_locations;
create policy corp_locations_read on public.corp_locations
  for select to authenticated using (public.corp_is_member(company_id));

drop policy if exists corp_locations_write on public.corp_locations;
create policy corp_locations_write on public.corp_locations
  for all to authenticated
  using (public.corp_can_manage(company_id))
  with check (public.corp_can_manage(company_id));

-- Membership: you can read your own row; administrators manage the roster.
drop policy if exists corp_members_read on public.corp_members;
create policy corp_members_read on public.corp_members
  for select to authenticated
  using (user_id = auth.uid() or public.corp_is_member(company_id));

drop policy if exists corp_members_write on public.corp_members;
create policy corp_members_write on public.corp_members
  for all to authenticated
  using (public.corp_is_admin(company_id))
  with check (public.corp_is_admin(company_id));

-- Sites and every mirror table: members read, only the service role writes.
do $$
declare
  t text;
begin
  foreach t in array array[
    'corp_sites', 'corp_employees', 'corp_work_areas', 'corp_shifts', 'corp_tasks',
    'corp_time_off_requests', 'corp_exception_requests', 'corp_overtime_requests',
    'corp_discipline_actions', 'corp_training_assignments', 'corp_board_notes',
    'corp_announcements', 'corp_sync_events'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.corp_is_member(company_id))',
      t || '_read', t
    );
  end loop;
end;
$$;

-- Policies: members read active/draft policies, managers write.
drop policy if exists corp_policies_read on public.corp_policies;
create policy corp_policies_read on public.corp_policies
  for select to authenticated using (public.corp_is_member(company_id));

drop policy if exists corp_policies_insert on public.corp_policies;
create policy corp_policies_insert on public.corp_policies
  for insert to authenticated with check (public.corp_can_manage(company_id));

drop policy if exists corp_policies_update on public.corp_policies;
create policy corp_policies_update on public.corp_policies
  for update to authenticated
  using (public.corp_can_manage(company_id))
  with check (public.corp_can_manage(company_id));

drop policy if exists corp_policies_delete on public.corp_policies;
create policy corp_policies_delete on public.corp_policies
  for delete to authenticated using (public.corp_can_manage(company_id));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant usage on schema public to authenticated;
grant select on
  public.corp_companies, public.corp_locations, public.corp_members,
  public.corp_sites, public.corp_employees, public.corp_work_areas,
  public.corp_shifts, public.corp_tasks, public.corp_time_off_requests,
  public.corp_exception_requests, public.corp_overtime_requests,
  public.corp_discipline_actions, public.corp_training_assignments,
  public.corp_board_notes, public.corp_announcements, public.corp_sync_events,
  public.corp_policies
to authenticated;

grant insert, update, delete on
  public.corp_policies, public.corp_locations, public.corp_members
to authenticated;

grant insert, update on public.corp_companies to authenticated;
grant execute on function public.corp_my_scope() to authenticated;
grant execute on function public.corp_bootstrap_company(text, text) to authenticated;
grant execute on function public.corp_is_member(uuid) to authenticated;
grant execute on function public.corp_can_manage(uuid) to authenticated;
grant execute on function public.corp_is_admin(uuid) to authenticated;
