-- Leave windows for discipline actions that take an employee off the schedule.
-- A suspension or probation records the dates it covers so the timeline can show the
-- employee on leave even though their shifts were removed.

alter table public.discipline_actions
  add column if not exists leave_starts_on date;

alter table public.discipline_actions
  add column if not exists leave_ends_on date;

create index if not exists discipline_actions_leave_window_idx
  on public.discipline_actions (employee_id, leave_starts_on, leave_ends_on);
