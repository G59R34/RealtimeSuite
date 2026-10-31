-- RTLink organization codes (Supabase / Postgres).
--
-- One Supabase project can serve more than one organization. Employees type a
-- short organization code before signing in; RTLink sends it as the
-- `x-rtlink-org` header on every request, and the identity helpers below scope
-- the signed-in email to the site that owns that code.
--
-- Applying this file is optional for a single-organization project: with no
-- header the helpers behave exactly as before (match by email only). Idempotent.

alter table public.rtlink_sites
  add column if not exists org_code text;

create unique index if not exists rtlink_sites_org_code_idx
  on public.rtlink_sites (lower(org_code))
  where org_code is not null;

-- Header, if the client sent one. PostgREST exposes request headers as a GUC.
create or replace function public.rtlink_requested_org_code()
returns text
language sql
stable
as $$
  select nullif(
    lower(trim(
      coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb
        ->> 'x-rtlink-org'
    )),
    ''
  )
$$;

create or replace function public.rtlink_current_employee_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select e.id
  from public.rtlink_employees e
  join public.rtlink_sites s on s.id = e.site_id
  where lower(e.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and (
      public.rtlink_requested_org_code() is null
      or lower(coalesce(s.org_code, '')) = public.rtlink_requested_org_code()
    )
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
  join public.rtlink_sites s on s.id = e.site_id
  where lower(e.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    and (
      public.rtlink_requested_org_code() is null
      or lower(coalesce(s.org_code, '')) = public.rtlink_requested_org_code()
    )
  order by e.created_at_local nulls last
  limit 1
$$;

-- Pre-sign-in lookup: the gate asks whether a code exists before collecting
-- credentials. Only public display fields are exposed.
create or replace function public.rtlink_lookup_org(p_code text)
returns table (site_id uuid, site_name text, organization_name text, org_code text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.name, s.organization_name, s.org_code
  from public.rtlink_sites s
  where s.org_code is not null
    and lower(s.org_code) = lower(trim(coalesce(p_code, '')))
  limit 1
$$;

grant execute on function public.rtlink_requested_org_code() to anon, authenticated;
grant execute on function public.rtlink_current_employee_id() to authenticated;
grant execute on function public.rtlink_current_site_id() to authenticated;
grant execute on function public.rtlink_lookup_org(text) to anon, authenticated;
