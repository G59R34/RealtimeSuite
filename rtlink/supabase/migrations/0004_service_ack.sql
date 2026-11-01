-- 0004_service_ack.sql
--
-- The LAN site's service_role key applies queued actions and writes the outcome
-- back to rtlink_requests. It has no end-user JWT, so the validation trigger
-- could not resolve an employee and rejected every acknowledgement with
-- "This account is not linked to an employee on any site." — leaving actions
-- pending in RTLink forever.
--
-- This replaces the trigger function so service_role requests pass through. The
-- employee path is unchanged: a signed-in employee still has employee_id,
-- site_id and status forced from their own JWT.
--
-- Apply once in the Supabase SQL editor after 0001-0003. Safe to re-run.

create or replace function public.rtlink_requests_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- PostgREST runs the request as SET LOCAL ROLE and exposes the JWT role in
  -- both settings; a definer function cannot read current_user for the caller.
  v_claim_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), '');
  v_session_role text := coalesce(nullif(current_setting('role', true), ''), '');
  v_employee uuid;
  v_site uuid;
begin
  if v_claim_role = 'service_role' or v_session_role = 'service_role' then
    if jsonb_typeof(coalesce(new.payload, '{}'::jsonb)) <> 'object' then
      raise exception 'The request payload must be a JSON object.';
    end if;
    return new;
  end if;

  v_employee := public.rtlink_current_employee_id();
  v_site := public.rtlink_current_site_id();

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
