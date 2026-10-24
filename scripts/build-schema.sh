#!/usr/bin/env bash
# Regenerates backend/sql/001_schema.sql from the reference WaterROC migrations.
# Dev-only helper. Requires postgresql@16 on PATH (or PGBIN set).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="$ROOT/WaterROC-NextGeneration/supabase/sql"
OUT="$ROOT/backend/sql/001_schema.sql"
PGBIN="${PGBIN:-$(brew --prefix postgresql@16 2>/dev/null)/bin}"
PGDATA="$ROOT/backend/.pgdata-ref"
PGPORT="${PGPORT:-55432}"
DB="suite_ref"

export PATH="$PGBIN:$PATH"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

if [ ! -d "$PGDATA" ]; then
  initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
  printf "port = %s\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = '/tmp'\n" "$PGPORT" >> "$PGDATA/postgresql.conf"
fi

if ! pg_isready -h 127.0.0.1 -p "$PGPORT" -q; then
  pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" -w start >/dev/null
fi

dropdb -h 127.0.0.1 -p "$PGPORT" -U postgres --if-exists "$DB"
createdb -h 127.0.0.1 -p "$PGPORT" -U postgres "$DB"

PSQL=(psql -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q)

# --- Supabase compatibility prelude (stripped from the generated schema) ---
"${PSQL[@]}" <<'SQL'
create extension if not exists pgcrypto;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'authenticated')
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
SQL

MIGRATIONS=(
  001_watersuite_schema.sql 002_watersuite_bootstrap.sql 003_weta_and_task_ack.sql
  004_exception_requests.sql 006_shift_logic_and_exception_codes.sql 007_shift_clock_in.sql
  008_site_announcements.sql 009_shift_clock_out.sql 010_server_now.sql
  011_unscheduled_overtime_clock_in.sql 012_profile_helpful_info.sql
  013_multi_tenant_organizations.sql 014_org_admin_portal_label.sql 016_task_source_system.sql
  017_payroll_hours_and_rates.sql 018_employee_messages_and_note_tasks.sql
  019_tasks_must_be_within_shift_windows.sql 020_shift_delete_cascades_tasks.sql
  021_bootstrap_first_org_admin_role_update.sql 022_org_settings_controls.sql
  023_shift_pool.sql 024_clock_in_buffer_and_early_in_unpaid.sql
  025_same_day_overtime_requests.sql 026_day_punch_multi_shift_clocking.sql
  027_org_custom_onboarding.sql 028_onboarding_email_templates.sql
  029_admin_training_only_profiles.sql 030_training_manager_role_and_training_settings.sql
  031_rocconnector_tracking.sql 032_employee_message_admin_recipients_rpc.sql
  033_employee_portal_rpc_grants.sql 034_training_courses_and_assignments.sql
  035_notifications_preferences_and_shift_guardrails.sql 036_admin_live_shift_updates.sql
  __037_geofence__ 038_break_task_auto_resume.sql
  039_weta_discipline_actions.sql 040_rocoperator_clock_in_audit.sql
  048_shift_starting_soon_notifications.sql 049_shift_intelligence_swap_marketplace_and_pto_impact.sql
  050_shift_auto_clock_out_after_30m.sql 051_overtime_assignment_types_and_admin_assignment.sql
  052_employee_response_for_assigned_voluntary_overtime.sql
  053_login_branding_and_org_code_lookup.sql 055_experience_builder_modules.sql
  056_experience_builder_live_element_config.sql 057_management_shift_admin_equivalent_access.sql
  058_retail_floor_simulation_org_setting.sql
  059_retail_floor_chaos_backend_and_employee_leadership_messaging.sql
  060_retail_chaos_stationary_and_message_rpc.sql 061_retail_chaos_rpc_compat.sql
  078_employee_message_threads_and_generic_send.sql
)

for m in "${MIGRATIONS[@]}"; do
  SRC="$REF/$m"
  [ "$m" = "__037_geofence__" ] && SRC="$ROOT/backend/sql/ref/037_geofence_no_postgis.sql"
  if [ ! -f "$SRC" ]; then
    echo "missing migration: $m" >&2
    exit 1
  fi
  if ! "${PSQL[@]}" -f "$SRC" >/tmp/rs-migrate.log 2>&1; then
    echo "FAILED: $m" >&2
    tail -20 /tmp/rs-migrate.log >&2
    exit 1
  fi
  echo "applied $m"
done

# --- Scheduling-only cleanup ---
"${PSQL[@]}" <<'SQL'
-- Drop every RLS policy; access control lives in the FastAPI layer.
do $$
declare p record;
begin
  for p in select schemaname, tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- Supabase auth trigger is replaced by explicit user provisioning in the API.
drop trigger if exists on_auth_user_created_or_updated on auth.users;
drop function if exists public.handle_new_user() cascade;

-- Single-organization install: no join codes, no public org lookup.
drop trigger if exists trg_organizations_normalize_join_code on public.organizations;
drop function if exists public.normalize_organization_join_code() cascade;
drop function if exists public.handle_auth_user_sync() cascade;
drop function if exists public.fetch_login_branding_by_join_code(text);
alter table public.organizations drop constraint if exists organizations_join_code_key;
alter table public.organizations drop column if exists join_code;
SQL

# RLS is still enabled on tables; disable it so non-owner connections behave predictably.
"${PSQL[@]}" -At -c "select 'alter table public.' || quote_ident(tablename) || ' disable row level security;' from pg_tables where schemaname='public'" > /tmp/rs-rls.sql
"${PSQL[@]}" -f /tmp/rs-rls.sql >/dev/null

pg_dump -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB" --schema-only --schema=public \
  --no-owner --no-privileges --no-comments > /tmp/rs-schema.sql

# Rename WaterROC-specific database identifiers consistently across definitions and bodies,
# and drop the pg_dump preamble that cannot run on a fresh database.
sed -e 's/rocconnector_tracking/activity_tracking/g' \
    -e 's/rocoperator/operator/g' \
    -e 's/ROCconnector/activity/g' \
    /tmp/rs-schema.sql \
  | sed -e '/^--$/d' \
        -e '/^-- PostgreSQL database dump/d' \
        -e '/^-- Dumped from database version/d' \
        -e '/^-- Dumped by pg_dump version/d' \
        -e '/^\\restrict /d' \
        -e '/^\\unrestrict /d' \
        -e '/^CREATE SCHEMA public;$/d' \
  > /tmp/rs-schema-renamed.sql

{
  cat <<'HEADER'
-- RealtimeSuite schema (generated by scripts/build-schema.sh)
-- Scheduling-only: no aviation, no UAL DEN, no personal mode, no RLS.
-- Run as the database owner.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Local auth compatibility shim (replaces Supabase Auth)
-- ---------------------------------------------------------------------------
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text not null default '',
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'authenticated')
$$;

-- ---------------------------------------------------------------------------
-- Application schema
-- ---------------------------------------------------------------------------
HEADER
  cat /tmp/rs-schema-renamed.sql
  cat <<'FOOTER'

-- ---------------------------------------------------------------------------
-- Realtime: every watched table publishes a row event on the suite channel.
-- ---------------------------------------------------------------------------
create or replace function public.suite_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  payload jsonb;
begin
  payload := jsonb_build_object(
    'table', tg_table_name,
    'op', lower(tg_op),
    'new', case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end,
    'old', case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end
  );
  perform pg_notify('suite_realtime', payload::text);
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','work_areas','shifts','tasks','task_assignments',
    'time_off_requests','exception_requests','overtime_requests',
    'shift_swap_requests','site_announcements','employee_messages',
    'training_courses','training_assignments','app_notifications',
    'employee_work_preferences','discipline_actions','activity_tracking',
    'organization_clock_in_locations'
  ] loop
    execute format('drop trigger if exists suite_notify_row on public.%I', t);
    execute format(
      'create trigger suite_notify_row after insert or update or delete on public.%I for each row execute function public.suite_notify()',
      t
    );
  end loop;
end $$;
FOOTER
} > "$OUT"

echo "wrote $OUT ($(wc -l < "$OUT") lines)"
