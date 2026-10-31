import type { CorpCommand, CorpCommandKind } from '../types';

// The most recent command of a kind for a target, ignoring cancelled ones. Used
// to show "pending" or "failed" next to the value the site has not applied yet.
export function latestCommand(
  commands: CorpCommand[],
  kind: CorpCommandKind,
  targetId: string | null
): CorpCommand | undefined {
  return commands.find(
    (command) =>
      command.kind === kind &&
      (command.target_id ?? null) === (targetId ?? null) &&
      command.status !== 'cancelled'
  );
}

export function pendingCommand(
  commands: CorpCommand[],
  kind: CorpCommandKind,
  targetId: string | null
): CorpCommand | undefined {
  const latest = latestCommand(commands, kind, targetId);
  return latest && latest.status === 'pending' ? latest : undefined;
}

// Organization policy columns the console may set on a site.
export const POLICY_SETTINGS: { key: string; label: string; type: 'boolean' | 'number' }[] = [
  { key: 'enable_extended_leave_lock', label: 'Extended leave lock', type: 'boolean' },
  { key: 'extended_leave_threshold_days', label: 'Extended leave threshold (days)', type: 'number' },
  { key: 'enable_retail_floor_simulation', label: 'Retail floor simulation', type: 'boolean' },
  { key: 'enable_admin_realtime_notifications', label: 'Realtime admin notifications', type: 'boolean' },
  { key: 'default_shift_break_minutes', label: 'Default shift break (minutes)', type: 'number' },
  { key: 'default_timeline_window_hours', label: 'Default timeline window (hours)', type: 'number' }
];

export const TRAINING_SETTINGS: { key: string; label: string }[] = [
  { key: 'training_time_multiplier', label: 'Time multiplier' },
  { key: 'training_fake_employee_count', label: 'Simulated employees' },
  { key: 'training_no_show_rate_percent', label: 'No-show rate (%)' },
  { key: 'training_task_ack_rate_percent', label: 'Task acknowledgement rate (%)' },
  { key: 'training_clock_in_early_min', label: 'Clock-in early window (min)' },
  { key: 'training_clock_in_late_min', label: 'Clock-in late window (min)' },
  { key: 'training_clock_out_early_min', label: 'Clock-out early window (min)' },
  { key: 'training_clock_out_late_min', label: 'Clock-out late window (min)' }
];

export function humanizeKey(key: string): string {
  const label = key.replace(/_/g, ' ').trim();
  return label.charAt(0).toUpperCase() + label.slice(1);
}
