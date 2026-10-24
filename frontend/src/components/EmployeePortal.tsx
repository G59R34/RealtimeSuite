import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  EmployeePortalData,
  OrganizationExperienceBuilderConfig,
  ExperienceModule,
  ExceptionCode,
  ExceptionRequestType,
  TimeOffCoverageImpactRow,
  TrainingAssignmentRow,
  OvertimeRequestType,
  TimeOffRequestType,
  WorkAreaRow
} from '../types';
import { todayDateInputValue, toReadableDate, toReadableTime } from '../lib/time';
import { DEFAULT_FEATURES } from '../lib/features';
import type { FeatureFlags } from '../lib/features';
import { ExperienceModules } from './ExperienceModules';

type EmployeePortalProps = {
  data: EmployeePortalData;
  dateValue: string;
  onDateChange: (value: string) => void;
  onSignOut: () => Promise<void>;
  onAcknowledgeTask: (assignmentId: string, note: string) => Promise<void>;
  onClockInShift: (shiftId: string, location: {
    latitude?: number;
    longitude?: number;
    accuracyMeters?: number | null;
    device?: string | null;
    isMobile?: boolean | null;
  }) => Promise<void>;
  onClockInUnscheduledShift: (note: string, location: {
    latitude?: number;
    longitude?: number;
    accuracyMeters?: number | null;
    device?: string | null;
    isMobile?: boolean | null;
  }) => Promise<void>;
  onClockOutShift: (shiftId: string) => Promise<void>;
  onCreateTimeOffRequest: (payload: {
    employeeId: string;
    startDate: string;
    endDate: string;
    requestType: TimeOffRequestType;
    reason: string;
  }) => Promise<void>;
  onCreateExceptionRequest: (payload: {
    employeeId: string;
    submittedBy: string;
    exceptionType: ExceptionRequestType;
    exceptionCode: ExceptionCode;
    title: string;
    details: string;
    startDate: string;
    endDate: string;
    relatedShiftId?: string | null;
    relatedTaskId?: string | null;
  }) => Promise<void>;
  onCreateOvertimeRequest: (payload: {
    employeeId: string;
    startAt: string;
    endAt: string;
    note: string;
    overtimeType?: OvertimeRequestType;
  }) => Promise<void>;
  onRespondToAssignedOvertimeRequest: (payload: {
    requestId: string;
    accept: boolean;
    note?: string;
  }) => Promise<void>;
  onCreateShiftSwapRequest: (payload: {
    shiftId: string;
    requestedEmployeeId?: string | null;
    requestNote?: string;
  }) => Promise<void>;
  onAcceptShiftSwapRequest: (requestId: string, acceptanceNote?: string) => Promise<void>;
  onPreviewTimeOffCoverageImpact: (payload: {
    employeeId: string;
    startDate: string;
    endDate: string;
  }) => Promise<TimeOffCoverageImpactRow[]>;
  onUpdateHelpfulInfo: (helpfulInfo: string) => Promise<void>;
  onSendMessage: (payload: { senderId: string; recipientId: string; subject: string; message: string }) => Promise<void>;
  onMarkMessageRead: (messageId: string) => Promise<void>;
  onMarkNotificationRead: (notificationId: string) => Promise<void>;
  onUpdateWorkPreferences: (payload: {
    maxWeeklyHours: number | null;
    preferredWorkAreaIds: string[];
    availabilityNotes: string;
  }) => Promise<void>;
  onClaimShiftPool: (shiftId: string) => Promise<void>;
  onCompleteTraining: (assignmentId: string, completionNotes: string) => Promise<void>;
  employeeExperienceModules?: ExperienceModule[];
  employeeExperienceElements?: OrganizationExperienceBuilderConfig['employee_elements'];
  enabledFeatures?: FeatureFlags;

  busy: boolean;
};

type CalendarCell = {
  key: string;
  dayNumber: number;
  inMonth: boolean;
};

type ScheduleCode = ExceptionCode | 'ATO';

const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CLOCK_IN_BUFFER_MINUTES = 5;

function statusLabel(status: string): string {
  return status.replace('_', ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}


function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoToDateKey(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function dateToKey(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function dateToInput(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function shortClock(isoDate: string): string {
  const date = new Date(isoDate);
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${hour}:${minute}`;
}

function toIso(dateValue: string, timeValue: string): string {
  const [year, month, day] = dateValue.split('-').map(Number);
  const [hour, minute] = timeValue.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

function toMinutes(clock: string): number {
  const [hour, minute] = clock.split(':').map(Number);
  return hour * 60 + minute;
}

function minutesToClock(minutes: number): string {
  const bounded = Math.min(Math.max(minutes, 0), 24 * 60 - 1);
  const hour = Math.floor(bounded / 60);
  const minute = bounded % 60;
  return `${pad2(hour)}:${pad2(minute)}`;
}

async function requestDeviceLocation(): Promise<{ latitude: number; longitude: number; accuracyMeters?: number | null }> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new Error('Location services are unavailable on this device/browser.');
  }

  return await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy
        });
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          reject(new Error('Location permission was denied. Enable location access to clock in.'));
          return;
        }
        if (error.code === error.POSITION_UNAVAILABLE) {
          reject(new Error('Unable to determine your location. Try again in an open area.'));
          return;
        }
        if (error.code === error.TIMEOUT) {
          reject(new Error('Location lookup timed out. Please try again.'));
          return;
        }
        reject(new Error('Unable to capture your location.'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 }
    );
  });
}

function currentClockInDeviceContext(): { device: string; isMobile: boolean } {
  if (typeof navigator === 'undefined') {
    return { device: 'unknown', isMobile: false };
  }
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  return {
    device: mobile ? 'mobile' : 'desktop',
    isMobile: mobile
  };
}

function enumerateDateKeys(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const keys: string[] = [];

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return keys;
  }

  const cursor = new Date(start);
  while (cursor <= end) {
    keys.push(dateToInput(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return keys;
}

function buildMonthGrid(dateValue: string): CalendarCell[] {
  const [year, month] = dateValue.split('-').map(Number);
  const monthStart = new Date(year, month - 1, 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);

    return {
      key: dateToInput(date),
      dayNumber: date.getDate(),
      inMonth: date.getMonth() === monthStart.getMonth()
    };
  });
}

function codePriority(code: ScheduleCode): number {
  if (code === 'NCNS') return 5;
  if (code === 'LTDR') return 4;
  if (code === 'ATO') return 3;
  if (code === 'VAUT') return 2;
  return 1;
}

function resolveAreaName(workAreaId: string | null, workAreaById: Map<string, WorkAreaRow>): string {
  if (!workAreaId) return 'Unassigned';
  return workAreaById.get(workAreaId)?.name ?? 'Unassigned';
}

function computeUnpaidEarlyInMinutes(shift: EmployeePortalData['shifts'][number]): number {
  if (!shift.clocked_in_at || shift.is_unscheduled_overtime) return 0;

  const shiftStart = new Date(shift.start_at).getTime();
  const clockIn = new Date(shift.clocked_in_at).getTime();
  if (!Number.isFinite(shiftStart) || !Number.isFinite(clockIn)) return 0;

  const bufferStart = shiftStart - CLOCK_IN_BUFFER_MINUTES * 60 * 1000;
  if (clockIn >= bufferStart) return 0;

  return Math.max(0, Math.floor((shiftStart - clockIn) / 60000));
}

export function EmployeePortal({
  data,
  dateValue,
  onDateChange,
  onSignOut,
  onAcknowledgeTask,
  onClockInShift,
  onClockInUnscheduledShift,
  onClockOutShift,
  onCreateTimeOffRequest,
  onCreateExceptionRequest,
  onCreateOvertimeRequest,
  onRespondToAssignedOvertimeRequest,
  onCreateShiftSwapRequest,
  onAcceptShiftSwapRequest,
  onPreviewTimeOffCoverageImpact,
  onUpdateHelpfulInfo,
  onSendMessage,
  onMarkMessageRead,
  onMarkNotificationRead,
  onUpdateWorkPreferences,
  onClaimShiftPool,
  onCompleteTraining,
  employeeExperienceModules = [],
  employeeExperienceElements,
  enabledFeatures = DEFAULT_FEATURES,
  busy
}: EmployeePortalProps) {
  const showShifts = enabledFeatures.shifts;
  const showTasks = enabledFeatures.tasks;
  const showShiftPool = enabledFeatures.shift_pool;
  const showAlerts = enabledFeatures.notifications;
  const showMessages = enabledFeatures.messages;
  const showPreferences = enabledFeatures.work_preferences;
  const showOvertime = enabledFeatures.overtime;
  const showSwaps = enabledFeatures.shift_swaps;
  const showTimeOff = enabledFeatures.time_off;
  const showExceptions = enabledFeatures.exceptions;
  const showTraining = enabledFeatures.training;
  const showScheduling = enabledFeatures.shifts;
  const showClockButton = enabledFeatures.clock_in || enabledFeatures.unscheduled_clock_in;

  const ui = {
    operations_title: 'Home',
    scheduling_title: 'Schedule',
    training_title: 'Training',
    date_label: 'Date',
    clock_in_label: 'Clock In',
    clock_out_label: 'Clock Out',
    sign_out_label: 'Sign Out',
    tab_operations: 'Home',
    tab_scheduling: 'Schedule',
    tab_training: 'Training',
    submenu_home: 'Overview',
    submenu_shifts: 'My Shifts',
    submenu_tasks: 'My Tasks',
    submenu_pool: 'Shift Pool',
    submenu_alerts: 'Alerts',
    submenu_messages: 'Messages',
    submenu_profile: 'Profile & Preferences',
    submenu_preferences: 'Preferences',
    submenu_calendar: 'Calendar',
    submenu_requests: 'Requests',
    submenu_overtime: 'Overtime',
    submenu_swap: 'Shift Swaps',
    submenu_timeoff: 'Time Off',
    submenu_exceptions: 'Exceptions',
    kpi_shifts: 'Shifts On Date',
    kpi_pending_ack: 'Pending Task ACK',
    kpi_date_code: 'Date Code',
    kpi_unread_messages: 'Unread Messages',
    kpi_pool_openings: 'Shift Pool Openings',
    kpi_unread_alerts: 'Unread Alerts',
    kpi_pending_trainings: 'Pending Trainings',
    ...(employeeExperienceElements ?? {})
  };
  const [portalTab, setPortalTab] = useState<'operations' | 'scheduling' | 'training'>('operations');
  const [navOpen, setNavOpen] = useState(false);
  const [operationsSubpage, setOperationsSubpage] = useState<'home' | 'profile'>('home');
  const [schedulingSubpage, setSchedulingSubpage] = useState<'calendar' | 'requests'>('calendar');
  const [ackNotes, setAckNotes] = useState<Record<string, string>>({});
  const [trainingNotes, setTrainingNotes] = useState<Record<string, string>>({});
  const [helpfulInfoDraft, setHelpfulInfoDraft] = useState(data.profile.helpful_info ?? '');
  const [messageRecipientId, setMessageRecipientId] = useState(data.adminContacts[0]?.id ?? '');
  const [messageSubject, setMessageSubject] = useState('');
  const [messageBody, setMessageBody] = useState('');

  const [requestStart, setRequestStart] = useState(todayDateInputValue());
  const [requestEnd, setRequestEnd] = useState(todayDateInputValue());
  const [requestType, setRequestType] = useState<TimeOffRequestType>('vacation');
  const [requestReason, setRequestReason] = useState('');

  const [overtimeDirection, setOvertimeDirection] = useState<'before' | 'after'>('after');
  const [overtimeStart, setOvertimeStart] = useState('17:00');
  const [overtimeEnd, setOvertimeEnd] = useState('18:00');
  const [overtimeNote, setOvertimeNote] = useState('');
  const [swapShiftId, setSwapShiftId] = useState('');
  const [swapRequestedEmployeeId, setSwapRequestedEmployeeId] = useState('');
  const [swapRequestNote, setSwapRequestNote] = useState('');
  const [swapAcceptanceNotes, setSwapAcceptanceNotes] = useState<Record<string, string>>({});
  const [timeOffCoverageImpact, setTimeOffCoverageImpact] = useState<TimeOffCoverageImpactRow[]>([]);
  const [coveragePreviewBusy, setCoveragePreviewBusy] = useState(false);

  const [exceptionType, setExceptionType] = useState<ExceptionRequestType>('absence');
  const [exceptionCode, setExceptionCode] = useState<ExceptionCode>('VAUT');
  const [exceptionStartDate, setExceptionStartDate] = useState(todayDateInputValue());
  const [exceptionEndDate, setExceptionEndDate] = useState(todayDateInputValue());
  const [exceptionTitle, setExceptionTitle] = useState('');
  const [exceptionDetails, setExceptionDetails] = useState('');
  const [exceptionRelatedTaskId, setExceptionRelatedTaskId] = useState('');
  const [exceptionRelatedShiftId, setExceptionRelatedShiftId] = useState('');
  const [maxWeeklyHoursDraft, setMaxWeeklyHoursDraft] = useState('');
  const [availabilityNotesDraft, setAvailabilityNotesDraft] = useState('');
  const [preferredAreaIdsDraft, setPreferredAreaIdsDraft] = useState<string[]>([]);

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHelpfulInfoDraft(data.profile.helpful_info ?? '');
  }, [data.profile.helpful_info]);

  useEffect(() => {
    if (!data.adminContacts.some((admin) => admin.id === messageRecipientId)) {
      setMessageRecipientId(data.adminContacts[0]?.id ?? '');
    }
  }, [data.adminContacts, messageRecipientId]);

  useEffect(() => {
    setMaxWeeklyHoursDraft(data.workPreferences?.max_weekly_hours ? String(data.workPreferences.max_weekly_hours) : '');
    setAvailabilityNotesDraft(data.workPreferences?.availability_notes ?? '');
    setPreferredAreaIdsDraft(data.workPreferences?.preferred_work_area_ids ?? []);
  }, [data.workPreferences]);

  useEffect(() => {
    if (!showScheduling && portalTab === 'scheduling') setPortalTab('operations');
    if (!showTraining && portalTab === 'training') setPortalTab('operations');
  }, [portalTab, showScheduling, showTraining]);

  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [navOpen]);

  const workAreaById = useMemo(() => new Map(data.workAreas.map((workArea) => [workArea.id, workArea])), [data.workAreas]);

  const monthTitle = useMemo(() => {
    const [year, month] = dateValue.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }, [dateValue]);

  const monthGrid = useMemo(() => buildMonthGrid(dateValue), [dateValue]);

  const shiftsByDate = useMemo(() => {
    const map = new Map<string, typeof data.monthShifts>();

    for (const shift of data.monthShifts) {
      const key = isoToDateKey(shift.start_at);
      const bucket = map.get(key) ?? [];
      bucket.push(shift);
      map.set(key, bucket);
    }

    for (const bucket of map.values()) {
      bucket.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
    }

    return map;
  }, [data.monthShifts]);

  const scheduleCodeByDate = useMemo(() => {
    const map = new Map<string, ScheduleCode>();

    for (const request of data.exceptionRequests) {
      if (request.status !== 'approved') continue;
      const keys = enumerateDateKeys(request.start_date, request.end_date);

      for (const key of keys) {
        const current = map.get(key);
        if (!current || codePriority(request.exception_code) > codePriority(current)) {
          map.set(key, request.exception_code);
        }
      }
    }

    for (const request of data.timeOffRequests) {
      if (request.status !== 'approved') continue;
      const keys = enumerateDateKeys(request.start_date, request.end_date);

      for (const key of keys) {
        const current = map.get(key);
        if (!current || codePriority('ATO') > codePriority(current)) {
          map.set(key, 'ATO');
        }
      }
    }

    return map;
  }, [data.exceptionRequests, data.timeOffRequests]);

  const approvedTimeOffByDate = useMemo(() => {
    const map = new Map<string, { requestType: TimeOffRequestType; startDate: string; endDate: string }>();

    for (const request of data.timeOffRequests) {
      if (request.status !== 'approved') continue;
      const keys = enumerateDateKeys(request.start_date, request.end_date);
      for (const key of keys) {
        if (!map.has(key)) {
          map.set(key, {
            requestType: request.request_type,
            startDate: request.start_date,
            endDate: request.end_date
          });
        }
      }
    }

    return map;
  }, [data.timeOffRequests]);

  const selectedDateApprovedTimeOff = useMemo(() => {
    return approvedTimeOffByDate.get(dateValue) ?? null;
  }, [approvedTimeOffByDate, dateValue]);

  const todayKey = useMemo(() => dateToKey(new Date()), []);
  const hasOpenShift = useMemo(() => {
    return data.shifts.some((shift) => Boolean(shift.clocked_in_at) && !shift.clocked_out_at && shift.status !== 'off_shift');
  }, [data.shifts]);
  const openShift = useMemo(() => {
    return data.shifts.find((shift) => Boolean(shift.clocked_in_at) && !shift.clocked_out_at && shift.status !== 'off_shift') ?? null;
  }, [data.shifts]);
  const isTodaySelected = useMemo(() => dateValue === todayKey, [dateValue, todayKey]);
  const sortedDayShifts = useMemo(() => {
    return [...data.shifts].sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
  }, [data.shifts]);
  const employeeShiftOptions = useMemo(() => {
    const nowMs = Date.now();
    return [...data.monthShifts]
      .filter((shift) => shift.employee_id === data.profile.id && new Date(shift.end_at).getTime() >= nowMs)
      .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
  }, [data.monthShifts, data.profile.id]);
  const shiftById = useMemo(() => {
    const map = new Map<string, EmployeePortalData['shifts'][number]>();
    const all = [...data.monthShifts, ...data.shifts, ...data.shiftPoolShifts];
    for (const shift of all) {
      map.set(shift.id, shift);
    }
    return map;
  }, [data.monthShifts, data.shifts, data.shiftPoolShifts]);
  const openSwapRequests = useMemo(() => {
    return [...data.swapMarketplaceOpenRequests]
      .filter((row) => row.status === 'open')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [data.swapMarketplaceOpenRequests]);
  const mySwapRequests = useMemo(() => {
    return [...data.mySwapRequests].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [data.mySwapRequests]);
  const eligiblePunchShifts = useMemo(() => {
    return sortedDayShifts.filter((shift) => !shift.is_unscheduled_overtime && shift.status !== 'off_shift');
  }, [sortedDayShifts]);
  const punchClockInTargetShiftId = useMemo(() => {
    if (!isTodaySelected) return null;
    if (eligiblePunchShifts.length === 0) return null;

    const nowMs = Date.now();
    const active = eligiblePunchShifts.find((shift) => {
      const startMs = new Date(shift.start_at).getTime();
      const endMs = new Date(shift.end_at).getTime();
      return Number.isFinite(startMs) && Number.isFinite(endMs) && nowMs >= startMs && nowMs < endMs;
    });
    if (active) return active.id;

    const next = eligiblePunchShifts.find((shift) => {
      const startMs = new Date(shift.start_at).getTime();
      return Number.isFinite(startMs) && startMs > nowMs;
    });
    if (next) return next.id;

    const lastEndMs = Math.max(...eligiblePunchShifts.map((shift) => new Date(shift.end_at).getTime()).filter(Number.isFinite));
    if (Number.isFinite(lastEndMs) && nowMs > lastEndMs) {
      return null;
    }

    return eligiblePunchShifts[0].id;
  }, [eligiblePunchShifts, isTodaySelected]);
  const sortedTaskAssignments = useMemo(() => {
    return [...data.taskAssignments].sort(
      (a, b) => new Date(a.task.start_at).getTime() - new Date(b.task.start_at).getTime()
    );
  }, [data.taskAssignments]);
  const pendingTaskCount = useMemo(() => {
    return sortedTaskAssignments.filter((assignment) => !assignment.acknowledged_at).length;
  }, [sortedTaskAssignments]);
  const unreadMessageCount = useMemo(() => {
    return data.messages.filter((entry) => entry.recipient_id === data.profile.id && !entry.read_at).length;
  }, [data.messages, data.profile.id]);
  const unreadNotificationCount = useMemo(() => {
    return data.notifications.filter((entry) => !entry.read_at).length;
  }, [data.notifications]);
  const availablePoolShifts = useMemo(() => {
    return [...data.shiftPoolShifts].sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
  }, [data.shiftPoolShifts]);
  const sortedTrainingAssignments = useMemo(() => {
    return [...data.trainingAssignments].sort((a, b) => new Date(b.assigned_at).getTime() - new Date(a.assigned_at).getTime());
  }, [data.trainingAssignments]);
  const pendingTrainingCount = useMemo(() => {
    return sortedTrainingAssignments.filter((assignment) => assignment.status !== 'completed').length;
  }, [sortedTrainingAssignments]);
  const selectedDateCode = useMemo(() => {
    if (selectedDateApprovedTimeOff) {
      return 'ATO';
    }
    return scheduleCodeByDate.get(dateValue) ?? (sortedDayShifts.length === 0 ? 'DO' : 'SHIFT');
  }, [dateValue, scheduleCodeByDate, selectedDateApprovedTimeOff, sortedDayShifts.length]);

  const selectedDateLabel = useMemo(() => {
    const parsed = new Date(`${dateValue}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return dateValue;
    return parsed.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }, [dateValue]);

  const nextShift = useMemo(() => {
    if (sortedDayShifts.length === 0) return null;
    const nowMs = Date.now();
    return sortedDayShifts.find((shift) => new Date(shift.end_at).getTime() >= nowMs) ?? sortedDayShifts[0];
  }, [sortedDayShifts]);

  const nextUpcomingShift = useMemo(() => {
    const nowMs = Date.now();
    return (
      [...data.monthShifts]
        .filter((shift) => new Date(shift.start_at).getTime() >= nowMs)
        .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())[0] ?? null
    );
  }, [data.monthShifts]);

  const pendingTrainings = useMemo(() => {
    return sortedTrainingAssignments.filter((assignment) => assignment.status !== 'completed');
  }, [sortedTrainingAssignments]);

  const dayShiftEnvelope = useMemo(() => {
    if (sortedDayShifts.length === 0) return null;
    const firstStart = shortClock(sortedDayShifts[0].start_at);
    const lastEnd = shortClock(sortedDayShifts[sortedDayShifts.length - 1].end_at);
    return { firstStart, lastEnd };
  }, [sortedDayShifts]);
  const pendingAssignedVoluntaryOvertime = useMemo(() => {
    return [...data.overtimeRequests]
      .filter((request) => request.status === 'pending' && request.overtime_type === 'voluntary' && Boolean(request.assigned_by))
      .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
  }, [data.overtimeRequests]);

  useEffect(() => {
    if (!dayShiftEnvelope) {
      setOvertimeStart('17:00');
      setOvertimeEnd('18:00');
      return;
    }

    if (overtimeDirection === 'before') {
      const endMinutes = toMinutes(dayShiftEnvelope.firstStart);
      const startMinutes = Math.max(0, endMinutes - 60);
      setOvertimeStart(minutesToClock(startMinutes));
      setOvertimeEnd(minutesToClock(endMinutes));
    } else {
      const startMinutes = toMinutes(dayShiftEnvelope.lastEnd);
      const endMinutes = Math.min(24 * 60 - 1, startMinutes + 60);
      setOvertimeStart(minutesToClock(startMinutes));
      setOvertimeEnd(minutesToClock(endMinutes));
    }
  }, [dateValue, dayShiftEnvelope, overtimeDirection]);

  useEffect(() => {
    if (employeeShiftOptions.length === 0) {
      setSwapShiftId('');
      return;
    }
    if (!employeeShiftOptions.some((shift) => shift.id === swapShiftId)) {
      setSwapShiftId(employeeShiftOptions[0].id);
    }
  }, [employeeShiftOptions, swapShiftId]);

  useEffect(() => {
    setTimeOffCoverageImpact([]);
  }, [requestStart, requestEnd]);

  async function acknowledge(assignmentId: string) {
    setMessage(null);
    setError(null);

    try {
      await onAcknowledgeTask(assignmentId, ackNotes[assignmentId] ?? '');
      setMessage('Task acknowledged.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to acknowledge task.');
    }
  }







  async function clockIn(shiftId: string) {
    setMessage(null);
    setError(null);

    try {
      await onClockInShift(shiftId, currentClockInDeviceContext());
      setMessage('Clocked in successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clock in.');
    }
  }

  async function clockInUnscheduled() {
    setMessage(null);
    setError(null);

    try {
      await onClockInUnscheduledShift('Unscheduled overtime', currentClockInDeviceContext());
      setMessage('Clocked in to unscheduled overtime.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clock in unscheduled overtime.');
    }
  }

  async function globalClockIn() {
    setMessage(null);
    setError(null);

    if (!isTodaySelected) {
      setError('Clock In is only available for today.');
      return;
    }

    if (hasOpenShift) {
      setError('Already clocked in.');
      return;
    }

    if (punchClockInTargetShiftId) {
      await clockIn(punchClockInTargetShiftId);
      return;
    }

    await clockInUnscheduled();
  }

  async function globalClockOut() {
    setMessage(null);
    setError(null);

    if (!isTodaySelected) {
      setError('Clock Out is only available for today.');
      return;
    }

    if (!openShift) {
      setError('No active clock-in found.');
      return;
    }

    await clockOut(openShift.id);
  }

  async function globalPunch() {
    if (hasOpenShift) {
      await globalClockOut();
      return;
    }
    await globalClockIn();
  }

  async function submitOvertimeRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (!dayShiftEnvelope) {
      setError('You must have a scheduled shift on this day to request same-day overtime.');
      return;
    }

    const startMinutes = toMinutes(overtimeStart);
    const endMinutes = toMinutes(overtimeEnd);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || endMinutes <= startMinutes) {
      setError('Overtime end time must be later than start time.');
      return;
    }

    const firstShiftStart = toMinutes(dayShiftEnvelope.firstStart);
    const lastShiftEnd = toMinutes(dayShiftEnvelope.lastEnd);

    if (overtimeDirection === 'before' && endMinutes > firstShiftStart) {
      setError(`Overtime must end by ${dayShiftEnvelope.firstStart} (before your first shift).`);
      return;
    }

    if (overtimeDirection === 'after' && startMinutes < lastShiftEnd) {
      setError(`Overtime must start at or after ${dayShiftEnvelope.lastEnd} (after your last shift).`);
      return;
    }

    const overlapsShift = sortedDayShifts.some((shift) => {
      const shiftStart = toMinutes(shortClock(shift.start_at));
      const shiftEnd = toMinutes(shortClock(shift.end_at));
      return startMinutes < shiftEnd && endMinutes > shiftStart;
    });

    if (overlapsShift) {
      setError('Overtime request overlaps an existing shift.');
      return;
    }

    try {
      await onCreateOvertimeRequest({
        employeeId: data.profile.id,
        startAt: toIso(dateValue, overtimeStart),
        endAt: toIso(dateValue, overtimeEnd),
        note: overtimeNote.trim(),
        overtimeType: 'voluntary'
      });
      setOvertimeNote('');
      setMessage('Overtime request submitted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit overtime request.');
    }
  }

  async function respondToAssignedOvertime(requestId: string, accept: boolean) {
    setMessage(null);
    setError(null);
    try {
      await onRespondToAssignedOvertimeRequest({
        requestId,
        accept,
        note: accept ? 'Accepted assigned voluntary overtime.' : 'Declined assigned voluntary overtime.'
      });
      setMessage(accept ? 'Voluntary overtime accepted.' : 'Voluntary overtime declined.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to respond to assigned overtime.');
    }
  }

  async function clockOut(shiftId: string) {
    setMessage(null);
    setError(null);

    try {
      await onClockOutShift(shiftId);
      setMessage('Clocked out successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clock out.');
    }
  }

  async function submitTimeOff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    try {
      await onCreateTimeOffRequest({
        employeeId: data.profile.id,
        startDate: requestStart,
        endDate: requestEnd,
        requestType,
        reason: requestReason.trim()
      });
      setRequestReason('');
      setMessage('Time-off request submitted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit request.');
    }
  }

  async function previewCoverageImpact() {
    setMessage(null);
    setError(null);
    setCoveragePreviewBusy(true);
    try {
      const rows = await onPreviewTimeOffCoverageImpact({
        employeeId: data.profile.id,
        startDate: requestStart,
        endDate: requestEnd
      });
      setTimeOffCoverageImpact(rows);
      if (rows.length === 0) {
        setMessage('No direct coverage impact detected for this request window.');
      } else {
        setMessage(`Coverage preview generated for ${rows.length} day(s).`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to preview coverage impact.');
    } finally {
      setCoveragePreviewBusy(false);
    }
  }

  async function submitException(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    try {
      await onCreateExceptionRequest({
        employeeId: data.profile.id,
        submittedBy: data.profile.id,
        exceptionType,
        exceptionCode,
        title: exceptionTitle.trim(),
        details: exceptionDetails.trim(),
        startDate: exceptionStartDate,
        endDate: exceptionEndDate,
        relatedTaskId: exceptionRelatedTaskId || null,
        relatedShiftId: exceptionRelatedShiftId || null
      });
      setExceptionTitle('');
      setExceptionDetails('');
      setExceptionRelatedTaskId('');
      setExceptionRelatedShiftId('');
      setMessage('Exception request submitted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit exception request.');
    }
  }

  async function saveHelpfulInfo() {
    setMessage(null);
    setError(null);

    try {
      await onUpdateHelpfulInfo(helpfulInfoDraft.trim());
      setMessage('Profile information saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile information.');
    }
  }

  async function sendMessageToAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (!messageRecipientId || !messageBody.trim()) {
      setError('Recipient and message are required.');
      return;
    }

    try {
      await onSendMessage({
        senderId: data.profile.id,
        recipientId: messageRecipientId,
        subject: messageSubject.trim(),
        message: messageBody.trim()
      });
      setMessageSubject('');
      setMessageBody('');
      setMessage('Message sent.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message.');
    }
  }

  async function markAsRead(messageId: string) {
    setMessage(null);
    setError(null);

    try {
      await onMarkMessageRead(messageId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark message as read.');
    }
  }

  async function markNotificationRead(notificationId: string) {
    setMessage(null);
    setError(null);

    try {
      await onMarkNotificationRead(notificationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark notification as read.');
    }
  }

  function togglePreferredArea(areaId: string, checked: boolean) {
    setPreferredAreaIdsDraft((current) => {
      if (checked) {
        if (current.includes(areaId)) return current;
        return [...current, areaId];
      }
      return current.filter((id) => id !== areaId);
    });
  }

  async function saveWorkPreferences() {
    setMessage(null);
    setError(null);

    try {
      const nextHours = maxWeeklyHoursDraft.trim();
      await onUpdateWorkPreferences({
        maxWeeklyHours: nextHours.length > 0 ? Math.max(1, Math.min(80, Number(nextHours) || 0)) : null,
        preferredWorkAreaIds: preferredAreaIdsDraft,
        availabilityNotes: availabilityNotesDraft.trim()
      });
      setMessage('Work preferences saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save work preferences.');
    }
  }

  async function claimShift(shiftId: string) {
    setMessage(null);
    setError(null);

    try {
      await onClaimShiftPool(shiftId);
      setMessage('Shift picked up from pool.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to claim shift pool shift.');
    }
  }

  async function createSwapRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (!swapShiftId) {
      setError('Select a shift to post for swap.');
      return;
    }

    try {
      await onCreateShiftSwapRequest({
        shiftId: swapShiftId,
        requestedEmployeeId: swapRequestedEmployeeId || null,
        requestNote: swapRequestNote.trim()
      });
      setSwapRequestNote('');
      setSwapRequestedEmployeeId('');
      setMessage('Shift swap request posted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create shift swap request.');
    }
  }

  async function acceptSwapRequest(requestId: string) {
    setMessage(null);
    setError(null);
    try {
      await onAcceptShiftSwapRequest(requestId, swapAcceptanceNotes[requestId] ?? '');
      setMessage('Swap request accepted and sent for admin approval.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept shift swap request.');
    }
  }

  async function completeTraining(assignment: TrainingAssignmentRow) {
    setMessage(null);
    setError(null);

    try {
      await onCompleteTraining(assignment.id, trainingNotes[assignment.id] ?? '');
      setMessage('Training marked complete.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete training.');
    }
  }

  return (
    <section className="employee-portal-shell">
      <header className="employee-portal-header">
        <div className="employee-portal-identity">
          <button
            type="button"
            className="employee-nav-toggle"
            aria-label="Open employee menu"
            aria-expanded={navOpen}
            aria-controls="employee-nav"
            onClick={() => setNavOpen(true)}
          >
            <span className="employee-nav-toggle-bars" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>Menu</span>
          </button>
          <div>
            <h1>Employee Portal</h1>
            <p>{data.profile.full_name || data.profile.email}</p>
          </div>
        </div>

        <div className="employee-portal-controls">
          <label>
            {ui.date_label}
            <input type="date" value={dateValue} onChange={(event) => onDateChange(event.target.value)} />
          </label>
          {showClockButton ? (
            <button type="button" onClick={() => void globalPunch()} disabled={busy} title={isTodaySelected ? '' : 'Clock In/Out is only available for today.'}>
              {hasOpenShift ? ui.clock_out_label : ui.clock_in_label}
            </button>
          ) : null}
          <button type="button" onClick={() => onSignOut()}>{ui.sign_out_label}</button>
        </div>
      </header>

      {navOpen ? (
        <button
          type="button"
          className="employee-nav-backdrop"
          aria-label="Close employee menu"
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      <nav id="employee-nav" className={navOpen ? 'employee-nav open' : 'employee-nav'} aria-label="Employee menu">
        <div className="employee-nav-head">
          <div>
            <strong>{data.profile.full_name || data.profile.email}</strong>
            <span>Employee menu</span>
          </div>
          <button type="button" className="employee-nav-close" aria-label="Close employee menu" onClick={() => setNavOpen(false)}>
            ✕
          </button>
        </div>

        <div className="employee-tabbar">
          <button type="button" className={portalTab === 'operations' ? 'active' : ''} onClick={() => { setPortalTab('operations'); setNavOpen(false); }}>
            {ui.tab_operations}
          </button>
          {showScheduling ? (
            <button type="button" className={portalTab === 'scheduling' ? 'active' : ''} onClick={() => { setPortalTab('scheduling'); setNavOpen(false); }}>
              {ui.tab_scheduling}
            </button>
          ) : null}
          {showTraining ? (
            <button type="button" className={portalTab === 'training' ? 'active' : ''} onClick={() => { setPortalTab('training'); setNavOpen(false); }}>
              {ui.tab_training}
            </button>
          ) : null}
        </div>

        <div className="employee-submenu">
          {portalTab === 'operations' ? (
            <>
              <button type="button" className={operationsSubpage === 'home' ? 'active' : ''} onClick={() => { setOperationsSubpage('home'); setNavOpen(false); }}>{ui.submenu_home}</button>
              <button type="button" className={operationsSubpage === 'profile' ? 'active' : ''} onClick={() => { setOperationsSubpage('profile'); setNavOpen(false); }}>{ui.submenu_profile}</button>
            </>
          ) : null}
          {portalTab === 'scheduling' ? (
            <>
              <button type="button" className={schedulingSubpage === 'calendar' ? 'active' : ''} onClick={() => { setSchedulingSubpage('calendar'); setNavOpen(false); }}>{ui.submenu_calendar}</button>
              <button type="button" className={schedulingSubpage === 'requests' ? 'active' : ''} onClick={() => { setSchedulingSubpage('requests'); setNavOpen(false); }}>{ui.submenu_requests}</button>
            </>
          ) : null}
        </div>
      </nav>

      {employeeExperienceModules.length > 0 ? (
        <ExperienceModules modules={employeeExperienceModules} />
      ) : null}

      {portalTab === 'operations' && operationsSubpage === 'home' ? (
      <section className="employee-glance" aria-label="Today at a glance">
        <div className="employee-glance-block employee-glance-date">
          <span className="employee-glance-eyebrow">{isTodaySelected ? 'Today' : 'Selected day'}</span>
          <strong>{selectedDateLabel}</strong>
          {selectedDateCode === 'SHIFT' ? (
            <span className="employee-badge neutral">Scheduled</span>
          ) : (
            <span className={`code-pill code-${selectedDateCode.toLowerCase()}`}>{selectedDateCode}</span>
          )}
        </div>

        <div className="employee-glance-block employee-glance-shift">
          <span className="employee-glance-eyebrow">{nextShift ? 'Shift' : 'No shift'}</span>
          {nextShift ? (
            <>
              <strong>
                {toReadableTime(nextShift.start_at)}–{toReadableTime(nextShift.end_at)}
                <span className={`employee-badge ${nextShift.status === 'on_duty' ? 'success' : 'neutral'}`}>
                  {statusLabel(nextShift.status)}
                </span>
              </strong>
              <small>
                {resolveAreaName(nextShift.work_area_id, workAreaById)}
                {nextShift.pay_multiplier > 1 ? ` · OT ${nextShift.pay_multiplier.toFixed(1)}x` : ''}
                {nextShift.clocked_in_at && !nextShift.clocked_out_at ? ' · On the clock' : ''}
              </small>
            </>
          ) : (
            <>
              <strong>
                {selectedDateApprovedTimeOff
                  ? `Authorized time off (${statusLabel(selectedDateApprovedTimeOff.requestType)})`
                  : 'No shift scheduled'}
              </strong>
              <small>
                {selectedDateApprovedTimeOff
                  ? `${selectedDateApprovedTimeOff.startDate} → ${selectedDateApprovedTimeOff.endDate}`
                  : nextUpcomingShift
                    ? `Next shift: ${toReadableDate(nextUpcomingShift.start_at)}`
                    : 'Nothing else on the schedule.'}
              </small>
            </>
          )}
        </div>

        <div className="employee-glance-block employee-glance-stats">
          <span className="employee-glance-stat">
            <strong>{pendingTaskCount}</strong>
            <span>{pendingTaskCount === 1 ? 'task to acknowledge' : 'tasks to acknowledge'}</span>
          </span>
          <span className="employee-glance-stat">
            <strong>{unreadNotificationCount + unreadMessageCount}</strong>
            <span>unread alerts & messages</span>
          </span>
          {showShiftPool ? (
            <span className="employee-glance-stat">
              <strong>{availablePoolShifts.length}</strong>
              <span>{availablePoolShifts.length === 1 ? 'open shift' : 'open shifts'}</span>
            </span>
          ) : null}
          {showTraining ? (
            <span className="employee-glance-stat">
              <strong>{pendingTrainingCount}</strong>
              <span>{pendingTrainingCount === 1 ? 'training pending' : 'trainings pending'}</span>
            </span>
          ) : null}
        </div>

        {showClockButton ? (
          <button
            type="button"
            className="employee-glance-punch"
            onClick={() => void globalPunch()}
            disabled={busy}
            title={isTodaySelected ? '' : 'Clock In/Out is only available for today.'}
          >
            {hasOpenShift ? ui.clock_out_label : ui.clock_in_label}
          </button>
        ) : null}
      </section>
      ) : null}

      {portalTab === 'operations' && operationsSubpage === 'profile' ? (
      <div className="employee-portal-grid employee-portal-grid-profile">
        {operationsSubpage === 'profile' ? (
          <article className="employee-card">
            <h2>Profile Information For Managers</h2>
            <label>
              Helpful Information
              <textarea
                rows={4}
                placeholder="Add context managers should know (skills, preferences, certifications, constraints, etc.)"
                value={helpfulInfoDraft}
                onChange={(event) => setHelpfulInfoDraft(event.target.value)}
              />
            </label>
            <div className="employee-task-ack-row">
              <button type="button" onClick={() => void saveHelpfulInfo()} disabled={busy}>
                Save Profile Info
              </button>
            </div>
          </article>
        ) : null}

        {showPreferences ? (
          <article className="employee-card">
            <h2>Work Preferences</h2>
            <label>
              Max Weekly Hours
              <input
                type="number"
                min={1}
                max={80}
                value={maxWeeklyHoursDraft}
                onChange={(event) => setMaxWeeklyHoursDraft(event.target.value)}
                placeholder="Optional"
              />
            </label>
            <label>
              Availability Notes
              <textarea
                rows={3}
                value={availabilityNotesDraft}
                onChange={(event) => setAvailabilityNotesDraft(event.target.value)}
                placeholder="Preferred days/times, restrictions, etc."
              />
            </label>
            <div className="employee-preferences-grid">
              {data.workAreas.map((area) => (
                <label key={area.id} className="employee-pref-checkbox">
                  <input
                    type="checkbox"
                    checked={preferredAreaIdsDraft.includes(area.id)}
                    onChange={(event) => togglePreferredArea(area.id, event.target.checked)}
                  />
                  {area.name}
                </label>
              ))}
            </div>
            <div className="employee-task-ack-row">
              <button type="button" onClick={() => void saveWorkPreferences()} disabled={busy}>
                Save Work Preferences
              </button>
            </div>
          </article>
        ) : null}

      </div>
      ) : null}

      {portalTab === 'operations' && operationsSubpage === 'home' ? (
        <div className="employee-portal-grid employee-home-grid">
          <div className="employee-home-column">
          {showShifts ? (
          <article className="employee-card">
            <div className="employee-section-head">
              <h2>{`My Shifts (${dateValue})`}</h2>
              <span>{sortedDayShifts.length} scheduled</span>
            </div>
            {sortedDayShifts.length === 0 ? (
              <div className="employee-empty-panel">
                <strong>
                  {selectedDateApprovedTimeOff
                    ? `Authorized time off (${statusLabel(selectedDateApprovedTimeOff.requestType)})`
                    : 'No shift scheduled for this date'}
                </strong>
                <span>
                  {selectedDateApprovedTimeOff
                    ? `${selectedDateApprovedTimeOff.startDate} → ${selectedDateApprovedTimeOff.endDate}`
                    : nextUpcomingShift
                      ? `Next shift: ${toReadableDate(nextUpcomingShift.start_at)}`
                      : 'Nothing else on the schedule.'}
                </span>
              </div>
            ) : (
              <ul>
                {sortedDayShifts.map((shift) => {
                  const areaName = resolveAreaName(shift.work_area_id, workAreaById);
                  const isClockedIn = Boolean(shift.clocked_in_at);
                  const isClockedOut = Boolean(shift.clocked_out_at);
                  const unpaidEarlyMinutes = computeUnpaidEarlyInMinutes(shift);
                  return (
                    <li key={shift.id}>
                      <div className="employee-row-head">
                        <strong>
                          {shift.is_unscheduled_overtime
                            ? `${areaName} (Unscheduled OT ${shift.pay_multiplier.toFixed(1)}x)`
                            : shift.pay_multiplier > 1
                              ? `${areaName} (OT ${shift.pay_multiplier.toFixed(1)}x)`
                              : areaName}
                        </strong>
                        <span className="employee-badge neutral">{statusLabel(shift.status)}</span>
                      </div>
                      <span>{toReadableDate(shift.start_at)} - {toReadableDate(shift.end_at)}</span>
                      <span>Clock-In: {isClockedIn ? toReadableDate(shift.clocked_in_at!) : 'Not clocked in'}</span>
                      <span>Clock-Out: {isClockedOut ? toReadableDate(shift.clocked_out_at!) : 'Not clocked out'}</span>
                      {unpaidEarlyMinutes > 0 ? (
                        <span className="employee-badge warn">EARLY-IN unpaid: {unpaidEarlyMinutes}m</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
          ) : null}

          {showTasks ? (
          <article className="employee-card">
            <div className="employee-section-head">
              <h2>{ui.submenu_tasks}</h2>
              <span>{pendingTaskCount} pending acknowledgment</span>
            </div>
            {sortedTaskAssignments.length === 0 ? (
              <p className="empty-state">You're all caught up — no tasks assigned for this date.</p>
            ) : (
              <ul className="employee-task-list-simple">
                {sortedTaskAssignments.map((assignment) => {
                  const task = assignment.task;
                  const areaName = resolveAreaName(task.work_area_id, workAreaById);
                  const timeRange = `${toReadableTime(task.start_at)} – ${toReadableTime(task.end_at)}`;
                  const heading = task.title?.trim() || 'Task';
                  const description = (task.description ?? '').trim();
                  const showDescription = description.length > 0 && description.length <= 160;
                  return (
                    <li key={assignment.id} className={assignment.acknowledged_at ? 'acknowledged' : ''}>
                      <div className="employee-row-head">
                        <strong>{heading}</strong>
                        <span className={assignment.acknowledged_at ? 'employee-badge success' : 'employee-badge warn'}>
                          {assignment.acknowledged_at ? 'Acknowledged' : 'Acknowledge'}
                        </span>
                      </div>
                      <div className="employee-task-meta">
                        <span className="employee-task-when">{timeRange}</span>
                        <span className="employee-task-where">{areaName}</span>
                      </div>
                      {showDescription ? <p className="employee-task-detail">{description}</p> : null}
                      {!assignment.acknowledged_at ? (
                        <div className="employee-task-ack-row">
                          <input
                            placeholder="Note (optional)"
                            value={ackNotes[assignment.id] ?? ''}
                            onChange={(event) => {
                              setAckNotes((current) => ({
                                ...current,
                                [assignment.id]: event.target.value
                              }));
                            }}
                          />
                          <button type="button" onClick={() => void acknowledge(assignment.id)} disabled={busy}>
                            Acknowledge
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
          ) : null}

          {showShiftPool ? (
            <article className="employee-card employee-card-wide">
            <div className="employee-section-head">
              <h2>{ui.submenu_pool}</h2>
              <span>{availablePoolShifts.length} available shift(s)</span>
            </div>
            {availablePoolShifts.length === 0 ? (
              <p className="empty-state">No shifts currently in the pool.</p>
            ) : (
              <ul>
                {availablePoolShifts.map((shift) => {
                  const areaName = resolveAreaName(shift.work_area_id, workAreaById);
                  const ownShift = shift.employee_id === data.profile.id;
                  return (
                    <li key={shift.id}>
                      <div className="employee-row-head">
                        <strong>{toReadableDate(shift.start_at)} - {toReadableDate(shift.end_at)}</strong>
                        <span className="employee-badge warn">OPEN SHIFT</span>
                      </div>
                      <div className="employee-meta-row">
                        <span className="employee-badge neutral">Area: {areaName}</span>
                        <span className="employee-badge neutral">Break: {shift.break_minutes}m</span>
                      </div>
                      <span>{shift.notes?.trim() ? shift.notes : 'No notes provided.'}</span>
                      <div className="employee-task-ack-row">
                        <button
                          type="button"
                          onClick={() => void claimShift(shift.id)}
                          disabled={busy || ownShift}
                        >
                          {ownShift ? 'Already Assigned To You' : 'Pick Up Shift'}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            </article>
          ) : null}
          </div>

          <div className="employee-home-column">
          {showAlerts || showMessages ? (
            <article className="employee-card employee-inbox-card">
              <div className="employee-section-head">
                <h2>Inbox</h2>
                <span>{unreadNotificationCount + unreadMessageCount} unread</span>
              </div>

              {showAlerts ? (
                <section className="employee-inbox-section">
                  <h3>{ui.submenu_alerts}</h3>
                  {data.notifications.length === 0 ? (
                    <p className="empty-state">No alerts yet.</p>
                  ) : (
                    <ul className="employee-message-list">
                      {data.notifications.slice(0, 5).map((entry) => (
                        <li key={entry.id} className={entry.read_at ? 'employee-message-row' : 'employee-message-row unread'}>
                          <strong>{entry.title}</strong>
                          <span>{entry.body || 'No details'}</span>
                          <span>{new Date(entry.created_at).toLocaleString()}</span>
                          {!entry.read_at ? (
                            <div className="employee-task-ack-row">
                              <button type="button" onClick={() => void markNotificationRead(entry.id)} disabled={busy}>
                                Mark Read
                              </button>
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}

              {showMessages ? (
                <section className="employee-inbox-section">
                  <h3>{ui.submenu_messages}</h3>
                  {data.messages.length === 0 ? (
                    <p className="empty-state">No messages yet.</p>
                  ) : (
                    <ul className="employee-message-list">
                      {data.messages.slice(0, 5).map((entry) => {
                        const sender = entry.sender_id === data.profile.id
                          ? 'You'
                          : (data.adminContacts.find((admin) => admin.id === entry.sender_id)?.full_name || 'Leadership');
                        const isUnread = entry.recipient_id === data.profile.id && !entry.read_at;
                        return (
                          <li key={entry.id} className={isUnread ? 'employee-message-row unread' : 'employee-message-row'}>
                            <strong>{entry.subject?.trim() || 'No Subject'}</strong>
                            <span>From: {sender}</span>
                            <span>{entry.message}</span>
                            <span>{new Date(entry.created_at).toLocaleString()} | {entry.read_at ? 'Read' : 'Unread'}</span>
                            {isUnread ? (
                              <div className="employee-task-ack-row">
                                <button type="button" onClick={() => void markAsRead(entry.id)} disabled={busy}>
                                  Mark Read
                                </button>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <details className="employee-inline-details">
                    <summary>Message leadership</summary>
                    <form className="employee-request-form" onSubmit={sendMessageToAdmin}>
                      <label>
                        Send To Leadership
                        <select value={messageRecipientId} onChange={(event) => setMessageRecipientId(event.target.value)} required>
                          {data.adminContacts.map((admin) => (
                            <option key={admin.id} value={admin.id}>{admin.full_name || admin.email}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Subject
                        <input value={messageSubject} onChange={(event) => setMessageSubject(event.target.value)} placeholder="Optional" />
                      </label>
                      <label className="full-width">
                        Message
                        <textarea
                          rows={3}
                          value={messageBody}
                          onChange={(event) => setMessageBody(event.target.value)}
                          required
                        />
                      </label>
                      <button type="submit" disabled={busy || !messageRecipientId || !messageBody.trim()}>
                        Send Message
                      </button>
                    </form>
                  </details>
                </section>
              ) : null}
            </article>
          ) : null}

          {showTraining ? (
            <article className="employee-card">
              <div className="employee-section-head">
                <h2>{ui.tab_training}</h2>
                <span>{pendingTrainingCount} pending</span>
              </div>
              {pendingTrainings.length === 0 ? (
                <p className="empty-state">All assigned training is complete.</p>
              ) : (
                <ul className="employee-task-list-simple">
                  {pendingTrainings.slice(0, 3).map((assignment) => (
                    <li key={assignment.id}>
                      <div className="employee-row-head">
                        <strong>{assignment.course?.title || 'Training'}</strong>
                        <span className="employee-badge warn">{statusLabel(assignment.status)}</span>
                      </div>
                      <span>
                        {assignment.due_at ? `Due ${new Date(assignment.due_at).toLocaleDateString()}` : 'No due date'}
                        {' · '}
                        {assignment.course?.estimated_minutes ?? 0} min
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="employee-task-ack-row">
                <button type="button" onClick={() => setPortalTab('training')}>Open training</button>
              </div>
            </article>
          ) : null}
          </div>
        </div>
      ) : portalTab === 'scheduling' ? (
        <div className="employee-portal-grid employee-portal-grid-scheduling employee-portal-grid-single">
          {schedulingSubpage === 'calendar' ? (
          <article className="employee-card employee-card-wide">
            <h2>Monthly Schedule ({monthTitle})</h2>
            <div className="schedule-legend">
              <span className="legend-chip code-ato">ATO</span>
              <span className="legend-chip code-vaut">VAUT</span>
              <span className="legend-chip code-ncns">NCNS</span>
              <span className="legend-chip code-ltdr">LTDR</span>
              <span className="legend-chip code-do">DO</span>
            </div>
            <h3>Assigned Voluntary Overtime</h3>
            {pendingAssignedVoluntaryOvertime.length === 0 ? (
              <p className="empty-state">No assigned voluntary overtime requests pending your response.</p>
            ) : (
              <ul>
                {pendingAssignedVoluntaryOvertime.map((request) => (
                  <li key={request.id}>
                    <strong>{toReadableDate(request.start_at)} - {toReadableDate(request.end_at)}</strong>
                    <span>Status: Pending your response</span>
                    {request.note?.trim() ? <span>Note: {request.note}</span> : null}
                    <div className="employee-task-ack-row">
                      <button type="button" onClick={() => void respondToAssignedOvertime(request.id, true)} disabled={busy}>
                        Accept
                      </button>
                      <button type="button" onClick={() => void respondToAssignedOvertime(request.id, false)} disabled={busy}>
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="schedule-calendar">
              {WEEKDAY_HEADERS.map((weekday) => (
                <div key={weekday} className="calendar-weekday">{weekday}</div>
              ))}

              {monthGrid.map((cell) => {
                const shifts = shiftsByDate.get(cell.key) ?? [];
                const code = scheduleCodeByDate.get(cell.key) ?? (shifts.length === 0 ? 'DO' : null);
                const isToday = cell.key === todayKey;
                const isSelected = cell.key === dateValue;

                return (
                  <button
                    type="button"
                    key={cell.key}
                    className={`calendar-cell ${cell.inMonth ? '' : 'outside'} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`.trim()}
                    onClick={() => onDateChange(cell.key)}
                  >
                    <div className="calendar-cell-head">
                      <span>{cell.dayNumber}</span>
                      {code ? <span className={`code-pill code-${code.toLowerCase()}`}>{code}</span> : null}
                    </div>

                    {shifts.length > 0 ? (
                      <div className="calendar-shifts">
                        {shifts.slice(0, 2).map((shift) => {
                          const areaName = resolveAreaName(shift.work_area_id, workAreaById);
                          const unpaidEarlyMinutes = computeUnpaidEarlyInMinutes(shift);
                          return (
                            <div key={shift.id} className="calendar-shift-row">
                              <strong>{shortClock(shift.start_at)}-{shortClock(shift.end_at)}</strong>
                              <span>
                                {areaName}
                                {shift.pay_multiplier > 1 ? ` (OT ${shift.pay_multiplier.toFixed(1)}x)` : ''}
                              </span>
                              {unpaidEarlyMinutes > 0 ? <small>EARLY-IN unpaid {unpaidEarlyMinutes}m</small> : null}
                            </div>
                          );
                        })}
                        {shifts.length > 2 ? <small>+{shifts.length - 2} more</small> : null}
                      </div>
                    ) : (
                      <div className="calendar-dayoff-note">
                        {code === 'ATO' ? 'Authorized time off' : code && code !== 'DO' ? `Code: ${code}` : 'No shift'}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </article>
          ) : null}

          {schedulingSubpage === 'requests' && showOvertime ? (
          <details className="employee-request-section">
            <summary>{ui.submenu_overtime}</summary>
          <article className="employee-card">
            <h2>Request Same-Day Overtime</h2>
            {dayShiftEnvelope ? (
              <p className="empty-state">Shift envelope: {dayShiftEnvelope.firstStart}-{dayShiftEnvelope.lastEnd}</p>
            ) : (
              <p className="empty-state">No shifts scheduled for this date.</p>
            )}

            <form className="employee-request-form" onSubmit={submitOvertimeRequest}>
              <label>
                Direction
                <select
                  value={overtimeDirection}
                  onChange={(event) => setOvertimeDirection(event.target.value as 'before' | 'after')}
                >
                  <option value="before">Before first shift</option>
                  <option value="after">After last shift</option>
                </select>
              </label>
              <label>
                Start
                <input type="time" value={overtimeStart} onChange={(event) => setOvertimeStart(event.target.value)} required />
              </label>
              <label>
                End
                <input type="time" value={overtimeEnd} onChange={(event) => setOvertimeEnd(event.target.value)} required />
              </label>
              <label className="full-width">
                Note
                <textarea
                  rows={2}
                  value={overtimeNote}
                  onChange={(event) => setOvertimeNote(event.target.value)}
                  placeholder="Optional"
                />
              </label>
              <button type="submit" disabled={busy || !dayShiftEnvelope}>Submit OT Request</button>
            </form>

            <h3>Recent Overtime Requests</h3>
            {data.overtimeRequests.length === 0 ? (
              <p className="empty-state">No overtime requests yet.</p>
            ) : (
              <ul>
                {data.overtimeRequests.slice(0, 15).map((request) => (
                  <li key={request.id}>
                    <strong>{toReadableDate(request.start_at)} - {toReadableDate(request.end_at)}</strong>
                    <span>Status: {statusLabel(request.status)}</span>
                    <span>Type: {statusLabel(request.overtime_type)}</span>
                    {request.assigned_by ? <span>Assigned by admin</span> : <span>Self requested</span>}
                    {request.note?.trim() ? <span>Note: {request.note}</span> : null}
                    {request.review_notes?.trim() ? <span>Review: {request.review_notes}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </article>
          </details>
          ) : null}

          {schedulingSubpage === 'requests' && showSwaps ? (
          <details className="employee-request-section">
            <summary>{ui.submenu_swap}</summary>
          <article className="employee-card">
            <h2>Shift Swap Marketplace</h2>
            <form className="employee-request-form" onSubmit={createSwapRequest}>
              <label>
                My Shift
                <select value={swapShiftId} onChange={(event) => setSwapShiftId(event.target.value)} required>
                  {employeeShiftOptions.length === 0 ? <option value="">No eligible shifts</option> : null}
                  {employeeShiftOptions.map((shift) => (
                    <option key={shift.id} value={shift.id}>
                      {toReadableDate(shift.start_at)} - {toReadableDate(shift.end_at)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Target Employee ID (optional)
                <input
                  value={swapRequestedEmployeeId}
                  onChange={(event) => setSwapRequestedEmployeeId(event.target.value)}
                  placeholder="Leave blank for open marketplace"
                />
              </label>
              <label className="full-width">
                Note
                <textarea
                  rows={2}
                  value={swapRequestNote}
                  onChange={(event) => setSwapRequestNote(event.target.value)}
                  placeholder="Reason/context for the swap."
                />
              </label>
              <button type="submit" disabled={busy || employeeShiftOptions.length === 0}>Post Swap Request</button>
            </form>

            <h3>Open Marketplace Requests</h3>
            {openSwapRequests.length === 0 ? (
              <p className="empty-state">No open shift swap requests.</p>
            ) : (
              <ul>
                {openSwapRequests.slice(0, 20).map((request) => {
                  const shift = shiftById.get(request.shift_id);
                  const isMine = request.requester_id === data.profile.id;
                  return (
                    <li key={request.id}>
                      <strong>
                        {shift
                          ? `${toReadableDate(shift.start_at)} - ${toReadableDate(shift.end_at)}`
                          : `Shift ${request.shift_id}`}
                      </strong>
                      <span>Status: {statusLabel(request.status)}</span>
                      {request.request_note?.trim() ? <span>Request note: {request.request_note}</span> : null}
                      {!isMine ? (
                        <div className="employee-task-ack-row">
                          <input
                            placeholder="Acceptance note (optional)"
                            value={swapAcceptanceNotes[request.id] ?? ''}
                            onChange={(event) => {
                              setSwapAcceptanceNotes((current) => ({
                                ...current,
                                [request.id]: event.target.value
                              }));
                            }}
                          />
                          <button type="button" onClick={() => void acceptSwapRequest(request.id)} disabled={busy}>
                            Accept Swap
                          </button>
                        </div>
                      ) : (
                        <span>You submitted this request.</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <h3>My Swap Requests</h3>
            {mySwapRequests.length === 0 ? (
              <p className="empty-state">No swap requests created or accepted yet.</p>
            ) : (
              <ul>
                {mySwapRequests.slice(0, 20).map((request) => {
                  const shift = shiftById.get(request.shift_id);
                  return (
                    <li key={`mine:${request.id}`}>
                      <strong>
                        {shift
                          ? `${toReadableDate(shift.start_at)} - ${toReadableDate(shift.end_at)}`
                          : `Shift ${request.shift_id}`}
                      </strong>
                      <span>Status: {statusLabel(request.status)}</span>
                      {request.request_note?.trim() ? <span>Request note: {request.request_note}</span> : null}
                      {request.acceptance_note?.trim() ? <span>Acceptance note: {request.acceptance_note}</span> : null}
                      {request.review_note?.trim() ? <span>Review note: {request.review_note}</span> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
          </details>
          ) : null}

          {schedulingSubpage === 'requests' && showTimeOff ? (
          <details className="employee-request-section" open>
            <summary>{ui.submenu_timeoff}</summary>
          <article className="employee-card">
            <h2>Request Time Off</h2>
            <form className="employee-request-form" onSubmit={submitTimeOff}>
              <label>
                Start Date
                <input type="date" value={requestStart} onChange={(event) => setRequestStart(event.target.value)} required />
              </label>
              <label>
                End Date
                <input type="date" value={requestEnd} onChange={(event) => setRequestEnd(event.target.value)} required />
              </label>
              <label>
                Type
                <select value={requestType} onChange={(event) => setRequestType(event.target.value as TimeOffRequestType)}>
                  <option value="vacation">Vacation</option>
                  <option value="sick">Sick</option>
                  <option value="personal">Personal</option>
                  <option value="unpaid">Unpaid</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="full-width">
                Reason
                <textarea
                  rows={2}
                  value={requestReason}
                  onChange={(event) => setRequestReason(event.target.value)}
                />
              </label>
              <button type="button" disabled={busy || coveragePreviewBusy} onClick={() => void previewCoverageImpact()}>
                {coveragePreviewBusy ? 'Previewing...' : 'Preview Coverage Impact'}
              </button>
              <button type="submit" disabled={busy}>Submit Request</button>
            </form>

            <h3>Coverage Impact Preview</h3>
            {timeOffCoverageImpact.length === 0 ? (
              <p className="empty-state">Run preview to see staffing and task impact before submitting.</p>
            ) : (
              <ul>
                {timeOffCoverageImpact.map((row) => (
                  <li key={`impact:${row.day_date}`}>
                    <strong>{row.day_date}</strong>
                    <span>Risk: {statusLabel(row.risk_level)}</span>
                    <span>
                      Own shifts: {row.employee_shift_count} | Own tasks: {row.employee_task_count} | Open pool: {row.unassigned_pool_openings}
                    </span>
                    <span>
                      Areas impacted: {row.work_areas_impacted.length > 0 ? row.work_areas_impacted.join(', ') : 'None'}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <h3>Recent Time-Off Requests</h3>
            {data.timeOffRequests.length === 0 ? (
              <p className="empty-state">No time-off requests yet.</p>
            ) : (
              <ul>
                {data.timeOffRequests.slice(0, 15).map((request) => (
                  <li key={request.id}>
                    <strong>{request.start_date} - {request.end_date}</strong>
                    <span>{statusLabel(request.request_type)} | Status: {statusLabel(request.status)}</span>
                    <span>{request.reason || 'No reason provided.'}</span>
                    {request.review_notes ? <span>Review: {request.review_notes}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </article>
          </details>
          ) : null}

          {schedulingSubpage === 'requests' && showExceptions ? (
          <details className="employee-request-section">
            <summary>{ui.submenu_exceptions}</summary>
          <article className="employee-card">
            <h2>Submit Exception Request</h2>
            <form className="employee-request-form" onSubmit={submitException}>
              <label>
                Type
                <select value={exceptionType} onChange={(event) => setExceptionType(event.target.value as ExceptionRequestType)}>
                  <option value="absence">Absence</option>
                  <option value="task_completion">Task Completion</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                Code
                <select value={exceptionCode} onChange={(event) => setExceptionCode(event.target.value as ExceptionCode)}>
                  <option value="VAUT">VAUT</option>
                  <option value="NCNS">NCNS</option>
                  <option value="LTDR">LTDR</option>
                  <option value="DO">DO</option>
                </select>
              </label>
              <label>
                Start Date
                <input type="date" value={exceptionStartDate} onChange={(event) => setExceptionStartDate(event.target.value)} required />
              </label>
              <label>
                End Date
                <input type="date" value={exceptionEndDate} onChange={(event) => setExceptionEndDate(event.target.value)} required />
              </label>
              <label>
                Related Task
                <select value={exceptionRelatedTaskId} onChange={(event) => setExceptionRelatedTaskId(event.target.value)}>
                  <option value="">None</option>
                  {data.taskAssignments.map((assignment) => (
                    <option key={assignment.id} value={assignment.task.id}>{assignment.task.title}</option>
                  ))}
                </select>
              </label>
              <label>
                Related Shift
                <select value={exceptionRelatedShiftId} onChange={(event) => setExceptionRelatedShiftId(event.target.value)}>
                  <option value="">None</option>
                  {data.shifts.map((shift) => (
                    <option key={shift.id} value={shift.id}>
                      {toReadableDate(shift.start_at)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Title
                <input required value={exceptionTitle} onChange={(event) => setExceptionTitle(event.target.value)} />
              </label>
              <label className="full-width">
                Details
                <textarea
                  rows={2}
                  value={exceptionDetails}
                  onChange={(event) => setExceptionDetails(event.target.value)}
                />
              </label>
              <button type="submit" disabled={busy}>Submit Exception</button>
            </form>

            <h3>Recent Exception Requests</h3>
            {data.exceptionRequests.length === 0 ? (
              <p className="empty-state">No exception requests yet.</p>
            ) : (
              <ul>
                {data.exceptionRequests.slice(0, 15).map((request) => (
                  <li key={request.id}>
                    <strong>{request.exception_code} | {request.title}</strong>
                    <span>{request.start_date} - {request.end_date} | {statusLabel(request.exception_type)} | Status: {statusLabel(request.status)}</span>
                    <span>{request.details || 'No details provided.'}</span>
                    {request.review_notes ? <span>Review: {request.review_notes}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </article>
          </details>
          ) : null}
        </div>
      ) : portalTab === 'training' ? (
        <div className="employee-portal-grid employee-portal-grid-single">
          <article className="employee-card employee-card-wide">
            <div className="employee-section-head">
              <h2>My Trainings</h2>
              <span>{pendingTrainingCount} pending</span>
            </div>

            {sortedTrainingAssignments.length === 0 ? (
              <p className="empty-state">No trainings assigned yet.</p>
            ) : (
              <ul>
                {sortedTrainingAssignments.map((assignment) => {
                  const completed = assignment.status === 'completed';
                  const dueDate = assignment.due_at ? new Date(assignment.due_at).toLocaleDateString() : 'No due date';
                  return (
                    <li key={assignment.id} className={completed ? 'acknowledged' : ''}>
                      <div className="employee-row-head">
                        <strong>{assignment.course?.title || 'Training'}</strong>
                        <span className={completed ? 'employee-badge success' : 'employee-badge warn'}>
                          {completed ? 'Completed' : statusLabel(assignment.status)}
                        </span>
                      </div>
                      <span>{assignment.course?.description || 'No description provided.'}</span>
                      <span>Due: {dueDate}</span>
                      <span>Estimated Time: {assignment.course?.estimated_minutes ?? 0} minutes</span>
                      {assignment.course?.content?.trim() ? <pre className="training-content">{assignment.course.content}</pre> : null}
                      <span>
                        Assigned: {new Date(assignment.assigned_at).toLocaleString()}
                        {assignment.completed_at ? ` | Completed: ${new Date(assignment.completed_at).toLocaleString()}` : ''}
                      </span>
                      {!completed ? (
                        <div className="employee-task-ack-row">
                          <input
                            placeholder="Completion notes (optional)"
                            value={trainingNotes[assignment.id] ?? ''}
                            onChange={(event) => {
                              setTrainingNotes((current) => ({
                                ...current,
                                [assignment.id]: event.target.value
                              }));
                            }}
                          />
                          <button type="button" onClick={() => void completeTraining(assignment)} disabled={busy}>
                            Mark Complete
                          </button>
                        </div>
                      ) : assignment.completion_notes?.trim() ? (
                        <span>Notes: {assignment.completion_notes}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
        </div>
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="form-message">{message}</p> : null}
    </section>
  );
}
