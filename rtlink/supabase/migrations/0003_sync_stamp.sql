-- 0003_sync_stamp.sql
--
-- One tiny read the employee app can poll every couple of seconds. It returns a
-- value that changes whenever the site delivers a new snapshot (or records a
-- sync event), so RTLink reloads its workspace only when something actually
-- changed instead of re-reading every table on a timer.
--
-- Apply once in the Supabase SQL editor after 0001 and 0002. Safe to re-run.

create or replace function public.rtlink_sync_stamp()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(max(e.received_at)::text, '-') || ':' || count(*)::text
  from public.rtlink_sync_events e
  where e.site_id = public.rtlink_current_site_id()
$$;

grant execute on function public.rtlink_sync_stamp() to authenticated;
