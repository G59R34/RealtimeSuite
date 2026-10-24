-- Board notes: free-text notes pinned to a board day.
-- Idempotent so it can run on every startup (see app.db.apply_additions) and on
-- databases created before this table existed.

create table if not exists public.board_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  note_date date not null default current_date,
  body text not null,
  is_public boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint board_notes_body_not_empty check (length(btrim(body)) > 0)
);

-- A note can hang off the whole board, a single employee row, or a work area row.
alter table public.board_notes
  add column if not exists employee_id uuid references public.profiles(id) on delete cascade;
alter table public.board_notes
  add column if not exists work_area_id uuid references public.work_areas(id) on delete cascade;

do $$
begin
  alter table public.board_notes
    add constraint board_notes_single_target
    check (employee_id is null or work_area_id is null);
exception
  when duplicate_object then null;
end $$;

create index if not exists idx_board_notes_org_date
  on public.board_notes (organization_id, note_date, created_at);

create index if not exists idx_board_notes_targets
  on public.board_notes (note_date, employee_id, work_area_id);

drop trigger if exists trg_board_notes_updated_at on public.board_notes;
create trigger trg_board_notes_updated_at
before update on public.board_notes
for each row execute function public.touch_updated_at();
