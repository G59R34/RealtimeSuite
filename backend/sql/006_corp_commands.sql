-- Corporate command log: the local record of every RealtimeCorp change applied
-- to this installation. Pay rates, roles, shift multipliers, feature flags and
-- organization policy are owned by the corporate console (see app/corp_commands.py);
-- this table makes delivery idempotent (a command id applies once) and gives the
-- site an audit trail of what corporate changed and when.
-- Idempotent so it can run on every startup (see app.db.apply_additions).

create table if not exists public.corp_command_log (
  command_id uuid primary key,
  kind text not null,
  target_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempts integer not null default 0,
  error text,
  received_at timestamptz not null default now(),
  applied_at timestamptz,
  constraint corp_command_log_status_valid
    check (status in ('pending', 'applied', 'failed'))
);

create index if not exists idx_corp_command_log_received
  on public.corp_command_log (received_at desc);

create index if not exists idx_corp_command_log_status
  on public.corp_command_log (status);
