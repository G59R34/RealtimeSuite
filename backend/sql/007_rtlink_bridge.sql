-- RTLink bridge bookkeeping.
--
-- RTLink (the employee companion app) queues employee actions in Supabase. This
-- site polls its own queue and applies each action locally through the same SQL
-- functions the LAN app uses. Every action id is recorded here before the
-- outcome is acknowledged, so a redelivered action is never applied twice.
--
-- Idempotent addition: applied on every startup.

create table if not exists public.rtlink_action_log (
  action_id uuid primary key,
  kind text not null,
  employee_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'failed')),
  attempts integer not null default 0,
  error text,
  result text,
  received_at timestamptz not null default now(),
  applied_at timestamptz
);

create index if not exists rtlink_action_log_received_idx
  on public.rtlink_action_log (received_at desc);

create index if not exists rtlink_action_log_status_idx
  on public.rtlink_action_log (status, received_at);
