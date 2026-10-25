-- Time nullifications: a window inside a shift where the employee should not
-- receive any tasks. Employees request the window, an operator approves or
-- denies it, and approved windows block task assignment for that time.
-- Idempotent so it can run on every startup (see app.db.apply_additions) and on
-- databases created before this table existed.

create table if not exists public.time_nullification_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete cascade,
  shift_id uuid references public.shifts(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text not null default '',
  status text not null default 'pending',
  requested_by uuid references public.profiles(id) on delete set null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_nullification_window_valid check (end_at > start_at),
  constraint time_nullification_status_valid
    check (status in ('pending', 'approved', 'denied', 'cancelled'))
);

create index if not exists idx_time_nullifications_employee
  on public.time_nullification_requests (employee_id, start_at, end_at);

create index if not exists idx_time_nullifications_org_status
  on public.time_nullification_requests (organization_id, status, start_at);

drop trigger if exists trg_time_nullifications_updated_at on public.time_nullification_requests;
create trigger trg_time_nullifications_updated_at
before update on public.time_nullification_requests
for each row execute function public.touch_updated_at();
