-- RealtimeSuite variant of 037_location_clock_in_geofence.sql
-- Same behavior without the PostGIS dependency (haversine distance in SQL).

create table if not exists public.organization_clock_in_locations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  latitude double precision not null,
  longitude double precision not null,
  radius_meters double precision not null check (radius_meters > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_organization_clock_in_locations_updated_at on public.organization_clock_in_locations;
create trigger trg_organization_clock_in_locations_updated_at
before update on public.organization_clock_in_locations
for each row execute function public.touch_updated_at();

create index if not exists idx_org_clock_in_locations_org_active
  on public.organization_clock_in_locations(organization_id, is_active);

create or replace function public.verify_clock_in_location(
  p_organization_id uuid,
  p_shift_id uuid default null,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_accuracy_meters double precision default null,
  p_is_unscheduled boolean default false
)
returns table (
  is_allowed boolean,
  message text,
  distance_meters double precision,
  location_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift_org_id uuid;
  v_shift_employee_id uuid;
  v_is_admin boolean := public.is_admin(auth.uid());
  v_nearest_name text;
  v_nearest_radius double precision;
  v_nearest_distance double precision;
  v_allowed_radius double precision;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  if p_organization_id is null then
    raise exception 'Organization is required.';
  end if;

  if not public.is_same_org(p_organization_id, auth.uid()) then
    raise exception 'Cannot verify location across organizations.';
  end if;

  if p_shift_id is not null then
    select s.organization_id, s.employee_id
      into v_shift_org_id, v_shift_employee_id
    from public.shifts s
    where s.id = p_shift_id;

    if v_shift_org_id is null then
      raise exception 'Shift not found.';
    end if;

    if v_shift_org_id <> p_organization_id then
      raise exception 'Shift does not belong to organization.';
    end if;

    if not v_is_admin and v_shift_employee_id <> auth.uid() then
      raise exception 'You can only verify location for your own shift.';
    end if;
  end if;

  if p_latitude is null or p_longitude is null then
    return query select false, 'Location is required to clock in.', null::double precision, null::text;
    return;
  end if;

  select
    l.name,
    l.radius_meters,
    6371000 * 2 * asin(sqrt(
      power(sin(radians(l.latitude - p_latitude) / 2), 2)
      + cos(radians(p_latitude)) * cos(radians(l.latitude))
      * power(sin(radians(l.longitude - p_longitude) / 2), 2)
    ))
  into v_nearest_name, v_nearest_radius, v_nearest_distance
  from public.organization_clock_in_locations l
  where l.organization_id = p_organization_id
    and l.is_active = true
  order by
    6371000 * 2 * asin(sqrt(
      power(sin(radians(l.latitude - p_latitude) / 2), 2)
      + cos(radians(p_latitude)) * cos(radians(l.latitude))
      * power(sin(radians(l.longitude - p_longitude) / 2), 2)
    )) asc
  limit 1;

  if v_nearest_name is null then
    return query select false, 'No active clock-in locations are configured for your organization.', null::double precision, null::text;
    return;
  end if;

  v_allowed_radius := v_nearest_radius + greatest(coalesce(p_accuracy_meters, 0), 0);

  if v_nearest_distance <= v_allowed_radius then
    return query select true, format('Clock-in location verified at %s.', v_nearest_name), v_nearest_distance, v_nearest_name;
    return;
  end if;

  return query
  select
    false,
    format('Outside allowed range for %s. You are %.0fm away; limit %.0fm.', v_nearest_name, v_nearest_distance, v_allowed_radius),
    v_nearest_distance,
    v_nearest_name;
end;
$$;
