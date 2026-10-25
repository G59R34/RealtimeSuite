import type {
  AdminDashboardData,
  DisciplineActionRow,
  EmployeeMessageRow,
  EmployeePortalData,
  ExceptionRequestRow,
  ExperienceModule,
  ExperienceModuleType,
  OrganizationExperienceBuilderConfig,
  OrganizationClockInLocationRow,
  OrganizationLoginBranding,
  OrganizationSettings,
  OvertimeRequestRow,
  ProfileRow,
  ShiftIntakeLocation,
  ShiftRow,
  ShiftStatus,
  TaskPriority,
  TaskRow,
  TaskStatus,
  TimeNullificationRow,
  TimeOffCoverageImpactRow,
  TimeOffRequestRow,
  TimelineZoomHours,
  TrainingAssignmentRow,
  TrainingCourseRow,
  ShiftSwapRequestRow
} from '../types';
import { TIMELINE_ZOOM_LEVELS } from '../types';
import { normalizeFeatureFlags } from './features';
import type { FeatureFlags } from './features';

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '/api';
const TOKEN_KEY = 'realtime_suite_token';
const USER_KEY = 'realtime_suite_user';
const REALTIME_TABLES = new Set([
  'profiles',
  'work_areas',
  'shifts',
  'tasks',
  'task_assignments',
  'time_off_requests',
  'time_nullification_requests',
  'exception_requests',
  'overtime_requests',
  'shift_swap_requests',
  'site_announcements',
  'employee_messages',
  'training_courses',
  'training_assignments',
  'app_notifications',
  'employee_work_preferences',
  'discipline_actions',
  'activity_tracking',
  'organization_clock_in_locations'
]);

export type Session = {
  access_token: string;
  user: { id: string; email?: string };
};

type AuthListener = (session: Session | null) => void;

let session: Session | null = readStoredSession();
const authListeners = new Set<AuthListener>();

function readStoredSession(): Session | null {
  if (typeof localStorage === 'undefined') return null;
  const token = localStorage.getItem(TOKEN_KEY);
  const userId = localStorage.getItem(USER_KEY);
  if (!token || !userId) return null;
  return { access_token: token, user: { id: userId } };
}

function storeSession(next: Session | null) {
  session = next;
  if (typeof localStorage !== 'undefined') {
    if (next) {
      localStorage.setItem(TOKEN_KEY, next.access_token);
      localStorage.setItem(USER_KEY, next.user.id);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  }
  authListeners.forEach((listener) => listener(next));
}

export function getStoredToken(): string | null {
  return session?.access_token ?? null;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401) {
      storeSession(null);
    }
    let detail = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body?.detail === 'string') detail = body.detail;
      else if (Array.isArray(body?.detail) && body.detail[0]?.msg) detail = body.detail[0].msg;
    } catch {
      // keep the generic message
    }
    throw new ApiError(detail, response.status);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value ?? {});
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function signIn(email: string, password: string): Promise<void> {
  const result = await apiFetch<{ access_token: string; user: { id: string; email: string } }>('/auth/login', {
    method: 'POST',
    body: jsonBody({ email, password })
  });
  storeSession({
    access_token: result.access_token,
    user: { id: result.user.id, email: result.user.email }
  });
}

export async function signOut(): Promise<void> {
  try {
    await apiFetch('/auth/logout', { method: 'POST', body: jsonBody({}) });
  } catch {
    // local sign-out must still succeed if the server is unreachable
  }
  storeSession(null);
}

export async function getCurrentSession(): Promise<Session | null> {
  if (!session) return null;
  try {
    await apiFetch<ProfileRow>('/auth/me');
    return session;
  } catch {
    storeSession(null);
    return null;
  }
}

export function onAuthStateChanged(callback: AuthListener) {
  authListeners.add(callback);
  return {
    data: {
      subscription: {
        unsubscribe: () => {
          authListeners.delete(callback);
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Profiles and onboarding
// ---------------------------------------------------------------------------

export async function fetchProfile(userId: string): Promise<ProfileRow> {
  const row = await apiFetch<ProfileRow>('/auth/me');
  return normalizeProfile(row);
}

export async function fetchMyEffectiveAdminAccess(): Promise<boolean> {
  const result = await apiFetch<{ is_admin: boolean }>('/me/effective-admin');
  return Boolean(result.is_admin);
}

export async function updateProfileHelpfulInfo(userId: string, helpfulInfo: string) {
  await apiFetch('/me/profile', {
    method: 'PATCH',
    body: jsonBody({ helpful_info: helpfulInfo })
  });
}

export async function updateEmployeePayRate(employeeId: string, hourlyRate: number | null) {
  await apiFetch(`/employees/${employeeId}`, {
    method: 'PATCH',
    body: jsonBody({ hourly_rate: hourlyRate })
  });
}

export async function updateProfileRole(profileId: string, role: ProfileRow['role']) {
  await apiFetch(`/employees/${profileId}`, {
    method: 'PATCH',
    body: jsonBody({ role })
  });
}

export async function adminCreateEmployeeAccount(payload: {
  email: string;
  password: string;
  fullName: string;
}): Promise<{ email: string; requiresEmailConfirmation: boolean }> {
  const created = await apiFetch<ProfileRow>('/employees', {
    method: 'POST',
    body: jsonBody({
      email: payload.email,
      password: payload.password,
      full_name: payload.fullName
    })
  });
  return { email: created.email, requiresEmailConfirmation: false };
}

export async function sendOnboardingCredentialsEmail(payload: {
  toEmail: string;
  employeeName: string;
  temporaryPassword: string;
  subjectTemplate?: string;
  bodyTemplate?: string;
  loginUrl?: string;
}): Promise<{ sent: boolean; subject: string; body: string }> {
  return apiFetch('/employees/onboarding-email', {
    method: 'POST',
    body: jsonBody({
      to_email: payload.toEmail,
      employee_name: payload.employeeName,
      temporary_password: payload.temporaryPassword,
      subject_template: payload.subjectTemplate,
      body_template: payload.bodyTemplate,
      login_url: payload.loginUrl
    })
  });
}

export async function fetchExtendedLeaveStatus(
  userId: string,
  dateValue: string,
  thresholdDays: number
): Promise<{ startDate: string; endDate: string; totalDays: number } | null> {
  const result = await apiFetch<{ startDate: string; endDate: string; totalDays: number } | null>(
    `/me/extended-leave?date=${encodeURIComponent(dateValue)}&threshold_days=${thresholdDays}`
  );
  return result ?? null;
}

export async function upsertMyWorkPreferences(payload: {
  maxWeeklyHours: number | null;
  preferredWorkAreaIds: string[];
  availabilityNotes: string;
}) {
  await apiFetch('/me/work-preferences', {
    method: 'POST',
    body: jsonBody({
      max_weekly_hours: payload.maxWeeklyHours,
      preferred_work_area_ids: payload.preferredWorkAreaIds,
      availability_notes: payload.availabilityNotes
    })
  });
}

export async function setEmployeeRetailChaosStationary(employeeId: string, stationary: boolean) {
  await apiFetch(`/employees/${employeeId}/stationary`, {
    method: 'POST',
    body: jsonBody({ stationary })
  });
}

// ---------------------------------------------------------------------------
// Organization settings
// ---------------------------------------------------------------------------

const DEFAULT_ADMIN_PORTAL_LABEL = 'OPERATIONS CENTER';
const DEFAULT_LOGIN_PRIMARY_COLOR = '#103b84';
const DEFAULT_LOGIN_ACCENT_COLOR = '#1850b7';
const DEFAULT_LOGIN_HEADING = 'RealtimeSuite';
const DEFAULT_LOGIN_SUBHEADING = 'Scheduling and Time Operations';
const DEFAULT_LOGIN_ELEMENTS: OrganizationExperienceBuilderConfig['login_elements'] = {
  organization_code_label: 'Organization',
  continue_button_label: 'Continue',
  sign_in_tab_label: 'Sign In',
  create_account_tab_label: 'Account',
  full_name_label: 'Full Name',
  email_label: 'Email',
  password_label: 'Password',
  sign_in_button_label: 'Sign In',
  create_account_button_label: 'Create Account',
  change_org_label: 'Change'
};
const DEFAULT_EMPLOYEE_ELEMENTS: OrganizationExperienceBuilderConfig['employee_elements'] = {
  operations_title: 'Home',
  scheduling_title: 'Schedule',
  training_title: 'Training',
  date_label: 'Date',
  clock_in_label: 'Clock In',
  clock_out_label: 'Clock Out',
  sign_out_label: 'Sign Out',
  tab_operations: 'Home',
  tab_attendance: 'Schedule',
  tab_training: 'Training',
  submenu_home: 'Overview',
  submenu_requests: 'Requests',
  submenu_shifts: 'My Shifts',
  submenu_tasks: 'My Tasks',
  submenu_pool: 'Shift Pool',
  submenu_alerts: 'Alerts',
  submenu_messages: 'Messages',
  submenu_profile: 'Profile & Preferences',
  submenu_preferences: 'Preferences',
  submenu_calendar: 'Calendar',
  submenu_overtime: 'Overtime',
  submenu_swap: 'Swap Market',
  submenu_timeoff: 'Time Off',
  submenu_exceptions: 'Exceptions',
  kpi_shifts: 'Shifts On Date',
  kpi_pending_ack: 'Pending Task ACK',
  kpi_date_code: 'Date Code',
  kpi_unread_messages: 'Unread Messages',
  kpi_pool_openings: 'Shift Pool Openings',
  kpi_unread_alerts: 'Unread Alerts',
  kpi_pending_trainings: 'Pending Trainings'
};
const DEFAULT_OPSBOARD_SETTINGS: OrganizationExperienceBuilderConfig['opsboard_settings'] = {
  layout_preset: 'ops',
  auto_fullscreen: false,
  sound_alerts: true,
  flash_alerts: true,
  branding_title: 'OpsBoard',
  branding_subtitle: 'Operations Glance Board',
  default_horizon_hours: 8,
  default_refresh_seconds: 30
};
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.floor(numeric));
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.floor(numeric));
}

function normalizeBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function normalizeTimelineWindowHours(value: unknown): TimelineZoomHours {
  const numeric = Number(value);
  const match = TIMELINE_ZOOM_LEVELS.find((level) => level === numeric);
  return match ?? 8;
}

function normalizeExperienceModule(value: unknown, fallbackId: string): ExperienceModule | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const typeRaw = (asString(row.type) ?? '').trim().toLowerCase();
  const type: ExperienceModuleType =
    typeRaw === 'hero' || typeRaw === 'image' || typeRaw === 'announcement' ? typeRaw : 'announcement';
  return {
    id: (asString(row.id) ?? '').trim() || fallbackId,
    type,
    enabled: typeof row.enabled === 'boolean' ? row.enabled : true,
    title: (asString(row.title) ?? '').trim(),
    body: (asString(row.body) ?? '').trim(),
    image_url: (asString(row.image_url) ?? '').trim(),
    cta_label: (asString(row.cta_label) ?? '').trim(),
    cta_url: (asString(row.cta_url) ?? '').trim()
  };
}

function normalizeExperienceModules(value: unknown, prefix: string): ExperienceModule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => normalizeExperienceModule(entry, `${prefix}_${index + 1}`))
    .filter((entry): entry is ExperienceModule => Boolean(entry));
}

function normalizeExperienceBuilderConfig(value: unknown): OrganizationExperienceBuilderConfig {
  const row = asObject(value);
  const settings = asObject(row.opsboard_settings ?? row.opsboard_settings);
  const loginElements = asObject(row.login_elements);
  const employeeElements = asObject(row.employee_elements);
  const layoutPreset = (asString(settings.layout_preset) ?? '').trim();
  const horizon = Number(settings.default_horizon_hours);
  const refresh = Number(settings.default_refresh_seconds);
  return {
    login_modules: normalizeExperienceModules(row.login_modules, 'login_module'),
    employee_modules: normalizeExperienceModules(row.employee_modules, 'employee_module'),
    opsboard_settings: {
      layout_preset:
        layoutPreset === 'shift-heavy' || layoutPreset === 'task-heavy' || layoutPreset === 'compact'
          ? layoutPreset
          : 'ops',
      auto_fullscreen:
        typeof settings.auto_fullscreen === 'boolean'
          ? settings.auto_fullscreen
          : DEFAULT_OPSBOARD_SETTINGS.auto_fullscreen,
      sound_alerts:
        typeof settings.sound_alerts === 'boolean' ? settings.sound_alerts : DEFAULT_OPSBOARD_SETTINGS.sound_alerts,
      flash_alerts:
        typeof settings.flash_alerts === 'boolean' ? settings.flash_alerts : DEFAULT_OPSBOARD_SETTINGS.flash_alerts,
      branding_title:
        (asString(settings.branding_title) ?? '').trim() || DEFAULT_OPSBOARD_SETTINGS.branding_title,
      branding_subtitle:
        (asString(settings.branding_subtitle) ?? '').trim() || DEFAULT_OPSBOARD_SETTINGS.branding_subtitle,
      default_horizon_hours:
        horizon === 4 || horizon === 8 || horizon === 12 || horizon === 24
          ? horizon
          : DEFAULT_OPSBOARD_SETTINGS.default_horizon_hours,
      default_refresh_seconds:
        refresh === 15 || refresh === 30 || refresh === 60 || refresh === 120
          ? refresh
          : DEFAULT_OPSBOARD_SETTINGS.default_refresh_seconds
    },
    login_elements: {
      ...DEFAULT_LOGIN_ELEMENTS,
      ...Object.fromEntries(
        Object.entries(loginElements).map(([key, entry]) => [key, typeof entry === 'string' ? entry : ''])
      )
    },
    employee_elements: {
      ...DEFAULT_EMPLOYEE_ELEMENTS,
      ...Object.fromEntries(
        Object.entries(employeeElements).map(([key, entry]) => [key, typeof entry === 'string' ? entry : ''])
      )
    }
  };
}

function normalizeProfile(row: Partial<ProfileRow>): ProfileRow {
  const rate = row.hourly_rate;
  return {
    id: String(row.id ?? ''),
    email: String(row.email ?? ''),
    full_name: String(row.full_name ?? ''),
    helpful_info: String(row.helpful_info ?? ''),
    hourly_rate: typeof rate === 'number' ? rate : rate ? Number(rate) || null : null,
    role: (row.role === 'admin' ? 'admin' : 'employee') as ProfileRow['role'],
    retail_chaos_stationary: Boolean(row.retail_chaos_stationary),
    admin_training_only: Boolean(row.admin_training_only),
    is_training_manager: Boolean(row.is_training_manager),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? '')
  };
}

function normalizeOrganizationSettings(row: Record<string, unknown>): OrganizationSettings {
  const adminPortalLabel = (asString(row.admin_portal_label) ?? '').trim();
  return {
    organization_id: String(row.id ?? ''),
    organization_name: String(row.name ?? 'Organization'),
    admin_portal_label: adminPortalLabel || DEFAULT_ADMIN_PORTAL_LABEL,
    login_primary_color: (asString(row.login_primary_color) ?? '').trim() || DEFAULT_LOGIN_PRIMARY_COLOR,
    login_accent_color: (asString(row.login_accent_color) ?? '').trim() || DEFAULT_LOGIN_ACCENT_COLOR,
    login_logo_url: (asString(row.login_logo_url) ?? '').trim(),
    login_background_image_url: (asString(row.login_background_image_url) ?? '').trim(),
    login_announcement: (asString(row.login_announcement) ?? '').trim(),
    login_heading: (asString(row.login_heading) ?? '').trim() || DEFAULT_LOGIN_HEADING,
    login_subheading: (asString(row.login_subheading) ?? '').trim() || DEFAULT_LOGIN_SUBHEADING,
    experience_builder_config: normalizeExperienceBuilderConfig(row.experience_builder_config),
    enable_retail_floor_simulation: Boolean(row.enable_retail_floor_simulation),
    enable_extended_leave_lock:
      typeof row.enable_extended_leave_lock === 'boolean' ? row.enable_extended_leave_lock : true,
    extended_leave_threshold_days: normalizePositiveInt(row.extended_leave_threshold_days, 5),
    enable_admin_realtime_notifications:
      typeof row.enable_admin_realtime_notifications === 'boolean'
        ? row.enable_admin_realtime_notifications
        : true,
    default_timeline_window_hours: normalizeTimelineWindowHours(row.default_timeline_window_hours),
    default_shift_break_minutes: normalizeNonNegativeInt(row.default_shift_break_minutes, 30),
    training_time_multiplier: normalizeBoundedInt(row.training_time_multiplier, 10, 1, 100),
    training_fake_employee_count: normalizeBoundedInt(row.training_fake_employee_count, 18, 5, 100),
    training_no_show_rate_percent: normalizeBoundedInt(row.training_no_show_rate_percent, 12, 0, 80),
    training_task_ack_rate_percent: normalizeBoundedInt(row.training_task_ack_rate_percent, 82, 0, 100),
    training_clock_in_early_min: normalizeBoundedInt(row.training_clock_in_early_min, -7, -60, 0),
    training_clock_in_late_min: normalizeBoundedInt(row.training_clock_in_late_min, 9, 0, 60),
    training_clock_out_early_min: normalizeBoundedInt(row.training_clock_out_early_min, -4, -60, 0),
    training_clock_out_late_min: normalizeBoundedInt(row.training_clock_out_late_min, 14, 0, 60)
  };
}

export async function fetchCurrentOrganizationSettings(): Promise<OrganizationSettings | null> {
  const row = await apiFetch<Record<string, unknown>>('/settings');
  return normalizeOrganizationSettings(row);
}

export async function fetchFeatureFlags(): Promise<FeatureFlags> {
  const row = await apiFetch<{ flags?: unknown }>('/settings/features');
  return normalizeFeatureFlags(row?.flags);
}

export async function fetchLoginBranding(): Promise<OrganizationLoginBranding | null> {
  const row = await apiFetch<Record<string, unknown>>('/settings/branding');
  if (!row) return null;
  const config = normalizeExperienceBuilderConfig(row.experience_builder_config);
  return {
    organization_name: (asString(row.name) ?? 'Organization').trim() || 'Organization',
    login_primary_color: (asString(row.login_primary_color) ?? '').trim() || DEFAULT_LOGIN_PRIMARY_COLOR,
    login_accent_color: (asString(row.login_accent_color) ?? '').trim() || DEFAULT_LOGIN_ACCENT_COLOR,
    login_logo_url: (asString(row.login_logo_url) ?? '').trim(),
    login_background_image_url: (asString(row.login_background_image_url) ?? '').trim(),
    login_announcement: (asString(row.login_announcement) ?? '').trim(),
    login_heading: (asString(row.login_heading) ?? '').trim() || DEFAULT_LOGIN_HEADING,
    login_subheading: (asString(row.login_subheading) ?? '').trim() || DEFAULT_LOGIN_SUBHEADING,
    login_modules: config.login_modules,
    login_elements: config.login_elements
  };
}

export async function updateCurrentOrganizationSettings(payload: {
  adminPortalLabel: string;
  loginPrimaryColor: string;
  loginAccentColor: string;
  loginLogoUrl: string;
  loginBackgroundImageUrl: string;
  loginAnnouncement: string;
  loginHeading: string;
  loginSubheading: string;
  experienceBuilderConfig: OrganizationExperienceBuilderConfig;
  enableRetailFloorSimulation: boolean;
  enableExtendedLeaveLock: boolean;
  extendedLeaveThresholdDays: number;
  enableAdminRealtimeNotifications: boolean;
  defaultTimelineWindowHours: TimelineZoomHours;
  defaultShiftBreakMinutes: number;
}): Promise<OrganizationSettings> {
  const row = await apiFetch<Record<string, unknown>>('/settings', {
    method: 'PATCH',
    body: jsonBody({
      admin_portal_label: payload.adminPortalLabel.trim() || DEFAULT_ADMIN_PORTAL_LABEL,
      login_primary_color: payload.loginPrimaryColor,
      login_accent_color: payload.loginAccentColor,
      login_logo_url: payload.loginLogoUrl,
      login_background_image_url: payload.loginBackgroundImageUrl,
      login_announcement: payload.loginAnnouncement,
      login_heading: payload.loginHeading,
      login_subheading: payload.loginSubheading,
      experience_builder_config: payload.experienceBuilderConfig,
      enable_retail_floor_simulation: payload.enableRetailFloorSimulation,
      enable_extended_leave_lock: payload.enableExtendedLeaveLock,
      extended_leave_threshold_days: payload.extendedLeaveThresholdDays,
      enable_admin_realtime_notifications: payload.enableAdminRealtimeNotifications,
      default_timeline_window_hours: payload.defaultTimelineWindowHours,
      default_shift_break_minutes: payload.defaultShiftBreakMinutes
    })
  });
  return normalizeOrganizationSettings(row);
}

export async function updateTrainingModeSettings(payload: {
  trainingTimeMultiplier: number;
  trainingFakeEmployeeCount: number;
  trainingNoShowRatePercent: number;
  trainingTaskAckRatePercent: number;
  trainingClockInEarlyMin: number;
  trainingClockInLateMin: number;
  trainingClockOutEarlyMin: number;
  trainingClockOutLateMin: number;
}): Promise<OrganizationSettings> {
  const row = await apiFetch<Record<string, unknown>>('/settings/training-mode', {
    method: 'PATCH',
    body: jsonBody({
      training_time_multiplier: payload.trainingTimeMultiplier,
      training_fake_employee_count: payload.trainingFakeEmployeeCount,
      training_no_show_rate_percent: payload.trainingNoShowRatePercent,
      training_task_ack_rate_percent: payload.trainingTaskAckRatePercent,
      training_clock_in_early_min: payload.trainingClockInEarlyMin,
      training_clock_in_late_min: payload.trainingClockInLateMin,
      training_clock_out_early_min: payload.trainingClockOutEarlyMin,
      training_clock_out_late_min: payload.trainingClockOutLateMin
    })
  });
  return normalizeOrganizationSettings(row);
}

export async function uploadOrganizationLoginAsset(file: File, kind: 'logo' | 'background'): Promise<string> {
  if (file.size > 8 * 1024 * 1024) {
    throw new Error('Upload failed: file must be 8MB or smaller.');
  }
  if (!file.type.startsWith('image/')) {
    throw new Error('Upload failed: only image files are allowed.');
  }
  const form = new FormData();
  form.append('kind', kind);
  form.append('file', file);
  const result = await apiFetch<{ url: string }>('/settings/assets', {
    method: 'POST',
    body: form
  });
  return result.url;
}

export async function fetchActiveAnnouncement(): Promise<string | null> {
  const rows = await apiFetch<
    Array<{ message: string; is_active: boolean; starts_at: string | null; ends_at: string | null; created_at: string }>
  >('/settings/announcements');
  const now = Date.now();
  const active = rows.find((row) => {
    if (!row.is_active) return false;
    const start = row.starts_at ? new Date(row.starts_at).getTime() : Number.NEGATIVE_INFINITY;
    const end = row.ends_at ? new Date(row.ends_at).getTime() : Number.POSITIVE_INFINITY;
    return start <= now && now <= end;
  });
  const message = active?.message?.trim();
  return message && message.length > 0 ? message : null;
}

export async function fetchServerNow(): Promise<string | null> {
  const result = await apiFetch<{ now: string }>('/time');
  return result.now ?? null;
}

export async function fetchOrganizationClockInLocations(): Promise<OrganizationClockInLocationRow[]> {
  return apiFetch('/settings/clock-locations');
}

export async function createOrganizationClockInLocation(payload: {
  organizationId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  isActive: boolean;
}): Promise<OrganizationClockInLocationRow> {
  return apiFetch('/settings/clock-locations', {
    method: 'POST',
    body: jsonBody({
      name: payload.name,
      latitude: payload.latitude,
      longitude: payload.longitude,
      radius_meters: payload.radiusMeters,
      is_active: payload.isActive
    })
  });
}

export async function updateOrganizationClockInLocation(payload: {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  isActive: boolean;
}): Promise<OrganizationClockInLocationRow> {
  return apiFetch(`/settings/clock-locations/${payload.id}`, {
    method: 'PATCH',
    body: jsonBody({
      name: payload.name,
      latitude: payload.latitude,
      longitude: payload.longitude,
      radius_meters: payload.radiusMeters,
      is_active: payload.isActive
    })
  });
}

export async function deleteOrganizationClockInLocation(locationId: string) {
  await apiFetch(`/settings/clock-locations/${locationId}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

// `pay_multiplier` is a numeric column, but a numeric value can still arrive
// serialized as text ("1.50"). Rendering code compares it with numbers and calls
// toFixed, so coerce it once here instead of letting one row blank the screen.
function normalizeShiftPay<T>(row: T): T {
  const value = row as Record<string, unknown>;
  if (value.pay_multiplier === undefined || typeof value.pay_multiplier === 'number') {
    return row;
  }
  const multiplier = Number(value.pay_multiplier);
  return {
    ...value,
    pay_multiplier: Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1
  } as T;
}

export async function fetchAdminDashboardData(selectedDate: string): Promise<AdminDashboardData> {
  const data = await apiFetch<AdminDashboardData>(`/dashboard?date=${encodeURIComponent(selectedDate)}`);
  return {
    ...data,
    shifts: (data.shifts ?? []).map(normalizeShiftPay),
    monthShifts: (data.monthShifts ?? []).map(normalizeShiftPay),
    timeNullifications: data.timeNullifications ?? []
  };
}

export async function fetchEmployeePortalData(userId: string, selectedDate: string): Promise<EmployeePortalData> {
  const data = await apiFetch<EmployeePortalData>(`/portal?date=${encodeURIComponent(selectedDate)}`);
  return {
    ...data,
    shifts: (data.shifts ?? []).map(normalizeShiftPay),
    monthShifts: (data.monthShifts ?? []).map(normalizeShiftPay),
    shiftPoolShifts: (data.shiftPoolShifts ?? []).map(normalizeShiftPay),
    timeNullifications: data.timeNullifications ?? []
  };
}

export async function fetchTrainingCourses(): Promise<TrainingCourseRow[]> {
  return apiFetch('/training/courses');
}

export async function fetchTrainingAssignmentsForAdmin(): Promise<TrainingAssignmentRow[]> {
  return apiFetch('/training/assignments');
}

export async function createTrainingCourse(payload: {
  title: string;
  description: string;
  content: string;
  estimatedMinutes: number;
  isActive?: boolean;
}) {
  await apiFetch('/training/courses', {
    method: 'POST',
    body: jsonBody({
      title: payload.title,
      description: payload.description,
      content: payload.content,
      estimated_minutes: payload.estimatedMinutes,
      is_active: payload.isActive ?? true
    })
  });
}

export async function assignTrainingCourse(payload: {
  courseId: string;
  employeeId: string;
  dueAt?: string | null;
}) {
  await apiFetch('/training/assignments', {
    method: 'POST',
    body: jsonBody({ course_id: payload.courseId, employee_id: payload.employeeId, due_at: payload.dueAt ?? null })
  });
}

export async function completeTrainingAssignment(assignmentId: string, completionNotes = '') {
  await apiFetch(`/training/assignments/${assignmentId}/complete`, {
    method: 'POST',
    body: jsonBody({ completion_notes: completionNotes })
  });
}

// ---------------------------------------------------------------------------
// Shifts and timeclock
// ---------------------------------------------------------------------------

export async function createWorkArea(payload: {
  name: string;
  description: string;
  color: string;
  createdBy: string;
}) {
  await apiFetch('/work-areas', {
    method: 'POST',
    body: jsonBody({
      name: payload.name,
      description: payload.description,
      color: payload.color
    })
  });
}

export async function upsertShift(payload: {
  shiftId?: string;
  employeeId: string;
  workAreaId: string | null;
  startAt: string;
  endAt: string;
  status: ShiftStatus;
  breakMinutes: number;
  notes: string;
  actorId: string;
  isUnscheduledOvertime?: boolean;
}) {
  await apiFetch('/shifts', {
    method: 'POST',
    body: jsonBody({
      shift_id: payload.shiftId,
      employee_id: payload.employeeId,
      work_area_id: payload.workAreaId,
      start_at: payload.startAt,
      end_at: payload.endAt,
      status: payload.status,
      break_minutes: payload.breakMinutes,
      notes: payload.notes,
      is_unscheduled_overtime: Boolean(payload.isUnscheduledOvertime)
    })
  });
}

export async function createBoardNote(payload: {
  body: string;
  isPublic: boolean;
  date: string;
  employeeId?: string | null;
  workAreaId?: string | null;
}): Promise<{ id: string }> {
  return apiFetch('/board-notes', {
    method: 'POST',
    body: jsonBody({
      body: payload.body,
      is_public: payload.isPublic,
      date: payload.date,
      employee_id: payload.employeeId ?? null,
      work_area_id: payload.workAreaId ?? null
    })
  });
}

export async function deleteBoardNote(noteId: string) {
  await apiFetch(`/board-notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
}

export async function deleteShift(shiftId: string) {
  await apiFetch(`/shifts/${shiftId}`, { method: 'DELETE' });
}

export async function deleteMonthShiftsAndReset(payload: { dateValue: string }): Promise<number> {
  const result = await apiFetch<{ deleted: number }>('/shifts/month/reset', {
    method: 'POST',
    body: jsonBody({ date: payload.dateValue })
  });
  return result.deleted ?? 0;
}

export async function updateShiftWorkArea(shiftId: string, workAreaId: string | null) {
  await apiFetch(`/shifts/${shiftId}/work-area`, {
    method: 'PATCH',
    body: jsonBody({ work_area_id: workAreaId })
  });
}

export async function autoAssignShiftsForDate(payload: {
  dateValue: string;
  actorId: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  notes: string;
  status: ShiftStatus;
  preferredWorkAreaId?: string | null;
}): Promise<number> {
  const result = await apiFetch<{ created: number }>('/shifts/auto-assign', {
    method: 'POST',
    body: jsonBody({
      mode: 'day',
      date: payload.dateValue,
      start_time: payload.startTime,
      end_time: payload.endTime,
      break_minutes: payload.breakMinutes,
      notes: payload.notes,
      status: payload.status,
      preferred_work_area_id: payload.preferredWorkAreaId ?? null
    })
  });
  return result.created ?? 0;
}

export async function autoAssignShiftsForMonth(payload: {
  dateValue: string;
  actorId: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  weeklyHoursTarget: number;
  rdoDaysPerWeek: number;
  notes: string;
  status: ShiftStatus;
  preferredWorkAreaId?: string | null;
  shiftTemplates?: Array<{
    startTime: string;
    endTime: string;
    headcount: number;
    breakMinutes?: number;
  }>;
}): Promise<number> {
  const result = await apiFetch<{ created: number }>('/shifts/auto-assign', {
    method: 'POST',
    body: jsonBody({
      mode: 'month',
      date: payload.dateValue,
      start_time: payload.startTime,
      end_time: payload.endTime,
      break_minutes: payload.breakMinutes,
      weekly_hours_target: payload.weeklyHoursTarget,
      rdo_days_per_week: payload.rdoDaysPerWeek,
      notes: payload.notes,
      status: payload.status,
      preferred_work_area_id: payload.preferredWorkAreaId ?? null,
      shift_templates: payload.shiftTemplates ?? []
    })
  });
  return result.created ?? 0;
}

export async function createShiftPoolForMonth(payload: {
  dateValue: string;
  actorId: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  notes: string;
  status: ShiftStatus;
  workAreaId?: string | null;
  openingsPerDay: number;
}): Promise<number> {
  if (payload.status !== 'scheduled') {
    throw new Error('Shift pool openings must use scheduled status.');
  }
  const result = await apiFetch<{ created: number }>('/shifts/pool', {
    method: 'POST',
    body: jsonBody({
      date: payload.dateValue,
      start_time: payload.startTime,
      end_time: payload.endTime,
      break_minutes: payload.breakMinutes,
      notes: payload.notes,
      work_area_id: payload.workAreaId ?? null,
      openings_per_day: payload.openingsPerDay
    })
  });
  return result.created ?? 0;
}

export async function setShiftPoolStatus(shiftId: string, enabled: boolean) {
  await apiFetch(`/shifts/${shiftId}/pool`, {
    method: 'POST',
    body: jsonBody({ enabled })
  });
}

export async function claimShiftPoolShift(shiftId: string) {
  await apiFetch(`/shifts/${shiftId}/claim`, { method: 'POST', body: jsonBody({}) });
}

export async function clockInShift(shiftId: string, actorId: string) {
  await apiFetch(`/shifts/${shiftId}/clock-in`, { method: 'POST', body: jsonBody({}) });
}

export async function clockOutShift(shiftId: string, actorId: string) {
  await apiFetch(`/shifts/${shiftId}/clock-out`, { method: 'POST', body: jsonBody({}) });
}

export async function assignShiftBreakTask(shiftId: string, breakMinutes: number, note = '') {
  const result = await apiFetch<{ task_id: string | null }>(`/shifts/${shiftId}/break`, {
    method: 'POST',
    body: jsonBody({ break_minutes: breakMinutes, note })
  });
  return result.task_id ?? '';
}

export async function processDueShiftBreakResumes(): Promise<number> {
  return 0;
}

export async function processDueShiftAutoClockOuts(): Promise<number> {
  return 0;
}

export async function verifyClockInLocation(payload: {
  organizationId: string;
  shiftId?: string | null;
  location: ShiftIntakeLocation;
  isUnscheduled?: boolean;
}): Promise<{
  isAllowed: boolean;
  message: string;
  distanceMeters: number | null;
  locationName: string | null;
}> {
  return apiFetch('/shifts/verify-location', {
    method: 'POST',
    body: jsonBody({
      shift_id: payload.shiftId ?? null,
      latitude: payload.location.latitude,
      longitude: payload.location.longitude,
      accuracyMeters: payload.location.accuracyMeters,
      isUnscheduled: Boolean(payload.isUnscheduled)
    })
  });
}

export async function clockInOwnShift(shiftId: string, location: ShiftIntakeLocation) {
  const hasCoordinates = Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude);
  if (location?.isMobile && hasCoordinates) {
    await apiFetch(`/shifts/${shiftId}/clock-in-own`, {
      method: 'POST',
      body: jsonBody({
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracyMeters,
        device: location.device,
        isMobile: location.isMobile
      })
    });
    return;
  }
  await apiFetch(`/shifts/${shiftId}/clock-in-own`, { method: 'POST', body: jsonBody({}) });
}

export async function clockInUnscheduledShift(note = '', location: ShiftIntakeLocation) {
  const hasCoordinates = Number.isFinite(location?.latitude) && Number.isFinite(location?.longitude);
  await apiFetch('/shifts/clock-in-unscheduled', {
    method: 'POST',
    body: jsonBody({
      note,
      latitude: hasCoordinates ? location.latitude : null,
      longitude: hasCoordinates ? location.longitude : null,
      accuracyMeters: location?.accuracyMeters ?? null,
      device: location?.device ?? null,
      isMobile: location?.isMobile ?? null
    })
  });
}

export async function clockOutOwnShift(shiftId: string) {
  await apiFetch(`/shifts/${shiftId}/clock-out-own`, { method: 'POST', body: jsonBody({}) });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function assignTaskToEmployee(payload: {
  employeeId: string;
  title: string;
  description: string;
  startAt: string;
  endAt: string;
  workAreaId: string | null;
  shiftId: string | null;
  priority: TaskPriority;
}) {
  await apiFetch('/tasks/assign', {
    method: 'POST',
    body: jsonBody({
      employee_id: payload.employeeId,
      title: payload.title,
      description: payload.description,
      start_at: payload.startAt,
      end_at: payload.endAt,
      work_area_id: payload.workAreaId,
      shift_id: payload.shiftId,
      priority: payload.priority
    })
  });
}

export async function updateTask(payload: {
  taskId: string;
  title: string;
  description: string;
  startAt: string;
  endAt: string;
  workAreaId: string | null;
  shiftId: string | null;
  priority: TaskPriority;
  status?: TaskStatus;
}) {
  await apiFetch(`/tasks/${payload.taskId}`, {
    method: 'PATCH',
    body: jsonBody({
      title: payload.title,
      description: payload.description,
      start_at: payload.startAt,
      end_at: payload.endAt,
      work_area_id: payload.workAreaId,
      shift_id: payload.shiftId,
      priority: payload.priority,
      ...(payload.status ? { status: payload.status } : {})
    })
  });
}

export async function reassignTaskToEmployee(taskId: string, employeeId: string) {
  await apiFetch(`/tasks/${taskId}/reassign`, {
    method: 'POST',
    body: jsonBody({ employee_id: employeeId })
  });
}

export async function unassignTaskAssignment(taskId: string) {
  await apiFetch(`/tasks/${taskId}/assignment`, { method: 'DELETE' });
}

export async function deleteTask(taskId: string) {
  await apiFetch(`/tasks/${taskId}`, { method: 'DELETE' });
}

export async function acknowledgeTaskAssignment(assignmentId: string, note = '') {
  await apiFetch(`/tasks/ack/${assignmentId}`, {
    method: 'POST',
    body: jsonBody({ note })
  });
}

export async function createNoteTaskForEmployee(payload: {
  employeeId: string;
  actorId: string;
  note: string;
}) {
  await apiFetch('/tasks/note', {
    method: 'POST',
    body: jsonBody({ employee_id: payload.employeeId, note: payload.note })
  });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export async function createTimeNullification(payload: {
  employeeId: string;
  shiftId: string;
  startAt: string;
  endAt: string;
  reason: string;
  approved?: boolean;
}): Promise<TimeNullificationRow> {
  return apiFetch<TimeNullificationRow>('/nullifications', {
    method: 'POST',
    body: jsonBody({
      employee_id: payload.employeeId,
      shift_id: payload.shiftId,
      start_at: payload.startAt,
      end_at: payload.endAt,
      reason: payload.reason,
      approved: Boolean(payload.approved)
    })
  });
}

export async function reviewTimeNullification(payload: {
  requestId: string;
  status: 'approved' | 'denied' | 'cancelled';
  reviewNote?: string;
}): Promise<TimeNullificationRow> {
  return apiFetch<TimeNullificationRow>(`/nullifications/${payload.requestId}`, {
    method: 'PATCH',
    body: jsonBody({ status: payload.status, review_note: payload.reviewNote ?? '' })
  });
}

export async function deleteTimeNullification(requestId: string): Promise<void> {
  await apiFetch(`/nullifications/${requestId}`, { method: 'DELETE' });
}

export async function createTimeOffRequest(payload: {
  employeeId: string;
  startDate: string;
  endDate: string;
  requestType: TimeOffRequestRow['request_type'];
  reason: string;
}) {
  await apiFetch('/time-off', {
    method: 'POST',
    body: jsonBody({
      employee_id: payload.employeeId,
      start_date: payload.startDate,
      end_date: payload.endDate,
      request_type: payload.requestType,
      reason: payload.reason
    })
  });
}

export async function reviewTimeOffRequest(payload: {
  requestId: string;
  status: TimeOffRequestRow['status'];
  reviewNotes: string;
  reviewerId: string;
}) {
  await apiFetch(`/time-off/${payload.requestId}`, {
    method: 'PATCH',
    body: jsonBody({ status: payload.status, review_notes: payload.reviewNotes })
  });
}

export async function updateTimeOffRequestByAdmin(payload: {
  requestId: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  requestType: TimeOffRequestRow['request_type'];
  reason: string;
  status: TimeOffRequestRow['status'];
  reviewNotes: string;
  reviewerId: string;
}) {
  await apiFetch(`/time-off/${payload.requestId}`, {
    method: 'PATCH',
    body: jsonBody({
      employee_id: payload.employeeId,
      start_date: payload.startDate,
      end_date: payload.endDate,
      request_type: payload.requestType,
      reason: payload.reason,
      status: payload.status,
      review_notes: payload.reviewNotes
    })
  });
}

export async function deleteTimeOffRequestByAdmin(requestId: string) {
  await apiFetch(`/time-off/${requestId}`, { method: 'DELETE' });
}

export async function previewTimeOffCoverageImpact(payload: {
  employeeId: string;
  startDate: string;
  endDate: string;
}): Promise<TimeOffCoverageImpactRow[]> {
  return apiFetch('/time-off/coverage', {
    method: 'POST',
    body: jsonBody({
      employee_id: payload.employeeId,
      start_date: payload.startDate,
      end_date: payload.endDate
    })
  });
}

export async function createOvertimeRequest(payload: {
  employeeId: string;
  startAt: string;
  endAt: string;
  note: string;
  overtimeType?: OvertimeRequestRow['overtime_type'];
}) {
  await apiFetch('/overtime', {
    method: 'POST',
    body: jsonBody({
      employee_id: payload.employeeId,
      start_at: payload.startAt,
      end_at: payload.endAt,
      note: payload.note,
      overtime_type: payload.overtimeType ?? 'voluntary'
    })
  });
}

export async function assignOvertimeRequestByAdmin(payload: {
  employeeId: string;
  startAt: string;
  endAt: string;
  note: string;
  overtimeType: OvertimeRequestRow['overtime_type'];
}) {
  await apiFetch('/overtime/assign', {
    method: 'POST',
    body: jsonBody({
      employee_id: payload.employeeId,
      start_at: payload.startAt,
      end_at: payload.endAt,
      note: payload.note,
      overtime_type: payload.overtimeType
    })
  });
}

export async function reviewOvertimeRequest(payload: {
  requestId: string;
  status: OvertimeRequestRow['status'];
  reviewNotes: string;
}) {
  await apiFetch(`/overtime/${payload.requestId}`, {
    method: 'PATCH',
    body: jsonBody({ status: payload.status, review_notes: payload.reviewNotes })
  });
}

export async function createShiftSwapRequest(payload: {
  shiftId: string;
  requestedEmployeeId?: string | null;
  requestNote?: string;
}) {
  const result = await apiFetch<{ id: string | null }>('/swaps', {
    method: 'POST',
    body: jsonBody({
      shift_id: payload.shiftId,
      requested_employee_id: payload.requestedEmployeeId ?? null,
      request_note: payload.requestNote ?? ''
    })
  });
  return result.id ?? '';
}

export async function acceptShiftSwapRequest(requestId: string, acceptanceNote = '') {
  const result = await apiFetch<{ id: string | null }>(`/swaps/${requestId}/accept`, {
    method: 'POST',
    body: jsonBody({ acceptance_note: acceptanceNote })
  });
  return result.id ?? '';
}

export async function reviewShiftSwapRequest(payload: {
  requestId: string;
  approve: boolean;
  reviewNote?: string;
}) {
  await apiFetch(`/swaps/${payload.requestId}`, {
    method: 'PATCH',
    body: jsonBody({ approve: payload.approve, review_note: payload.reviewNote ?? '' })
  });
}

export async function createExceptionRequest(payload: {
  employeeId: string;
  submittedBy: string;
  exceptionType: ExceptionRequestRow['exception_type'];
  exceptionCode: ExceptionRequestRow['exception_code'];
  title: string;
  details: string;
  startDate: string;
  endDate: string;
  relatedShiftId?: string | null;
  relatedTaskId?: string | null;
}) {
  await apiFetch('/exceptions', {
    method: 'POST',
    body: jsonBody({
      employee_id: payload.employeeId,
      exception_type: payload.exceptionType,
      exception_code: payload.exceptionCode,
      title: payload.title,
      details: payload.details,
      start_date: payload.startDate,
      end_date: payload.endDate,
      related_shift_id: payload.relatedShiftId ?? null,
      related_task_id: payload.relatedTaskId ?? null
    })
  });
}

export async function reviewExceptionRequest(payload: {
  requestId: string;
  status: ExceptionRequestRow['status'];
  reviewNotes: string;
  reviewerId: string;
}) {
  await apiFetch(`/exceptions/${payload.requestId}`, {
    method: 'PATCH',
    body: jsonBody({ status: payload.status, review_notes: payload.reviewNotes })
  });
}

export async function updateExceptionRequestByAdmin(payload: {
  requestId: string;
  employeeId: string;
  exceptionType: ExceptionRequestRow['exception_type'];
  exceptionCode: ExceptionRequestRow['exception_code'];
  title: string;
  details: string;
  startDate: string;
  endDate: string;
  relatedShiftId?: string | null;
  relatedTaskId?: string | null;
  status: ExceptionRequestRow['status'];
  reviewNotes: string;
  reviewerId: string;
}) {
  await apiFetch(`/exceptions/${payload.requestId}`, {
    method: 'PATCH',
    body: jsonBody({
      employee_id: payload.employeeId,
      exception_type: payload.exceptionType,
      exception_code: payload.exceptionCode,
      title: payload.title,
      details: payload.details,
      start_date: payload.startDate,
      end_date: payload.endDate,
      related_shift_id: payload.relatedShiftId ?? null,
      related_task_id: payload.relatedTaskId ?? null,
      status: payload.status,
      review_notes: payload.reviewNotes
    })
  });
}

export async function deleteExceptionRequestByAdmin(requestId: string) {
  await apiFetch(`/exceptions/${requestId}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Messaging, notifications, discipline
// ---------------------------------------------------------------------------

export async function createEmployeeMessage(payload: {
  senderId: string;
  recipientId: string;
  subject: string;
  message: string;
}) {
  const message = payload.message.trim();
  if (!message) throw new Error('Message is required.');
  await apiFetch('/messages', {
    method: 'POST',
    body: jsonBody({
      recipient_id: payload.recipientId,
      subject: payload.subject.trim(),
      message
    })
  });
}

export async function markEmployeeMessageRead(messageId: string) {
  await apiFetch(`/messages/${messageId}/read`, { method: 'POST', body: jsonBody({}) });
}

export async function markMyNotificationRead(notificationId: string) {
  await apiFetch(`/notifications/${notificationId}/read`, { method: 'POST', body: jsonBody({}) });
}

export async function createDisciplineAction(payload: {
  employeeId: string;
  title: string;
  details: string;
  severity: DisciplineActionRow['severity'];
  punishmentType: DisciplineActionRow['punishment_type'];
  punishmentValue: number;
}) {
  await apiFetch('/discipline', {
    method: 'POST',
    body: jsonBody({
      employee_id: payload.employeeId,
      title: payload.title,
      details: payload.details,
      severity: payload.severity,
      punishment_type: payload.punishmentType,
      punishment_value: payload.punishmentValue
    })
  });
}

export async function updateDisciplineAction(payload: {
  actionId: string;
  title: string;
  details: string;
  severity: DisciplineActionRow['severity'];
  punishmentType: DisciplineActionRow['punishment_type'];
  punishmentValue: number;
  status: DisciplineActionRow['status'];
  reviewNotes: string;
  reviewerId: string;
}) {
  await apiFetch(`/discipline/${payload.actionId}`, {
    method: 'PATCH',
    body: jsonBody({
      title: payload.title,
      details: payload.details,
      severity: payload.severity,
      punishment_type: payload.punishmentType,
      punishment_value: payload.punishmentValue,
      status: payload.status,
      review_notes: payload.reviewNotes
    })
  });
}

export async function applyDisciplineAction(actionId: string, reviewNotes = '') {
  await apiFetch(`/discipline/${actionId}/apply`, {
    method: 'POST',
    body: jsonBody({ review_notes: reviewNotes })
  });
}

export async function revokeDisciplineAction(actionId: string, reviewNotes = '') {
  await apiFetch(`/discipline/${actionId}/revoke`, {
    method: 'POST',
    body: jsonBody({ review_notes: reviewNotes })
  });
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

type StreamEvent = {
  table?: string;
  op?: string;
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
};

function openEventStream(onEvent: (event: StreamEvent) => void, onError?: () => void): () => void {
  const controller = new AbortController();
  let closed = false;

  async function run() {
    let attempt = 0;
    while (!closed) {
      const token = session?.access_token;
      if (!token) return;
      try {
        const response = await fetch(`${API_BASE}/realtime/stream`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        if (!response.ok || !response.body) throw new Error('stream unavailable');
        attempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf('\n\n');
            const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
            if (!dataLine) continue;
            try {
              onEvent(JSON.parse(dataLine.slice(5).trim()) as StreamEvent);
            } catch {
              // ignore malformed frames
            }
          }
        }
      } catch {
        if (closed) return;
        onError?.();
      }
      if (closed) return;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)));
    }
  }

  void run();
  return () => {
    closed = true;
    controller.abort();
  };
}

export function subscribeToAppRealtime(onAnyChange: () => void): () => void {
  return openEventStream((event) => {
    if (event.table && REALTIME_TABLES.has(event.table)) onAnyChange();
  });
}

export type AdminRealtimeNotificationEvent =
  | { kind: 'clock_in'; shiftId: string; employeeId: string; occurredAt: string }
  | { kind: 'clock_out'; shiftId: string; employeeId: string; occurredAt: string }
  | {
      kind: 'time_off_request_submitted';
      requestId: string;
      employeeId: string;
      requestType: TimeOffRequestRow['request_type'];
      startDate: string;
      endDate: string;
      occurredAt: string;
    }
  | {
      kind: 'exception_request_submitted';
      requestId: string;
      employeeId: string;
      exceptionCode: ExceptionRequestRow['exception_code'];
      title: string;
      startDate: string;
      endDate: string;
      occurredAt: string;
    };

export function subscribeToAdminRealtimeNotifications(
  onEvent: (event: AdminRealtimeNotificationEvent) => void
): () => void {
  return openEventStream((event) => {
    const current = event.new ?? {};
    const previous = event.old ?? {};
    if (event.table === 'shifts') {
      const shiftId = String(current.id ?? '');
      const employeeId = String(current.employee_id ?? '');
      if (!shiftId || !employeeId) return;
      if (event.op === 'insert') {
        if (current.clocked_in_at) {
          onEvent({ kind: 'clock_in', shiftId, employeeId, occurredAt: String(current.clocked_in_at) });
        }
        return;
      }
      if (event.op !== 'update') return;
      if (!previous.clocked_in_at && current.clocked_in_at) {
        onEvent({ kind: 'clock_in', shiftId, employeeId, occurredAt: String(current.clocked_in_at) });
      }
      if (!previous.clocked_out_at && current.clocked_out_at) {
        const occurred = String(current.clocked_out_at);
        const occuredMs = new Date(occurred).getTime();
        if (Number.isFinite(occuredMs) && Math.abs(occuredMs - Date.now()) > 2 * 60 * 1000) return;
        onEvent({ kind: 'clock_out', shiftId, employeeId, occurredAt: occurred });
      }
      return;
    }
    if (event.table === 'time_off_requests' && event.op === 'insert') {
      const requestId = String(current.id ?? '');
      const employeeId = String(current.employee_id ?? '');
      if (!requestId || !employeeId) return;
      onEvent({
        kind: 'time_off_request_submitted',
        requestId,
        employeeId,
        requestType: (current.request_type as TimeOffRequestRow['request_type']) ?? 'other',
        startDate: String(current.start_date ?? ''),
        endDate: String(current.end_date ?? ''),
        occurredAt: String(current.created_at ?? new Date().toISOString())
      });
      return;
    }
    if (event.table === 'exception_requests' && event.op === 'insert') {
      const requestId = String(current.id ?? '');
      const employeeId = String(current.employee_id ?? '');
      if (!requestId || !employeeId) return;
      onEvent({
        kind: 'exception_request_submitted',
        requestId,
        employeeId,
        exceptionCode: (current.exception_code as ExceptionRequestRow['exception_code']) ?? 'DO',
        title: String(current.title ?? 'Exception request'),
        startDate: String(current.start_date ?? ''),
        endDate: String(current.end_date ?? ''),
        occurredAt: String(current.created_at ?? new Date().toISOString())
      });
    }
  });
}
