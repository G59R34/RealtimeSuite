export type FeatureFlags = Record<string, boolean>;

// Keep these defaults in sync with backend/app/features.py.
export const DEFAULT_FEATURES: FeatureFlags = {
  shifts: true,
  tasks: true,
  shift_pool: true,
  auto_assign: true,
  breaks: true,
  time_off: true,
  exceptions: true,
  overtime: true,
  shift_swaps: true,
  clock_in: true,
  unscheduled_clock_in: true,
  geofence_clock_in: false,
  task_acknowledgements: true,
  roster: true,
  payroll: true,
  discipline: true,
  training: true,
  work_preferences: true,
  messages: true,
  notifications: true,
  announcements: true,
  reports: true,
  clock_in_audit: true,
  live_board: true,
  employee_portal: true
};

export function normalizeFeatureFlags(value: unknown): FeatureFlags {
  const stored = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const flags: FeatureFlags = {};
  for (const [key, fallback] of Object.entries(DEFAULT_FEATURES)) {
    flags[key] = typeof stored[key] === 'boolean' ? Boolean(stored[key]) : fallback;
  }
  return flags;
}

export function featureEnabled(flags: FeatureFlags, key: string): boolean {
  return flags[key] !== false;
}
