-- Pull request tasks created from GitHub carry a stable external reference so a sync
-- never duplicates a PR and can close the task when the PR is merged or closed.

alter table public.tasks
  add column if not exists external_id text;

alter table public.tasks
  add column if not exists external_url text;

create unique index if not exists tasks_source_external_idx
  on public.tasks (organization_id, source_system, external_id)
  where external_id is not null;
