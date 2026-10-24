export type Assignment = {
  id: string;
  label: string;
  start: string;
  end: string;
  color: 'green' | 'teal' | 'orange' | 'blue' | 'neutral' | 'red' | 'yellow' | 'pink' | 'purple';
  detail?: string;
  kind: 'shift' | 'task' | 'overrun';
  shiftId?: string;
  taskId?: string;
  acknowledged?: boolean;
  acknowledgedAt?: string | null;
  plannedStart?: string;
  plannedEnd?: string;
  actualStart?: string | null;
  actualEnd?: string | null;
  delayMinutes?: number | null;
  lifecycleStatus?: string;
  milestones?: Array<{
    id: string;
    label: string;
    time: string;
    status: 'planned' | 'actual' | 'missed';
  }>;
  conflicts?: string[];
};

export type BoardFilters = {
  resources: boolean;
  events: boolean;
  unassigned: boolean;
};

export type AppRole = 'admin' | 'employee';

export type ShiftStatus = 'scheduled' | 'on_duty' | 'break' | 'off_shift';
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export type TimeOffRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled';
export type TimeOffRequestType = 'vacation' | 'sick' | 'personal' | 'unpaid' | 'other';

export type ExceptionRequestType = 'absence' | 'task_completion' | 'other';
export type ExceptionRequestStatus = 'submitted' | 'under_review' | 'approved' | 'denied' | 'closed';
export type ExceptionCode = 'VAUT' | 'NCNS' | 'LTDR' | 'DO';
export type DisciplineSeverity = 'warning' | 'serious' | 'final';
export type DisciplinePunishmentType = 'none' | 'pay_rate_reduction' | 'unpaid_suspension' | 'probation';
export type DisciplineStatus = 'issued' | 'applied' | 'revoked';

export type ProfileRow = {
  id: string;
  email: string;
  full_name: string;
  helpful_info: string;
  hourly_rate: number | null;
  role: AppRole;
  retail_chaos_stationary?: boolean;
  admin_training_only?: boolean;
  is_training_manager?: boolean;
  created_at: string;
  updated_at: string;
};

export type WorkAreaRow = {
  id: string;
  name: string;
  description: string;
  color: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ShiftRow = {
  id: string;
  employee_id: string | null;
  work_area_id: string | null;
  start_at: string;
  end_at: string;
  status: ShiftStatus;
  clocked_in_at: string | null;
  clocked_out_at: string | null;
  clock_in_latitude?: number | null;
  clock_in_longitude?: number | null;
  clock_in_accuracy_meters?: number | null;
  clock_in_device?: string | null;
  clock_in_is_mobile?: boolean | null;
  is_unscheduled_overtime: boolean;
  pay_multiplier: number;
  worked_minutes: number | null;
  break_minutes: number;
  is_shift_pool: boolean;
  shift_pool_posted_at: string | null;
  shift_pool_posted_by: string | null;
  shift_pool_claimed_at: string | null;
  shift_pool_claimed_by: string | null;
  notes: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type ShiftIntakeLocation = {
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  device?: string | null;
  isMobile?: boolean | null;
};

export type ActivityTrackingRow = {
  id: string;
  shift_id: string;
  employee_id: string;
  captured_at: string;
  idle_seconds: number;
  active_window: string;
  activity_score: number;
  keystrokes: number;
  mouse_clicks: number;
  app_focus_seconds: number;
  screenshot_url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type TaskRow = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  source_system: string;
  external_id?: string | null;
  external_url?: string | null;
  start_at: string;
  end_at: string;
  work_area_id: string | null;
  shift_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskAssignmentRow = {
  id: string;
  task_id: string;
  employee_id: string;
  assigned_by: string | null;
  assigned_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  acknowledgment_note: string;
};

export type EmployeeTaskAssignment = TaskAssignmentRow & {
  task: TaskRow;
};

export type TimeOffRequestRow = {
  id: string;
  employee_id: string;
  start_date: string;
  end_date: string;
  request_type: TimeOffRequestType;
  reason: string;
  status: TimeOffRequestStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string;
  created_at: string;
  updated_at: string;
};

export type ExceptionRequestRow = {
  id: string;
  employee_id: string;
  submitted_by: string;
  exception_type: ExceptionRequestType;
  exception_code: ExceptionCode;
  title: string;
  details: string;
  start_date: string;
  end_date: string;
  related_shift_id: string | null;
  related_task_id: string | null;
  status: ExceptionRequestStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string;
  created_at: string;
  updated_at: string;
};

export type OvertimeRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled';
export type OvertimeRequestType = 'voluntary' | 'mandatory';

export type OvertimeRequestRow = {
  id: string;
  employee_id: string;
  start_at: string;
  end_at: string;
  status: OvertimeRequestStatus;
  overtime_type: OvertimeRequestType;
  assigned_by: string | null;
  note: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string;
  approved_shift_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ShiftSwapRequestStatus = 'open' | 'pending_admin' | 'approved' | 'denied' | 'cancelled';

export type ShiftSwapRequestRow = {
  id: string;
  organization_id: string;
  shift_id: string;
  requester_id: string;
  requested_employee_id: string | null;
  accepted_by_employee_id: string | null;
  status: ShiftSwapRequestStatus;
  request_note: string;
  acceptance_note: string;
  review_note: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ShiftIntelligenceSnapshot = {
  generated_at: string;
  fatigue_risk: Array<{
    employee_id: string;
    employee_name: string;
    fatigue_score: number;
    shifts_7d: number;
  }>;
  overtime_forecast: Array<{
    employee_id: string;
    employee_name: string;
    projected_overtime_hours: number;
    scheduled_hours_horizon: number;
    weekly_limit_hours: number;
  }>;
  staffing_gaps: Array<{
    day_date: string;
    work_area_id: string;
    work_area_name: string;
    scheduled_count: number;
    target_count: number;
    gap_count: number;
  }>;
  cover_now_suggestions: Array<{
    employee_id: string;
    employee_name: string;
    preferred_area: string;
    preference_match: boolean;
    current_week_hours: number;
  }>;
};

export type TimeOffCoverageImpactRow = {
  day_date: string;
  employee_shift_count: number;
  employee_task_count: number;
  work_areas_impacted: string[];
  unassigned_pool_openings: number;
  risk_level: 'low' | 'medium' | 'high';
};

export type EmployeeMessageRow = {
  id: string;
  organization_id: string;
  sender_id: string;
  recipient_id: string;
  subject: string;
  message: string;
  read_at: string | null;
  created_at: string;
  thread_key?: string | null;
};

export type TrainingAssignmentStatus = 'assigned' | 'in_progress' | 'completed';

export type TrainingCourseRow = {
  id: string;
  organization_id: string;
  title: string;
  description: string;
  content: string;
  estimated_minutes: number;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type TrainingAssignmentRow = {
  id: string;
  organization_id: string;
  course_id: string;
  employee_id: string;
  assigned_by: string | null;
  assigned_at: string;
  due_at: string | null;
  status: TrainingAssignmentStatus;
  completed_at: string | null;
  completion_notes: string;
  updated_at: string;
  course: TrainingCourseRow | null;
  employee: {
    id: string;
    full_name: string;
    email: string;
  } | null;
};

export type AppNotificationCategory =
  | 'task_assigned'
  | 'training_assigned'
  | 'message_received'
  | 'shift_pool_claimed'
  | 'shift_starting_soon'
  | 'general';

export type AppNotificationRow = {
  id: string;
  organization_id: string;
  recipient_id: string;
  actor_id: string | null;
  category: AppNotificationCategory;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export type EmployeeWorkPreferencesRow = {
  id: string;
  organization_id: string;
  employee_id: string;
  max_weekly_hours: number | null;
  preferred_work_area_ids: string[];
  availability_notes: string;
  updated_at: string;
  created_at: string;
};

export type OrganizationSettings = {
  organization_id: string;
  organization_name: string;
  admin_portal_label: string;
  login_primary_color: string;
  login_accent_color: string;
  login_logo_url: string;
  login_background_image_url: string;
  login_announcement: string;
  login_heading: string;
  login_subheading: string;
  experience_builder_config: OrganizationExperienceBuilderConfig;
  enable_retail_floor_simulation: boolean;
  enable_extended_leave_lock: boolean;
  extended_leave_threshold_days: number;
  enable_admin_realtime_notifications: boolean;
  default_timeline_window_hours: 2 | 4 | 8;
  default_shift_break_minutes: number;
  training_time_multiplier: number;
  training_fake_employee_count: number;
  training_no_show_rate_percent: number;
  training_task_ack_rate_percent: number;
  training_clock_in_early_min: number;
  training_clock_in_late_min: number;
  training_clock_out_early_min: number;
  training_clock_out_late_min: number;
};

export type ExperienceModuleType = 'announcement' | 'hero' | 'image';

export type ExperienceModule = {
  id: string;
  type: ExperienceModuleType;
  enabled: boolean;
  title: string;
  body: string;
  image_url: string;
  cta_label: string;
  cta_url: string;
};

export type OpsBoardLayoutPreset = 'ops' | 'shift-heavy' | 'task-heavy' | 'compact';

export type OrganizationExperienceBuilderConfig = {
  login_modules: ExperienceModule[];
  employee_modules: ExperienceModule[];
  opsboard_settings: {
    layout_preset: OpsBoardLayoutPreset;
    auto_fullscreen: boolean;
    sound_alerts: boolean;
    flash_alerts: boolean;
    branding_title: string;
    branding_subtitle: string;
    default_horizon_hours: 4 | 8 | 12 | 24;
    default_refresh_seconds: 15 | 30 | 60 | 120;
  };
  login_elements: {
    organization_code_label: string;
    continue_button_label: string;
    sign_in_tab_label: string;
    create_account_tab_label: string;
    full_name_label: string;
    email_label: string;
    password_label: string;
    sign_in_button_label: string;
    create_account_button_label: string;
    change_org_label: string;
  };
  employee_elements: {
    operations_title: string;
    scheduling_title: string;
    training_title: string;
    date_label: string;
    clock_in_label: string;
    clock_out_label: string;
    sign_out_label: string;
    tab_operations: string;
    tab_attendance: string;
    tab_training: string;
    submenu_home: string;
    submenu_requests: string;
    submenu_shifts: string;
    submenu_tasks: string;
    submenu_pool: string;
    submenu_alerts: string;
    submenu_messages: string;
    submenu_profile: string;
    submenu_preferences: string;
    submenu_calendar: string;
    submenu_overtime: string;
    submenu_swap: string;
    submenu_timeoff: string;
    submenu_exceptions: string;
    kpi_shifts: string;
    kpi_pending_ack: string;
    kpi_date_code: string;
    kpi_unread_messages: string;
    kpi_pool_openings: string;
    kpi_unread_alerts: string;
    kpi_pending_trainings: string;
  };
};

export type OrganizationLoginBranding = {
  organization_name: string;
  login_primary_color: string;
  login_accent_color: string;
  login_logo_url: string;
  login_background_image_url: string;
  login_announcement: string;
  login_heading: string;
  login_subheading: string;
  login_modules: ExperienceModule[];
  login_elements: OrganizationExperienceBuilderConfig['login_elements'];
};

export type OrganizationClockInLocationRow = {
  id: string;
  organization_id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type DisciplineActionRow = {
  id: string;
  organization_id: string;
  employee_id: string;
  issued_by: string;
  title: string;
  details: string;
  severity: DisciplineSeverity;
  punishment_type: DisciplinePunishmentType;
  punishment_value: number;
  status: DisciplineStatus;
  leave_starts_on: string | null;
  leave_ends_on: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string;
  created_at: string;
  updated_at: string;
};

export type BoardNoteRow = {
  id: string;
  note_date: string;
  body: string;
  is_public: boolean;
  created_by: string | null;
  author_name: string | null;
  employee_id: string | null;
  employee_name: string | null;
  work_area_id: string | null;
  work_area_name: string | null;
  created_at: string;
  updated_at: string;
};

export type AdminDashboardData = {
  employees: ProfileRow[];
  workAreas: WorkAreaRow[];
  shifts: ShiftRow[];
  monthShifts: ShiftRow[];
  activityTracking: ActivityTrackingRow[];
  tasks: TaskRow[];
  taskAssignments: TaskAssignmentRow[];
  messages: EmployeeMessageRow[];
  timeOffRequests: TimeOffRequestRow[];
  exceptionRequests: ExceptionRequestRow[];
  overtimeRequests: OvertimeRequestRow[];
  shiftSwapRequests: ShiftSwapRequestRow[];
  shiftIntelligence: ShiftIntelligenceSnapshot | null;
  disciplineActions: DisciplineActionRow[];
  boardNotes: BoardNoteRow[];
};

export type EmployeePortalData = {
  profile: ProfileRow;
  adminContacts: ProfileRow[];
  workAreas: WorkAreaRow[];
  shifts: ShiftRow[];
  shiftPoolShifts: ShiftRow[];
  monthShifts: ShiftRow[];
  taskAssignments: EmployeeTaskAssignment[];
  messages: EmployeeMessageRow[];
  notifications: AppNotificationRow[];
  workPreferences: EmployeeWorkPreferencesRow | null;
  swapMarketplaceOpenRequests: ShiftSwapRequestRow[];
  mySwapRequests: ShiftSwapRequestRow[];
  trainingAssignments: TrainingAssignmentRow[];
  timeOffRequests: TimeOffRequestRow[];
  exceptionRequests: ExceptionRequestRow[];
  overtimeRequests: OvertimeRequestRow[];
  restriction?: {
    kind: string;
    title: string;
    start_date: string | null;
    end_date: string | null;
  } | null;
};
