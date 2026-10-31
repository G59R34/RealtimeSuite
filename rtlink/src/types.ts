export type ActionKind =
  | 'time_off.create'
  | 'overtime.create'
  | 'exception.create'
  | 'swap.create'
  | 'task.acknowledge'
  | 'shift.claim'
  | 'shift.clock_in'
  | 'shift.clock_out'
  | 'shift.clock_in_unscheduled';

export type ActionStatus = 'pending' | 'applied' | 'failed' | 'cancelled';

export interface OrgSummary {
  site_id: string;
  site_name: string;
  organization_name: string | null;
  org_code: string;
}

export interface Site {
  id: string;
  name: string;
  organization_name: string | null;
  timezone: string | null;
  app_version: string | null;
  last_sync_at: string | null;
  record_counts: Record<string, number>;
}

export interface SiteSettings {
  site_id: string;
  organization_name: string | null;
  portal_label: string | null;
  feature_flags: Record<string, boolean>;
  clock_in_required: boolean;
  synced_at: string;
}

export interface Employee {
  id: string;
  site_id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  hourly_rate: number | null;
  is_training_manager: boolean;
  onboarding_completed_at: string | null;
}

export interface WorkArea {
  id: string;
  site_id: string;
  name: string | null;
  color: string | null;
  is_active: boolean;
}

export type ShiftStatus = 'scheduled' | 'on_duty' | 'break' | 'off_shift';

export interface Shift {
  id: string;
  site_id: string;
  employee_id: string | null;
  work_area_id: string | null;
  work_area_name: string | null;
  start_at: string;
  end_at: string;
  status: ShiftStatus;
  break_minutes: number;
  worked_minutes: number | null;
  clocked_in_at: string | null;
  clocked_out_at: string | null;
  is_unscheduled_overtime: boolean;
  is_shift_pool: boolean;
  shift_pool_posted_at: string | null;
  notes: string | null;
}

export interface Task {
  id: string;
  site_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  start_at: string;
  end_at: string;
  work_area_name: string | null;
  assignee_id: string;
  assignment_id: string;
  acknowledged_at: string | null;
  acknowledgment_note: string | null;
  source_system: string | null;
}

export interface Announcement {
  id: string;
  site_id: string;
  message: string;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

export interface BoardNote {
  id: string;
  site_id: string;
  note_date: string;
  body: string;
  created_at_local: string | null;
}

export interface TimeOffRequest {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  request_type: string;
  reason: string | null;
  status: string;
  review_notes: string | null;
  created_at_local: string | null;
}

export interface OvertimeRequest {
  id: string;
  employee_id: string;
  start_at: string;
  end_at: string;
  overtime_type: string;
  note: string | null;
  status: string;
  review_notes: string | null;
  created_at_local: string | null;
}

export interface ExceptionRequest {
  id: string;
  employee_id: string;
  exception_code: string;
  exception_type: string;
  title: string;
  details: string | null;
  start_date: string;
  end_date: string;
  status: string;
  review_notes: string | null;
  created_at_local: string | null;
}

export interface SwapRequest {
  id: string;
  requester_id: string;
  shift_id: string;
  requested_employee_id: string | null;
  status: string;
  request_note: string | null;
  review_note: string | null;
  shift_start_at: string | null;
  created_at_local: string | null;
}

export interface TrainingAssignment {
  id: string;
  employee_id: string;
  course_title: string | null;
  course_description: string | null;
  status: string;
  due_at: string | null;
  completed_at: string | null;
}

export interface ActionRequest {
  id: string;
  kind: ActionKind;
  payload: Record<string, unknown>;
  status: ActionStatus;
  result: string | null;
  error: string | null;
  attempts: number;
  requested_at: string;
  processed_at: string | null;
}

export interface DirectoryEntry {
  id: string;
  full_name: string | null;
}

export interface Workspace {
  employee: Employee;
  site: Site;
  settings: SiteSettings | null;
  workAreas: WorkArea[];
  shifts: Shift[];
  tasks: Task[];
  announcements: Announcement[];
  boardNotes: BoardNote[];
  timeOff: TimeOffRequest[];
  overtime: OvertimeRequest[];
  exceptions: ExceptionRequest[];
  swaps: SwapRequest[];
  training: TrainingAssignment[];
  directory: DirectoryEntry[];
  actions: ActionRequest[];
}

export type ViewMode = 'today' | 'schedule' | 'tasks' | 'requests' | 'me';
