-- RealtimeCorp command channel (Supabase / Postgres).
--
-- Pay rates, permissions, shift multipliers, feature flags and organization
-- policies are owned by the corporate console. The console never mutates a
-- site's data directly: it queues a command here, and each RealtimeSuite
-- installation polls its own site's pending commands with the service_role key,
-- applies them locally and writes the outcome back.
--
-- Keep this file idempotent: it is re-run against existing projects.

-- ---------------------------------------------------------------------------
-- Current site configuration (pushed by RealtimeSuite, read by the console)
-- ---------------------------------------------------------------------------

create table if not exists public.corp_settings (
  site_id uuid primary key references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  feature_flags jsonb not null default '{}'::jsonb,
  policy_settings jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now()
);

create index if not exists corp_settings_company_idx on public.corp_settings (company_id);

-- ---------------------------------------------------------------------------
-- Command queue
-- ---------------------------------------------------------------------------

create table if not exists public.corp_commands (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.corp_sites(id) on delete cascade,
  company_id uuid not null references public.corp_companies(id) on delete cascade,
  kind text not null check (
    kind in (
      'set_pay_rate',
      'set_employee_permissions',
      'set_shift_multiplier',
      'set_feature_flags',
      'set_policy_settings'
    )
  ),
  target_id uuid,
  payload jsonb not null default '{}'::jsonb,
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'failed', 'cancelled')),
  requested_by uuid,
  requested_at timestamptz not null default now(),
  applied_at timestamptz,
  attempts integer not null default 0,
  error text
);

create index if not exists corp_commands_pending_idx
  on public.corp_commands (site_id, status, requested_at);

-- A command may only target a site that belongs to its own company, so a member
-- of one company cannot address another company's site by guessing a uuid.
create or replace function public.corp_commands_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid;
begin
  select company_id into v_company from public.corp_sites where id = new.site_id;
  if v_company is null then
    raise exception 'Unknown site %', new.site_id;
  end if;
  if v_company <> new.company_id then
    raise exception 'Site % does not belong to that company', new.site_id;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'pending';
    new.applied_at := null;
    new.attempts := 0;
    new.error := null;
    new.requested_at := coalesce(new.requested_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists corp_commands_validate on public.corp_commands;
create trigger corp_commands_validate
  before insert or update on public.corp_commands
  for each row execute function public.corp_commands_validate();

-- A pending command can be withdrawn by whoever raised it, or by a
-- company administrator. Applied/failed commands are history, not editable.
create or replace function public.corp_cancel_command(p_command uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.corp_commands;
begin
  select * into v_row from public.corp_commands where id = p_command;
  if not found then
    raise exception 'Command not found.';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'Only pending commands can be cancelled.';
  end if;
  if not (public.corp_can_manage(v_row.company_id) and v_row.requested_by = auth.uid())
     and not public.corp_is_admin(v_row.company_id) then
    raise exception 'You cannot cancel this command.';
  end if;
  update public.corp_commands set status = 'cancelled' where id = p_command;
  return p_command;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.corp_settings enable row level security;
alter table public.corp_commands enable row level security;

drop policy if exists corp_settings_read on public.corp_settings;
create policy corp_settings_read on public.corp_settings
  for select to authenticated using (public.corp_is_member(company_id));

drop policy if exists corp_commands_read on public.corp_commands;
create policy corp_commands_read on public.corp_commands
  for select to authenticated using (public.corp_is_member(company_id));

drop policy if exists corp_commands_insert on public.corp_commands;
create policy corp_commands_insert on public.corp_commands
  for insert to authenticated
  with check (public.corp_can_manage(company_id) and requested_by = auth.uid());

-- No update or delete policy on purpose: a signed-in corporate user cannot
-- rewrite or erase a command. The site's service_role key bypasses RLS to
-- write back applied/failed, and cancelling goes through the RPC above.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant select on public.corp_settings to authenticated;
grant select, insert on public.corp_commands to authenticated;
grant execute on function public.corp_cancel_command(uuid) to authenticated;
