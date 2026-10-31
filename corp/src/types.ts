export type CorpRole = 'corp_admin' | 'corp_manager' | 'corp_viewer';

export interface Scope {
  company_id: string;
  company_name: string;
  company_slug: string | null;
  location_id: string | null;
  location_name: string | null;
  role: CorpRole;
  email: string | null;
}

export interface Company {
  id: string;
  name: string;
  slug: string | null;
  industry: string | null;
  headquarters: string | null;
  created_at: string;
}

export interface Location {
  id: string;
  company_id: string;
  name: string;
  code: string | null;
  address: string | null;
  timezone: string;
  status: 'active' | 'paused' | 'closed';
  created_at: string;
}

export interface Site {
  id: string;
  company_id: string;
  location_id: string | null;
  name: string;
  app_version: string | null;
  last_sync_at: string | null;
  record_counts: Record<string, number> | null;
  created_at: string;
  updated_at: string;
}

export interface Employee {
  id: string;
  site_id: string;
  company_id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  hourly_rate: number | string | null;
  onboarding_completed_at: string | null;
  is_training_manager: boolean | null;
  is_active: boolean | null;
  created_at_local: string | null;
  updated_at_local: string | null;
}

export interface Shift {
  id: string;
  site_id: string;
  company_id: string;
  employee_id: string | null;
  employee_name: string | null;
  work_area_name: string | null;
  start_at: string | null;
  end_at: string | null;
  status: string | null;
  break_minutes: number | null;
  worked_minutes: number | null;
  pay_multiplier: number | string | null;
  clocked_in_at: string | null;
  clocked_out_at: string | null;
  is_unscheduled_overtime: boolean | null;
}

export interface TaskRow {
  id: string;
  site_id: string;
  company_id: string;
  title: string | null;
  description: string | null;
  status: string | null;
  priority: string | null;
  start_at: string | null;
  end_at: string | null;
  work_area_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  acknowledged_at: string | null;
  source_system: string | null;
}

export interface TimeOffRequest {
  id: string;
  site_id: string;
  company_id: string;
  employee_id: string | null;
  employee_name: string | null;
  start_date: string | null;
  end_date: string | null;
  request_type: string | null;
  reason: string | null;
  status: string | null;
  created_at_local: string | null;
  reviewed_at: string | null;
}

export interface ExceptionRequest {
  id: string;
  site_id: string;
  company_id: string;
  employee_id: string | null;
  employee_name: string | null;
  exception_code: string | null;
  exception_type: string | null;
  title: string | null;
  details: string | null;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
  created_at_local: string | null;
}

export interface OvertimeRequest {
  id: string;
  site_id: string;
  company_id: string;
  employee_id: string | null;
  employee_name: string | null;
  start_at: string | null;
  end_at: string | null;
  overtime_type: string | null;
  note: string | null;
  status: string | null;
  created_at_local: string | null;
}

export interface DisciplineAction {
  id: string;
  site_id: string;
  company_id: string;
  employee_id: string | null;
  employee_name: string | null;
  title: string | null;
  details: string | null;
  severity: string | null;
  punishment_type: string | null;
  status: string | null;
  leave_starts_on: string | null;
  leave_ends_on: string | null;
  created_at_local: string | null;
}

export interface TrainingAssignment {
  id: string;
  site_id: string;
  company_id: string;
  employee_id: string | null;
  employee_name: string | null;
  course_title: string | null;
  status: string | null;
  due_at: string | null;
  completed_at: string | null;
}

export interface SyncEvent {
  id: string;
  site_id: string;
  company_id: string;
  kind: string;
  status: string;
  record_counts: Record<string, number> | null;
  message: string | null;
  received_at: string;
}

export interface Policy {
  id: string;
  company_id: string;
  title: string;
  category: string;
  body: string;
  version: number;
  status: 'draft' | 'active' | 'archived';
  effective_on: string | null;
  owner: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

// Corporate-owned changes are queued for a site and applied by its server.
export type CorpCommandKind =
  | 'set_pay_rate'
  | 'set_employee_permissions'
  | 'set_shift_multiplier'
  | 'set_feature_flags'
  | 'set_policy_settings';

export interface CorpCommand {
  id: string;
  site_id: string | null;
  company_id: string | null;
  kind: CorpCommandKind;
  target_id: string | null;
  payload: Record<string, unknown>;
  note: string | null;
  status: 'pending' | 'applied' | 'failed' | 'cancelled';
  requested_by: string | null;
  requested_at: string;
  applied_at: string | null;
  attempts: number;
  error: string | null;
}

// What a view asks the app to queue for a site.
export type CommandRequest = {
  kind: CorpCommandKind;
  siteId: string;
  targetId?: string | null;
  payload: Record<string, unknown>;
  note?: string | null;
};

export interface SiteSettings {
  site_id: string;
  company_id: string;
  feature_flags: Record<string, boolean>;
  policy_settings: Record<string, unknown>;
  synced_at: string;
}

export interface CorpData {
  company: Company | null;
  locations: Location[];
  sites: Site[];
  employees: Employee[];
  shifts: Shift[];
  tasks: TaskRow[];
  timeOff: TimeOffRequest[];
  exceptions: ExceptionRequest[];
  overtime: OvertimeRequest[];
  discipline: DisciplineAction[];
  training: TrainingAssignment[];
  syncEvents: SyncEvent[];
  policies: Policy[];
  commands: CorpCommand[];
  siteSettings: SiteSettings[];
}
