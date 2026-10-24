import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  DisciplineActionRow,
  DisciplinePunishmentType,
  DisciplineSeverity,
  DisciplineStatus,
  ExceptionCode,
  ExceptionRequestRow,
  ExceptionRequestStatus,
  ExceptionRequestType,
  OvertimeRequestRow,
  OvertimeRequestStatus,
  OvertimeRequestType,
  ProfileRow,
  ShiftRow,
  ShiftIntelligenceSnapshot,
  ShiftSwapRequestRow,
  ShiftStatus,
  TaskRow,
  TimeOffRequestRow,
  TimeOffRequestType,
  TimeOffRequestStatus,
  WorkAreaRow
} from '../types';
import { toTimeHHMM } from '../lib/time';
import { DEFAULT_FEATURES } from '../lib/features';
import type { FeatureFlags } from '../lib/features';

type AdminSchedulingPortalProps = {
  employees: ProfileRow[];
  workAreas: WorkAreaRow[];
  shifts: ShiftRow[];
  monthShifts: ShiftRow[];
  tasks: TaskRow[];
  timeOffRequests: TimeOffRequestRow[];
  exceptionRequests: ExceptionRequestRow[];
  overtimeRequests: OvertimeRequestRow[];
  shiftSwapRequests: ShiftSwapRequestRow[];
  shiftIntelligence: ShiftIntelligenceSnapshot | null;
  disciplineActions: DisciplineActionRow[];
  organizationName: string;
  onboardingEmailSubjectTemplate: string;
  onboardingEmailBodyTemplate: string;
  selectedDate: string;
  actorId: string;
  defaultShiftBreakMinutes: number;
  enabledFeatures?: FeatureFlags;
  busy: boolean;
  onUpsertShift: (payload: {
    shiftId?: string;
    employeeId: string;
    workAreaId: string | null;
    startAt: string;
    endAt: string;
    status: ShiftStatus;
    breakMinutes: number;
    notes: string;
    actorId: string;
  }) => Promise<void>;
  onAutoAssignShifts: (payload: {
    dateValue: string;
    actorId: string;
    startTime: string;
    endTime: string;
    breakMinutes: number;
    notes: string;
    status: ShiftStatus;
    preferredWorkAreaId?: string | null;
  }) => Promise<number>;
  onAutoAssignMonthShifts: (payload: {
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
  }) => Promise<number>;
  onCreateShiftPoolMonth: (payload: {
    dateValue: string;
    actorId: string;
    startTime: string;
    endTime: string;
    breakMinutes: number;
    notes: string;
    status: ShiftStatus;
    workAreaId?: string | null;
    openingsPerDay: number;
  }) => Promise<number>;
  onDeleteMonthShiftsAndReset: (payload: { dateValue: string }) => Promise<number>;
  onDeleteShift: (shiftId: string) => Promise<void>;
  onSetShiftPool: (shiftId: string, enabled: boolean) => Promise<void>;
  onReviewTimeOff: (payload: {
    requestId: string;
    status: TimeOffRequestStatus;
    reviewNotes: string;
    reviewerId: string;
  }) => Promise<void>;
  onUpdateTimeOffRequest: (payload: {
    requestId: string;
    employeeId: string;
    startDate: string;
    endDate: string;
    requestType: TimeOffRequestType;
    reason: string;
    status: TimeOffRequestStatus;
    reviewNotes: string;
    reviewerId: string;
  }) => Promise<void>;
  onDeleteTimeOffRequest: (requestId: string) => Promise<void>;
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
  onReviewExceptionRequest: (payload: {
    requestId: string;
    status: ExceptionRequestStatus;
    reviewNotes: string;
    reviewerId: string;
  }) => Promise<void>;
  onUpdateExceptionRequest: (payload: {
    requestId: string;
    employeeId: string;
    exceptionType: ExceptionRequestType;
    exceptionCode: ExceptionCode;
    title: string;
    details: string;
    startDate: string;
    endDate: string;
    relatedShiftId?: string | null;
    relatedTaskId?: string | null;
    status: ExceptionRequestStatus;
    reviewNotes: string;
    reviewerId: string;
  }) => Promise<void>;
  onDeleteExceptionRequest: (requestId: string) => Promise<void>;
  onReviewOvertimeRequest: (payload: { requestId: string; status: OvertimeRequestStatus; reviewNotes: string }) => Promise<void>;
  onAssignOvertimeRequest: (payload: {
    employeeId: string;
    startAt: string;
    endAt: string;
    note: string;
    overtimeType: OvertimeRequestType;
  }) => Promise<unknown>;
  onReviewShiftSwapRequest: (payload: { requestId: string; approve: boolean; reviewNote: string }) => Promise<void>;
  onCreateDisciplineAction: (payload: {
    employeeId: string;
    title: string;
    details: string;
    severity: DisciplineSeverity;
    punishmentType: DisciplinePunishmentType;
    punishmentValue: number;
  }) => Promise<void>;
  onApplyDisciplineAction: (actionId: string, reviewNotes: string) => Promise<void>;
  onRevokeDisciplineAction: (actionId: string, reviewNotes: string) => Promise<void>;
  onUpdateDisciplineAction: (payload: {
    actionId: string;
    title: string;
    details: string;
    severity: DisciplineSeverity;
    punishmentType: DisciplinePunishmentType;
    punishmentValue: number;
    status: DisciplineStatus;
    reviewNotes: string;
    reviewerId: string;
  }) => Promise<void>;
  onUpdateEmployeePayRate: (employeeId: string, hourlyRate: number | null) => Promise<void>;
  onCreateEmployeeAccount: (payload: {
    email: string;
    password: string;
    fullName: string;
  }) => Promise<unknown>;
  onSendOnboardingEmail: (payload: {
    toEmail: string;
    employeeName: string;
    temporaryPassword: string;
    organizationName?: string;
    subjectTemplate?: string;
    bodyTemplate?: string;
    loginUrl?: string;
  }) => Promise<void>;
};

type CalendarCell = {
  key: string;
  dayNumber: number;
  inMonth: boolean;
};

type ScheduleCode = ExceptionCode | 'ATO';
type SchedulingSubpage = 'schedule' | 'operations' | 'requests' | 'payroll' | 'onboarding';
type ShiftTemplateInput = {
  id: string;
  startTime: string;
  endTime: string;
  headcount: string;
  breakMinutes: string;
};

const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CLOCK_IN_BUFFER_MINUTES = 5;

function toShiftRangeIso(dateValue: string, startTimeValue: string, endTimeValue: string): { startAt: string; endAt: string } {
  const [year, month, day] = dateValue.split('-').map(Number);
  const [startHour, startMinute] = startTimeValue.split(':').map(Number);
  const [endHour, endMinute] = endTimeValue.split(':').map(Number);

  const start = new Date(year, month - 1, day, startHour, startMinute, 0, 0);
  const end = new Date(year, month - 1, day, endHour, endMinute, 0, 0);

  if (end.getTime() <= start.getTime()) {
    end.setDate(end.getDate() + 1);
  }

  return {
    startAt: start.toISOString(),
    endAt: end.toISOString()
  };
}

function statusLabel(status: string): string {
  return status.replace('_', ' ').replace(/\b\w/g, (value) => value.toUpperCase());
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function dateToInput(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

function isoToDateKey(value: string): string {
  const date = new Date(value);
  return dateToInput(date);
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

function codePriority(code: ScheduleCode): number {
  if (code === 'NCNS') return 5;
  if (code === 'LTDR') return 4;
  if (code === 'ATO') return 3;
  if (code === 'VAUT') return 2;
  return 1;
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

function monthTitle(dateValue: string): string {
  const [year, month] = dateValue.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric'
  });
}

function shiftSummary(shift: ShiftRow, workAreaById: Map<string, WorkAreaRow>): string {
  const areaName = shift.work_area_id ? (workAreaById.get(shift.work_area_id)?.name ?? 'Unassigned') : 'Unassigned';
  return `${toTimeHHMM(shift.start_at)}-${toTimeHHMM(shift.end_at)} | ${areaName}`;
}

function computeUnpaidEarlyInMinutes(shift: ShiftRow): number {
  if (!shift.clocked_in_at || shift.is_unscheduled_overtime) return 0;

  const shiftStart = new Date(shift.start_at).getTime();
  const clockIn = new Date(shift.clocked_in_at).getTime();
  if (!Number.isFinite(shiftStart) || !Number.isFinite(clockIn)) return 0;

  const bufferStart = shiftStart - CLOCK_IN_BUFFER_MINUTES * 60 * 1000;
  if (clockIn >= bufferStart) return 0;

  return Math.max(0, Math.floor((shiftStart - clockIn) / 60000));
}

function toCurrency(amount: number): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function parseTimeOffType(value: string, fallback: TimeOffRequestType): TimeOffRequestType {
  const candidate = value.trim().toLowerCase();
  const allowed: TimeOffRequestType[] = ['vacation', 'sick', 'personal', 'unpaid', 'other'];
  return allowed.includes(candidate as TimeOffRequestType) ? (candidate as TimeOffRequestType) : fallback;
}

function parseTimeOffStatus(value: string, fallback: TimeOffRequestStatus): TimeOffRequestStatus {
  const candidate = value.trim().toLowerCase();
  const allowed: TimeOffRequestStatus[] = ['pending', 'approved', 'denied', 'cancelled'];
  return allowed.includes(candidate as TimeOffRequestStatus) ? (candidate as TimeOffRequestStatus) : fallback;
}

function parseExceptionType(value: string, fallback: ExceptionRequestType): ExceptionRequestType {
  const candidate = value.trim().toLowerCase();
  const allowed: ExceptionRequestType[] = ['absence', 'task_completion', 'other'];
  return allowed.includes(candidate as ExceptionRequestType) ? (candidate as ExceptionRequestType) : fallback;
}

function parseExceptionStatus(value: string, fallback: ExceptionRequestStatus): ExceptionRequestStatus {
  const candidate = value.trim().toLowerCase();
  const allowed: ExceptionRequestStatus[] = ['submitted', 'under_review', 'approved', 'denied', 'closed'];
  return allowed.includes(candidate as ExceptionRequestStatus) ? (candidate as ExceptionRequestStatus) : fallback;
}

function parseExceptionCode(value: string, fallback: ExceptionCode): ExceptionCode {
  const candidate = value.trim().toUpperCase();
  const allowed: ExceptionCode[] = ['VAUT', 'NCNS', 'LTDR', 'DO'];
  return allowed.includes(candidate as ExceptionCode) ? (candidate as ExceptionCode) : fallback;
}

function parseDisciplineSeverity(value: string, fallback: DisciplineSeverity): DisciplineSeverity {
  const candidate = value.trim().toLowerCase();
  const allowed: DisciplineSeverity[] = ['warning', 'serious', 'final'];
  return allowed.includes(candidate as DisciplineSeverity) ? (candidate as DisciplineSeverity) : fallback;
}

function parseDisciplinePunishmentType(value: string, fallback: DisciplinePunishmentType): DisciplinePunishmentType {
  const candidate = value.trim().toLowerCase();
  const allowed: DisciplinePunishmentType[] = ['none', 'pay_rate_reduction', 'unpaid_suspension', 'probation'];
  return allowed.includes(candidate as DisciplinePunishmentType) ? (candidate as DisciplinePunishmentType) : fallback;
}

function parseDisciplineStatus(value: string, fallback: DisciplineStatus): DisciplineStatus {
  const candidate = value.trim().toLowerCase();
  const allowed: DisciplineStatus[] = ['issued', 'applied', 'revoked'];
  return allowed.includes(candidate as DisciplineStatus) ? (candidate as DisciplineStatus) : fallback;
}

export function AdminSchedulingPortal({
  employees,
  workAreas,
  shifts,
  monthShifts,
  tasks,
  timeOffRequests,
  exceptionRequests,
  overtimeRequests,
  shiftSwapRequests,
  shiftIntelligence,
  disciplineActions,
  organizationName,
  onboardingEmailSubjectTemplate,
  onboardingEmailBodyTemplate,
  selectedDate,
  actorId,
  defaultShiftBreakMinutes,
  enabledFeatures = DEFAULT_FEATURES,
  busy,
  onUpsertShift,
  onAutoAssignShifts,
  onAutoAssignMonthShifts,
  onCreateShiftPoolMonth,
  onDeleteMonthShiftsAndReset,
  onDeleteShift,
  onSetShiftPool,
  onReviewTimeOff,
  onUpdateTimeOffRequest,
  onDeleteTimeOffRequest,
  onCreateExceptionRequest,
  onReviewExceptionRequest,
  onUpdateExceptionRequest,
  onDeleteExceptionRequest,
  onReviewOvertimeRequest,
  onAssignOvertimeRequest,
  onReviewShiftSwapRequest,
  onCreateDisciplineAction,
  onApplyDisciplineAction,
  onRevokeDisciplineAction,
  onUpdateDisciplineAction,
  onUpdateEmployeePayRate,
  onCreateEmployeeAccount,
  onSendOnboardingEmail,
}: AdminSchedulingPortalProps) {
  const [employeeId, setEmployeeId] = useState<string>(employees[0]?.id ?? '');
  const [shiftDate, setShiftDate] = useState(selectedDate);
  const [selectedDayShiftId, setSelectedDayShiftId] = useState('');
  const [shiftFormMode, setShiftFormMode] = useState<'edit' | 'new'>('edit');

  const [workAreaId, setWorkAreaId] = useState<string>('');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('16:30');
  const [status, setStatus] = useState<ShiftStatus>('scheduled');
  const [breakMinutes, setBreakMinutes] = useState(String(Math.max(0, Math.floor(defaultShiftBreakMinutes))));
  const [notes, setNotes] = useState('');

  const [autoStartTime, setAutoStartTime] = useState('08:00');
  const [autoEndTime, setAutoEndTime] = useState('16:30');
  const [autoStatus, setAutoStatus] = useState<ShiftStatus>('scheduled');
  const [autoBreakMinutes, setAutoBreakMinutes] = useState(String(Math.max(0, Math.floor(defaultShiftBreakMinutes))));
  const [poolOpeningsPerDay, setPoolOpeningsPerDay] = useState('1');
  const [autoNotes, setAutoNotes] = useState('Auto-assigned by Scheduling admin');
  const [autoAreaId, setAutoAreaId] = useState<string>('');
  const [shiftTemplates, setShiftTemplates] = useState<ShiftTemplateInput[]>([
    {
      id: 'template_1',
      startTime: '06:00',
      endTime: '14:00',
      headcount: '3',
      breakMinutes: String(Math.max(0, Math.floor(defaultShiftBreakMinutes)))
    },
    {
      id: 'template_2',
      startTime: '10:00',
      endTime: '18:00',
      headcount: '5',
      breakMinutes: String(Math.max(0, Math.floor(defaultShiftBreakMinutes)))
    },
    {
      id: 'template_3',
      startTime: '14:00',
      endTime: '22:00',
      headcount: '3',
      breakMinutes: String(Math.max(0, Math.floor(defaultShiftBreakMinutes)))
    }
  ]);

  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [exceptionReviewNotes, setExceptionReviewNotes] = useState<Record<string, string>>({});
  const [overtimeReviewNotes, setOvertimeReviewNotes] = useState<Record<string, string>>({});
  const [assignOvertimeEmployeeId, setAssignOvertimeEmployeeId] = useState('');
  const [assignOvertimeType, setAssignOvertimeType] = useState<OvertimeRequestType>('voluntary');
  const [assignOvertimeDate, setAssignOvertimeDate] = useState(selectedDate);
  const [assignOvertimeStartTime, setAssignOvertimeStartTime] = useState('17:00');
  const [assignOvertimeEndTime, setAssignOvertimeEndTime] = useState('19:00');
  const [assignOvertimeNote, setAssignOvertimeNote] = useState('');
  const [swapReviewNotes, setSwapReviewNotes] = useState<Record<string, string>>({});
  const [disciplineReviewNotes, setDisciplineReviewNotes] = useState<Record<string, string>>({});

  const [exceptionEmployeeId, setExceptionEmployeeId] = useState<string>(employees[0]?.id ?? '');
  const [exceptionType, setExceptionType] = useState<ExceptionRequestType>('absence');
  const [exceptionCode, setExceptionCode] = useState<ExceptionCode>('VAUT');
  const [exceptionStartDate, setExceptionStartDate] = useState(selectedDate);
  const [exceptionEndDate, setExceptionEndDate] = useState(selectedDate);
  const [exceptionTitle, setExceptionTitle] = useState('');
  const [exceptionDetails, setExceptionDetails] = useState('');
  const [exceptionRelatedTaskId, setExceptionRelatedTaskId] = useState('');
  const [exceptionRelatedShiftId, setExceptionRelatedShiftId] = useState('');
  const [disciplineEmployeeId, setDisciplineEmployeeId] = useState<string>(employees[0]?.id ?? '');
  const [disciplineTitle, setDisciplineTitle] = useState('');
  const [disciplineDetails, setDisciplineDetails] = useState('');
  const [disciplineSeverity, setDisciplineSeverity] = useState<DisciplineSeverity>('warning');
  const [disciplinePunishmentType, setDisciplinePunishmentType] = useState<DisciplinePunishmentType>('none');
  const [disciplinePunishmentValue, setDisciplinePunishmentValue] = useState('0');

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payRateDrafts, setPayRateDrafts] = useState<Record<string, string>>({});
  const showSchedulePage = enabledFeatures.shifts !== false;
  const showOperationsPage = enabledFeatures.shifts !== false || enabledFeatures.tasks !== false;
  const showRequestsPage =
    enabledFeatures.time_off !== false ||
    enabledFeatures.exceptions !== false ||
    enabledFeatures.overtime !== false ||
    enabledFeatures.shift_swaps !== false;
  const showPayrollPage = enabledFeatures.payroll !== false;
  const showOnboardingPage = enabledFeatures.onboarding !== false;
  const availableSubpages: SchedulingSubpage[] = [
    ...(showSchedulePage ? ['schedule' as const] : []),
    ...(showOperationsPage ? ['operations' as const] : []),
    ...(showRequestsPage ? ['requests' as const] : []),
    ...(showPayrollPage ? ['payroll' as const] : []),
    ...(showOnboardingPage ? ['onboarding' as const] : [])
  ];
  const [activeSubpage, setActiveSubpage] = useState<SchedulingSubpage>(availableSubpages[0] ?? 'schedule');

  useEffect(() => {
    if (!availableSubpages.includes(activeSubpage)) {
      setActiveSubpage(availableSubpages[0] ?? 'operations');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSubpage, showSchedulePage, showOperationsPage, showRequestsPage, showPayrollPage, showOnboardingPage]);
  const [onboardingFullName, setOnboardingFullName] = useState('');
  const [onboardingEmail, setOnboardingEmail] = useState('');
  const [onboardingTempPassword, setOnboardingTempPassword] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);

  // Load feed config when modal opens (no longer used for airport selection; airport is from org settings)

  useEffect(() => {
    if (!employees.some((employee) => employee.id === employeeId)) {
      setEmployeeId(employees[0]?.id ?? '');
    }

    if (!employees.some((employee) => employee.id === exceptionEmployeeId)) {
      setExceptionEmployeeId(employees[0]?.id ?? '');
    }

    if (!employees.some((employee) => employee.id === disciplineEmployeeId)) {
      setDisciplineEmployeeId(employees[0]?.id ?? '');
    }

  }, [employees, employeeId, exceptionEmployeeId, disciplineEmployeeId]);

  useEffect(() => {
    setExceptionStartDate(selectedDate);
    setExceptionEndDate(selectedDate);
    setShiftDate(selectedDate);
  }, [selectedDate]);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const employee of employees) {
      next[employee.id] = employee.hourly_rate == null ? '' : String(employee.hourly_rate);
    }
    setPayRateDrafts(next);
  }, [employees]);

  const employeeById = useMemo(() => {
    return new Map(employees.map((employee) => [employee.id, employee]));
  }, [employees]);

  const workAreaById = useMemo(() => {
    return new Map(workAreas.map((workArea) => [workArea.id, workArea]));
  }, [workAreas]);

  const calendarCells = useMemo(() => buildMonthGrid(selectedDate), [selectedDate]);

  const employeeMonthShifts = useMemo(() => {
    return monthShifts
      .filter((shift) => shift.employee_id === employeeId)
      .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
  }, [monthShifts, employeeId]);

  const employeeMonthShiftsByDate = useMemo(() => {
    const map = new Map<string, ShiftRow[]>();
    for (const shift of employeeMonthShifts) {
      const key = isoToDateKey(shift.start_at);
      const bucket = map.get(key) ?? [];
      bucket.push(shift);
      map.set(key, bucket);
    }
    return map;
  }, [employeeMonthShifts]);

  const selectedDayShifts = useMemo(() => {
    return employeeMonthShiftsByDate.get(shiftDate) ?? [];
  }, [employeeMonthShiftsByDate, shiftDate]);

  const scheduleCodeByDate = useMemo(() => {
    const map = new Map<string, ScheduleCode>();

    for (const request of exceptionRequests) {
      if (request.employee_id !== employeeId || request.status !== 'approved') continue;
      const keys = enumerateDateKeys(request.start_date, request.end_date);

      for (const key of keys) {
        const current = map.get(key);
        if (!current || codePriority(request.exception_code) > codePriority(current)) {
          map.set(key, request.exception_code);
        }
      }
    }

    for (const request of timeOffRequests) {
      if (request.employee_id !== employeeId || request.status !== 'approved') continue;
      const keys = enumerateDateKeys(request.start_date, request.end_date);

      for (const key of keys) {
        const current = map.get(key);
        if (!current || codePriority('ATO') > codePriority(current)) {
          map.set(key, 'ATO');
        }
      }
    }

    return map;
  }, [employeeId, exceptionRequests, timeOffRequests]);

  const selectedDayCode = useMemo(() => {
    return scheduleCodeByDate.get(shiftDate) ?? (selectedDayShifts.length === 0 ? 'DO' : null);
  }, [scheduleCodeByDate, shiftDate, selectedDayShifts.length]);

  const selectedDayShift = useMemo(() => {
    if (selectedDayShifts.length === 0) return null;
    return selectedDayShifts.find((shift) => shift.id === selectedDayShiftId) ?? selectedDayShifts[0];
  }, [selectedDayShifts, selectedDayShiftId]);
  const editableShift = shiftFormMode === 'edit' ? selectedDayShift : null;

  const exceptionEmployeeMonthShifts = useMemo(() => {
    return monthShifts
      .filter((shift) => shift.employee_id === exceptionEmployeeId)
      .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
  }, [monthShifts, exceptionEmployeeId]);

  useEffect(() => {
    if (selectedDayShifts.length === 0) {
      setSelectedDayShiftId('');
      setShiftFormMode('new');
      return;
    }

    if (!selectedDayShifts.some((shift) => shift.id === selectedDayShiftId)) {
      setSelectedDayShiftId(selectedDayShifts[0].id);
    }
  }, [selectedDayShifts, selectedDayShiftId]);

  useEffect(() => {
    if (editableShift) {
      setWorkAreaId(editableShift.work_area_id ?? '');
      setStartTime(toTimeHHMM(editableShift.start_at));
      setEndTime(toTimeHHMM(editableShift.end_at));
      setStatus(editableShift.status);
      setBreakMinutes(String(editableShift.break_minutes));
      setNotes(editableShift.notes);
      return;
    }

    setWorkAreaId('');
    setStartTime('08:00');
    setEndTime('16:30');
    setStatus('scheduled');
    setBreakMinutes(String(Math.max(0, Math.floor(defaultShiftBreakMinutes))));
    setNotes('');
  }, [editableShift, defaultShiftBreakMinutes]);

  useEffect(() => {
    setAutoBreakMinutes(String(Math.max(0, Math.floor(defaultShiftBreakMinutes))));
  }, [defaultShiftBreakMinutes]);

  useEffect(() => {
    setShiftTemplates((current) =>
      current.map((template) => ({
        ...template,
        breakMinutes:
          template.breakMinutes.trim() === ''
            ? String(Math.max(0, Math.floor(defaultShiftBreakMinutes)))
            : template.breakMinutes
      }))
    );
  }, [defaultShiftBreakMinutes]);

  function updateShiftTemplate(
    templateId: string,
    field: keyof Omit<ShiftTemplateInput, 'id'>,
    value: string
  ) {
    setShiftTemplates((current) =>
      current.map((template) => (template.id === templateId ? { ...template, [field]: value } : template))
    );
  }

  function addShiftTemplate() {
    setShiftTemplates((current) => [
      ...current,
      {
        id: `template_${Date.now()}_${current.length + 1}`,
        startTime: autoStartTime,
        endTime: autoEndTime,
        headcount: '1',
        breakMinutes: autoBreakMinutes
      }
    ]);
  }

  function removeShiftTemplate(templateId: string) {
    setShiftTemplates((current) => {
      if (current.length <= 1) return current;
      return current.filter((template) => template.id !== templateId);
    });
  }

  async function submitShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (!employeeId) return;

    if (shiftFormMode === 'edit' && !selectedDayShift?.id) {
      setError('No shift selected to edit for this employee/date.');
      return;
    }

    try {
      const { startAt, endAt } = toShiftRangeIso(shiftDate, startTime, endTime);
      await onUpsertShift({
        shiftId: shiftFormMode === 'edit' ? selectedDayShift?.id : undefined,
        employeeId,
        workAreaId: workAreaId || null,
        startAt,
        endAt,
        status,
        breakMinutes: Number(breakMinutes) || 0,
        notes: notes.trim(),
        actorId
      });
      setMessage(shiftFormMode === 'edit' && selectedDayShift ? 'Shift updated in Scheduling.' : 'Shift assigned in Scheduling.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save shift.');
    }
  }

  async function submitAutoAssign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    try {
      const count = await onAutoAssignShifts({
        dateValue: selectedDate,
        actorId,
        startTime: autoStartTime,
        endTime: autoEndTime,
        breakMinutes: Number(autoBreakMinutes) || 0,
        notes: autoNotes.trim(),
        status: autoStatus,
        preferredWorkAreaId: autoAreaId || null
      });

      setMessage(count === 0 ? 'No auto-assignment needed. Everyone already has a shift.' : `Auto-assigned ${count} shift(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to auto-assign shifts.');
    }
  }

  async function submitAutoAssignMonth() {
    setMessage(null);
    setError(null);

    const normalizedTemplates = shiftTemplates
      .map((template) => ({
        startTime: template.startTime.trim(),
        endTime: template.endTime.trim(),
        headcount: Math.max(0, Math.floor(Number(template.headcount) || 0)),
        breakMinutes: Math.max(0, Math.floor(Number(template.breakMinutes) || 0))
      }))
      .filter((template) => template.startTime && template.endTime && template.headcount > 0);
    if (normalizedTemplates.length === 0) {
      setError('Add at least one valid shift timing template with headcount.');
      return;
    }

    try {
      const count = await onAutoAssignMonthShifts({
        dateValue: selectedDate,
        actorId,
        startTime: autoStartTime,
        endTime: autoEndTime,
        breakMinutes: Number(autoBreakMinutes) || 0,
        weeklyHoursTarget: 999,
        rdoDaysPerWeek: 0,
        notes: autoNotes.trim(),
        status: autoStatus,
        preferredWorkAreaId: autoAreaId || null,
        shiftTemplates: normalizedTemplates
      });

      setMessage(
        count === 0
          ? `No month auto-assignment needed for ${monthTitle(selectedDate)}.`
          : `Auto-assigned ${count} shift(s) for ${monthTitle(selectedDate)}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to auto-assign month shifts.');
    }
  }

  async function submitFillEntireMonth() {
    setMessage(null);
    setError(null);
    const normalizedTemplates = shiftTemplates
      .map((template) => ({
        startTime: template.startTime.trim(),
        endTime: template.endTime.trim(),
        headcount: Math.max(0, Math.floor(Number(template.headcount) || 0)),
        breakMinutes: Math.max(0, Math.floor(Number(template.breakMinutes) || 0))
      }))
      .filter((template) => template.startTime && template.endTime && template.headcount > 0);
    if (normalizedTemplates.length === 0) {
      setError('Add at least one valid shift timing template with headcount.');
      return;
    }

    try {
      const count = await onAutoAssignMonthShifts({
        dateValue: selectedDate,
        actorId,
        startTime: normalizedTemplates[0].startTime,
        endTime: normalizedTemplates[0].endTime,
        breakMinutes: normalizedTemplates[0].breakMinutes,
        weeklyHoursTarget: 999,
        rdoDaysPerWeek: 0,
        notes: `${autoNotes.trim()} | template fill`,
        status: autoStatus,
        preferredWorkAreaId: autoAreaId || null,
        shiftTemplates: normalizedTemplates
      });

      setMessage(
        count === 0
          ? `No month fill needed for ${monthTitle(selectedDate)}.`
          : `Filled ${monthTitle(selectedDate)} with ${count} shift(s).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fill month schedule.');
    }
  }

  async function deleteMonthAndReset() {
    setMessage(null);
    setError(null);
    const confirmed = window.confirm(
      `Delete all shifts (and linked shift tasks/assignments) for ${monthTitle(selectedDate)}?`
    );
    if (!confirmed) return;

    try {
      const deleted = await onDeleteMonthShiftsAndReset({ dateValue: selectedDate });
      setMessage(
        deleted === 0
          ? `No shifts found for ${monthTitle(selectedDate)}.`
          : `Deleted ${deleted} shift(s) and reset ${monthTitle(selectedDate)}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete month schedule.');
    }
  }

  async function reviewRequest(requestId: string, nextStatus: TimeOffRequestStatus) {
    setMessage(null);
    setError(null);

    try {
      await onReviewTimeOff({
        requestId,
        status: nextStatus,
        reviewNotes: reviewNotes[requestId] ?? '',
        reviewerId: actorId
      });
      setMessage(
        nextStatus === 'approved'
          ? 'Time-off request approved. Overlapping shifts were removed.'
          : `Time-off request ${nextStatus}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to review request.');
    }
  }

  async function reviewOvertime(requestId: string, nextStatus: OvertimeRequestStatus) {
    setMessage(null);
    setError(null);

    try {
      await onReviewOvertimeRequest({
        requestId,
        status: nextStatus,
        reviewNotes: overtimeReviewNotes[requestId] ?? ''
      });
      setMessage(`Overtime request ${nextStatus}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to review overtime request.');
    }
  }

  async function submitAssignOvertime(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (!assignOvertimeEmployeeId) {
      setError('Select an employee.');
      return;
    }

    const windowRange = toShiftRangeIso(assignOvertimeDate, assignOvertimeStartTime, assignOvertimeEndTime);
    if (new Date(windowRange.endAt).getTime() <= new Date(windowRange.startAt).getTime()) {
      setError('Overtime end time must be later than start time.');
      return;
    }

    try {
      await onAssignOvertimeRequest({
        employeeId: assignOvertimeEmployeeId,
        startAt: windowRange.startAt,
        endAt: windowRange.endAt,
        note: assignOvertimeNote.trim(),
        overtimeType: assignOvertimeType
      });
      setAssignOvertimeNote('');
      setMessage(
        assignOvertimeType === 'mandatory'
          ? 'Mandatory overtime assigned.'
          : 'Voluntary overtime request assigned.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign overtime.');
    }
  }

  async function reviewShiftSwap(requestId: string, approve: boolean) {
    setMessage(null);
    setError(null);

    try {
      await onReviewShiftSwapRequest({
        requestId,
        approve,
        reviewNote: swapReviewNotes[requestId] ?? ''
      });
      setMessage(approve ? 'Shift swap approved.' : 'Shift swap denied.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to review shift swap request.');
    }
  }

  async function submitShiftPoolMonth() {
    setMessage(null);
    setError(null);

    const openingsPerDay = Number(poolOpeningsPerDay);
    if (!Number.isFinite(openingsPerDay) || openingsPerDay < 1) {
      setError('Pool openings per day must be at least 1.');
      return;
    }

    try {
      const count = await onCreateShiftPoolMonth({
        dateValue: selectedDate,
        actorId,
        startTime: autoStartTime,
        endTime: autoEndTime,
        breakMinutes: Number(autoBreakMinutes) || 0,
        notes: autoNotes.trim(),
        status: 'scheduled',
        workAreaId: autoAreaId || null,
        openingsPerDay: Math.floor(openingsPerDay)
      });

      setMessage(
        count === 0
          ? `No additional shift pool openings needed for ${monthTitle(selectedDate)}.`
          : `Created ${count} shift pool opening(s) for ${monthTitle(selectedDate)}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create shift pool month.');
    }
  }

  async function removeShift(shiftId: string) {
    setMessage(null);
    setError(null);

    const confirmed = window.confirm('Delete this shift? All tasks linked to this shift will also be deleted.');
    if (!confirmed) return;

    try {
      await onDeleteShift(shiftId);
      setMessage('Shift deleted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete shift.');
    }
  }

  async function toggleShiftPool(shift: ShiftRow, enabled: boolean) {
    setMessage(null);
    setError(null);

    if (enabled && shift.employee_id) {
      const confirmed = window.confirm(
        'Posting to shift pool will unassign this employee from the shift so anyone can claim it. Continue?'
      );
      if (!confirmed) return;
    }

    try {
      await onSetShiftPool(shift.id, enabled);
      setMessage(enabled ? 'Shift posted to pool.' : 'Shift removed from pool.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update shift pool status.');
    }
  }

  async function submitException(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (!exceptionEmployeeId) return;

    try {
      await onCreateExceptionRequest({
        employeeId: exceptionEmployeeId,
        submittedBy: actorId,
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

  async function reviewException(requestId: string, nextStatus: ExceptionRequestStatus) {
    setMessage(null);
    setError(null);

    try {
      await onReviewExceptionRequest({
        requestId,
        status: nextStatus,
        reviewNotes: exceptionReviewNotes[requestId] ?? '',
        reviewerId: actorId
      });
      setMessage(`Exception request ${nextStatus}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to review exception request.');
    }
  }

  async function editTimeOffRequest(request: TimeOffRequestRow) {
    setMessage(null);
    setError(null);

    const nextStartDate = window.prompt('Start date (YYYY-MM-DD)', request.start_date);
    if (nextStartDate === null) return;
    const nextEndDate = window.prompt('End date (YYYY-MM-DD)', request.end_date);
    if (nextEndDate === null) return;
    const nextTypeRaw = window.prompt('Request type: vacation|sick|personal|unpaid|other', request.request_type);
    if (nextTypeRaw === null) return;
    const nextStatusRaw = window.prompt('Status: pending|approved|denied|cancelled', request.status);
    if (nextStatusRaw === null) return;
    const nextReason = window.prompt('Reason', request.reason ?? '');
    if (nextReason === null) return;
    const nextReviewNotes = window.prompt('Review notes', request.review_notes ?? '');
    if (nextReviewNotes === null) return;

    try {
      await onUpdateTimeOffRequest({
        requestId: request.id,
        employeeId: request.employee_id,
        startDate: nextStartDate.trim(),
        endDate: nextEndDate.trim(),
        requestType: parseTimeOffType(nextTypeRaw, request.request_type),
        reason: nextReason.trim(),
        status: parseTimeOffStatus(nextStatusRaw, request.status),
        reviewNotes: nextReviewNotes.trim(),
        reviewerId: actorId
      });
      setMessage('Time-off request updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update time-off request.');
    }
  }

  async function deleteTimeOffRequest(requestId: string) {
    setMessage(null);
    setError(null);
    const confirmed = window.confirm('Delete this time-off request?');
    if (!confirmed) return;

    try {
      await onDeleteTimeOffRequest(requestId);
      setMessage('Time-off request deleted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete time-off request.');
    }
  }

  async function editExceptionRequest(request: ExceptionRequestRow) {
    setMessage(null);
    setError(null);

    const nextTypeRaw = window.prompt('Exception type: absence|task_completion|other', request.exception_type);
    if (nextTypeRaw === null) return;
    const nextCodeRaw = window.prompt('Exception code: VAUT|NCNS|LTDR|DO', request.exception_code);
    if (nextCodeRaw === null) return;
    const nextStartDate = window.prompt('Start date (YYYY-MM-DD)', request.start_date);
    if (nextStartDate === null) return;
    const nextEndDate = window.prompt('End date (YYYY-MM-DD)', request.end_date);
    if (nextEndDate === null) return;
    const nextTitle = window.prompt('Title', request.title);
    if (nextTitle === null) return;
    const nextDetails = window.prompt('Details', request.details ?? '');
    if (nextDetails === null) return;
    const nextStatusRaw = window.prompt('Status: submitted|under_review|approved|denied|closed', request.status);
    if (nextStatusRaw === null) return;
    const nextReviewNotes = window.prompt('Review notes', request.review_notes ?? '');
    if (nextReviewNotes === null) return;

    try {
      await onUpdateExceptionRequest({
        requestId: request.id,
        employeeId: request.employee_id,
        exceptionType: parseExceptionType(nextTypeRaw, request.exception_type),
        exceptionCode: parseExceptionCode(nextCodeRaw, request.exception_code),
        title: nextTitle.trim(),
        details: nextDetails.trim(),
        startDate: nextStartDate.trim(),
        endDate: nextEndDate.trim(),
        relatedShiftId: request.related_shift_id,
        relatedTaskId: request.related_task_id,
        status: parseExceptionStatus(nextStatusRaw, request.status),
        reviewNotes: nextReviewNotes.trim(),
        reviewerId: actorId
      });
      setMessage('Exception request updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update exception request.');
    }
  }

  async function deleteExceptionRequest(requestId: string) {
    setMessage(null);
    setError(null);
    const confirmed = window.confirm('Delete this exception request?');
    if (!confirmed) return;

    try {
      await onDeleteExceptionRequest(requestId);
      setMessage('Exception request deleted.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete exception request.');
    }
  }

  async function submitDisciplineAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    if (!disciplineEmployeeId) return;
    const title = disciplineTitle.trim();
    if (!title) {
      setError('Write-up title is required.');
      return;
    }

    const punishmentValue = Number(disciplinePunishmentValue);
    if (!Number.isFinite(punishmentValue) || punishmentValue < 0) {
      setError('Punishment value must be 0 or greater.');
      return;
    }

    try {
      await onCreateDisciplineAction({
        employeeId: disciplineEmployeeId,
        title,
        details: disciplineDetails.trim(),
        severity: disciplineSeverity,
        punishmentType: disciplinePunishmentType,
        punishmentValue
      });
      setDisciplineTitle('');
      setDisciplineDetails('');
      setDisciplineSeverity('warning');
      setDisciplinePunishmentType('none');
      setDisciplinePunishmentValue('0');
      setMessage('Discipline action issued.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to issue discipline action.');
    }
  }

  async function applyDiscipline(actionId: string) {
    setMessage(null);
    setError(null);
    try {
      await onApplyDisciplineAction(actionId, disciplineReviewNotes[actionId] ?? '');
      setMessage('Discipline action applied.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply discipline action.');
    }
  }

  async function revokeDiscipline(actionId: string) {
    setMessage(null);
    setError(null);
    try {
      await onRevokeDisciplineAction(actionId, disciplineReviewNotes[actionId] ?? '');
      setMessage('Discipline action revoked.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke discipline action.');
    }
  }

  async function editDisciplineAction(action: DisciplineActionRow) {
    setMessage(null);
    setError(null);
    const nextTitle = window.prompt('Write-up title', action.title);
    if (nextTitle === null) return;
    const nextDetails = window.prompt('Details', action.details ?? '');
    if (nextDetails === null) return;
    const nextSeverityRaw = window.prompt('Severity: warning|serious|final', action.severity);
    if (nextSeverityRaw === null) return;
    const nextPunishmentTypeRaw = window.prompt(
      'Punishment: none|pay_rate_reduction|unpaid_suspension|probation',
      action.punishment_type
    );
    if (nextPunishmentTypeRaw === null) return;
    const nextPunishmentValueRaw = window.prompt('Punishment value (number)', String(action.punishment_value ?? 0));
    if (nextPunishmentValueRaw === null) return;
    const nextStatusRaw = window.prompt('Status: issued|applied|revoked', action.status);
    if (nextStatusRaw === null) return;
    const nextReviewNotes = window.prompt('Review notes', action.review_notes ?? '');
    if (nextReviewNotes === null) return;

    const punishmentValue = Number(nextPunishmentValueRaw);
    if (!Number.isFinite(punishmentValue) || punishmentValue < 0) {
      setError('Punishment value must be 0 or greater.');
      return;
    }

    try {
      await onUpdateDisciplineAction({
        actionId: action.id,
        title: nextTitle.trim(),
        details: nextDetails.trim(),
        severity: parseDisciplineSeverity(nextSeverityRaw, action.severity),
        punishmentType: parseDisciplinePunishmentType(nextPunishmentTypeRaw, action.punishment_type),
        punishmentValue,
        status: parseDisciplineStatus(nextStatusRaw, action.status),
        reviewNotes: nextReviewNotes.trim(),
        reviewerId: actorId
      });
      setMessage('Discipline action updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update discipline action.');
    }
  }

  const allTimeOffRequests = useMemo(() => {
    return [...timeOffRequests].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [timeOffRequests]);

  const allExceptionRequests = useMemo(() => {
    return [...exceptionRequests].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [exceptionRequests]);

  const allOvertimeRequests = useMemo(() => {
    return [...overtimeRequests].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [overtimeRequests]);

  useEffect(() => {
    if (employees.length === 0) {
      setAssignOvertimeEmployeeId('');
      return;
    }
    if (!employees.some((employee) => employee.id === assignOvertimeEmployeeId)) {
      setAssignOvertimeEmployeeId(employees[0].id);
    }
  }, [employees, assignOvertimeEmployeeId]);

  const allShiftSwapRequests = useMemo(() => {
    return [...shiftSwapRequests].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [shiftSwapRequests]);

  const allDisciplineActions = useMemo(() => {
    return [...disciplineActions].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [disciplineActions]);

  const payrollRows = useMemo(() => {
    return employees
      .map((employee) => {
        const employeeShifts = monthShifts.filter((shift) => shift.employee_id === employee.id);
        const workedMinutes = employeeShifts.reduce((total, shift) => total + (shift.worked_minutes ?? 0), 0);
        const hourlyRate = employee.hourly_rate ?? 0;
        const grossPay = employeeShifts.reduce((total, shift) => {
          const minutes = shift.worked_minutes ?? 0;
          const multiplier = Number.isFinite(shift.pay_multiplier) ? shift.pay_multiplier : 1;
          return total + (minutes / 60) * hourlyRate * multiplier;
        }, 0);
        return {
          employeeId: employee.id,
          employeeName: employee.full_name || employee.email,
          hourlyRate,
          workedMinutes,
          grossPay
        };
      })
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  }, [employees, monthShifts]);
  const totalWorkedHours = payrollRows.reduce((total, row) => total + row.workedMinutes / 60, 0);
  const totalGrossPay = payrollRows.reduce((total, row) => total + row.grossPay, 0);

  async function savePayRate(employeeId: string) {
    setMessage(null);
    setError(null);
    const raw = (payRateDrafts[employeeId] ?? '').trim();

    if (!raw) {
      try {
        await onUpdateEmployeePayRate(employeeId, null);
        setMessage('Employee pay rate cleared.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update pay rate.');
      }
      return;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError('Hourly rate must be a positive number.');
      return;
    }

    try {
      await onUpdateEmployeePayRate(employeeId, parsed);
      setMessage('Employee pay rate updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update pay rate.');
    }
  }


  function generateTempPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*';
    let password = '';
    for (let index = 0; index < 14; index += 1) {
      password += chars[Math.floor(Math.random() * chars.length)];
    }
    setOnboardingTempPassword(password);
  }

  async function submitOnboardingAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    const fullName = onboardingFullName.trim();
    const email = onboardingEmail.trim().toLowerCase();
    const tempPassword = onboardingTempPassword;

    if (!fullName) {
      setError('Full name is required.');
      return;
    }
    if (!email) {
      setError('Email is required.');
      return;
    }
    if (tempPassword.length < 8) {
      setError('Temporary password must be at least 8 characters.');
      return;
    }

    try {
      const result = await onCreateEmployeeAccount({
        email,
        password: tempPassword,
        fullName
      }) as { requiresEmailConfirmation?: boolean } | undefined;

      await onSendOnboardingEmail({
        toEmail: email,
        employeeName: fullName,
        temporaryPassword: tempPassword,
        organizationName,
        subjectTemplate: onboardingEmailSubjectTemplate,
        bodyTemplate: onboardingEmailBodyTemplate,
        loginUrl: window.location.origin
      });

      setMessage(
        result?.requiresEmailConfirmation
          ? `Account created and onboarding email sent to ${email}. Employee must confirm email before first sign-in.`
          : `Account created and onboarding email sent to ${email}.`
      );
      setOnboardingFullName('');
      setOnboardingEmail('');
      setOnboardingTempPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create employee account.');
    }
  }




  return (
    <section className="scheduling-admin-shell">
      <header className="scheduling-admin-topnav">
        {showSchedulePage ? (
          <button
            type="button"
            className={activeSubpage === 'schedule' ? 'active' : ''}
            onClick={() => setActiveSubpage('schedule')}
          >
            Schedule
          </button>
        ) : null}
        {showOperationsPage ? (
          <button
            type="button"
            className={activeSubpage === 'operations' ? 'active' : ''}
            onClick={() => setActiveSubpage('operations')}
          >
            Operations
          </button>
        ) : null}
        {showRequestsPage ? (
          <button
            type="button"
            className={activeSubpage === 'requests' ? 'active' : ''}
            onClick={() => setActiveSubpage('requests')}
          >
            Requests
          </button>
        ) : null}
        {showPayrollPage ? (
          <button
            type="button"
            className={activeSubpage === 'payroll' ? 'active' : ''}
            onClick={() => setActiveSubpage('payroll')}
          >
            Payroll
          </button>
        ) : null}
        {showOnboardingPage ? (
          <button
            type="button"
            className={activeSubpage === 'onboarding' ? 'active' : ''}
            onClick={() => setActiveSubpage('onboarding')}
          >
            Onboarding
          </button>
        ) : null}
        </header>

      <section className="scheduling-subpage-grid">
      {activeSubpage === 'schedule' ? (
      <>
      <article className="scheduling-admin-card">
        <h2>Shift Intelligence Snapshot</h2>
        {!shiftIntelligence ? (
          <p className="empty-state">Shift intelligence is unavailable. Run migration 049 and refresh.</p>
        ) : (
          <>
            <p className="empty-state">
              Generated: {shiftIntelligence.generated_at ? toTimeHHMM(shiftIntelligence.generated_at) : 'N/A'} |
              Fatigue Risks: {shiftIntelligence.fatigue_risk.length} |
              Staffing Gaps: {shiftIntelligence.staffing_gaps.length}
            </p>
            <div className="timeoff-admin-list">
              {shiftIntelligence.fatigue_risk.slice(0, 5).map((row) => (
                <div className="timeoff-admin-row" key={`fatigue-${row.employee_id}`}>
                  <div>
                    <strong>{row.employee_name}</strong>
                    <span>Fatigue Score: {row.fatigue_score.toFixed(1)}</span>
                    <span>Shifts (7d): {row.shifts_7d}</span>
                  </div>
                </div>
              ))}
              {shiftIntelligence.staffing_gaps.slice(0, 5).map((gap, index) => (
                <div className="timeoff-admin-row" key={`gap-${gap.day_date}-${gap.work_area_id}-${index}`}>
                  <div>
                    <strong>{gap.day_date} · {gap.work_area_name}</strong>
                    <span>Scheduled: {gap.scheduled_count} / Target: {gap.target_count}</span>
                    <span>Gap: {gap.gap_count}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </article>

      <article className="scheduling-admin-card schedule-card">
        <h2>Employee Monthly Schedule ({monthTitle(selectedDate)})</h2>
        <div className="admin-schedule-head">
          <label>
            Employee
            <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.full_name || employee.email}
                </option>
              ))}
            </select>
          </label>

          <label>
            Editing Date
            <input type="date" value={shiftDate} onChange={(event) => setShiftDate(event.target.value)} />
          </label>

          {selectedDayShifts.length > 1 ? (
            <label>
              Shift On Day
              <select value={selectedDayShift?.id ?? ''} onChange={(event) => setSelectedDayShiftId(event.target.value)}>
                {selectedDayShifts.map((shift) => (
                  <option key={shift.id} value={shift.id}>{shiftSummary(shift, workAreaById)}</option>
                ))}
              </select>
            </label>
          ) : (
            <p className="empty-state admin-schedule-note">
              {selectedDayShifts.length === 0
                ? `No shift on selected date (${selectedDayCode ?? 'DO'}).`
                : `Single shift on selected date${selectedDayCode ? ` (${selectedDayCode})` : ''}.`}
            </p>
          )}
        </div>

        <div className="schedule-legend">
          <span className="legend-chip code-ato">ATO</span>
          <span className="legend-chip code-vaut">VAUT</span>
          <span className="legend-chip code-ncns">NCNS</span>
          <span className="legend-chip code-ltdr">LTDR</span>
          <span className="legend-chip code-do">DO</span>
        </div>

        <div className="schedule-calendar">
          {WEEKDAY_HEADERS.map((weekday) => (
            <div key={weekday} className="calendar-weekday">{weekday}</div>
          ))}

          {calendarCells.map((cell) => {
            const dayShifts = employeeMonthShiftsByDate.get(cell.key) ?? [];
            const dayCode = scheduleCodeByDate.get(cell.key) ?? (dayShifts.length === 0 ? 'DO' : null);
            const isToday = cell.key === dateToInput(new Date());
            const isSelected = cell.key === shiftDate;

            return (
              <button
                type="button"
                key={cell.key}
                className={`calendar-cell ${cell.inMonth ? '' : 'outside'} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`.trim()}
                onClick={() => {
                  setShiftDate(cell.key);
                  setSelectedDayShiftId(dayShifts[0]?.id ?? '');
                }}
              >
                <div className="calendar-cell-head">
                  <span>{cell.dayNumber}</span>
                  {dayCode ? <span className={`code-pill code-${dayCode.toLowerCase()}`}>{dayCode}</span> : null}
                </div>

                {dayShifts.length > 0 ? (
                  <div className="calendar-shifts">
                    {dayShifts.slice(0, 2).map((shift) => {
                      const unpaidEarlyMinutes = computeUnpaidEarlyInMinutes(shift);
                      return (
                        <div key={shift.id} className="calendar-shift-row">
                          <strong>{toTimeHHMM(shift.start_at)}-{toTimeHHMM(shift.end_at)}</strong>
                          <span>{shift.work_area_id ? (workAreaById.get(shift.work_area_id)?.name ?? 'Unassigned') : 'Unassigned'}</span>
                          {shift.is_shift_pool ? <small>Shift Pool</small> : null}
                          {unpaidEarlyMinutes > 0 ? <small>EARLY-IN unpaid {unpaidEarlyMinutes}m</small> : null}
                        </div>
                      );
                    })}
                    {dayShifts.length > 2 ? <small>+{dayShifts.length - 2} more</small> : null}
                  </div>
                ) : (
                  <div className="calendar-dayoff-note">
                    {dayCode === 'ATO' ? 'Authorized time off' : dayCode && dayCode !== 'DO' ? `Code: ${dayCode}` : 'No shift'}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </article>

      <article className="scheduling-admin-card">
        <h2>Shifts For {selectedDate}</h2>
        <div className="scheduling-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Area</th>
                <th>Time</th>
                <th>Status</th>
                <th>Unpaid Early</th>
                <th>Pool</th>
                <th>Notes</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((shift) => {
                const unpaidEarlyMinutes = computeUnpaidEarlyInMinutes(shift);
                return (
                  <tr key={shift.id}>
                    <td>{shift.employee_id ? (employeeById.get(shift.employee_id)?.full_name ?? shift.employee_id) : '(Pool Opening)'}</td>
                    <td>{shift.work_area_id ? workAreaById.get(shift.work_area_id)?.name ?? 'Unassigned' : 'Unassigned'}</td>
                    <td>{toTimeHHMM(shift.start_at)} - {toTimeHHMM(shift.end_at)}</td>
                    <td>{statusLabel(shift.status)}</td>
                    <td>{unpaidEarlyMinutes > 0 ? `${unpaidEarlyMinutes}m` : '-'}</td>
                    <td>{shift.is_shift_pool ? 'Open' : 'No'}</td>
                    <td>{shift.notes || '-'}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => void toggleShiftPool(shift, !shift.is_shift_pool)}
                        disabled={busy}
                      >
                        {shift.is_shift_pool ? 'Remove Pool' : 'Post Pool'}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => void removeShift(shift.id)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </article>
      </>
      ) : null}

      {activeSubpage === 'operations' ? (
      <>
      <article className="scheduling-admin-card">
        <h2>Scheduling Admin Shift Assignment / Edit</h2>
        <form className="scheduling-admin-form" onSubmit={submitShift}>
          <label>
            Mode
            <select value={shiftFormMode} onChange={(event) => setShiftFormMode(event.target.value as 'edit' | 'new')}>
              <option value="edit">Edit existing shift</option>
              <option value="new">Create new shift</option>
            </select>
          </label>

          <label>
            Employee
            <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} required>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.full_name || employee.email}
                </option>
              ))}
            </select>
          </label>

          <label>
            Date
            <input type="date" value={shiftDate} onChange={(event) => setShiftDate(event.target.value)} required />
          </label>

          {shiftFormMode === 'edit' ? (
            <label>
              Shift To Edit
              <select value={selectedDayShift?.id ?? ''} onChange={(event) => setSelectedDayShiftId(event.target.value)} required>
                <option value="" disabled>
                  {selectedDayShifts.length === 0 ? 'No shifts on this date' : 'Select shift'}
                </option>
                {selectedDayShifts.map((shift) => (
                  <option key={shift.id} value={shift.id}>
                    {shiftSummary(shift, workAreaById)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label>
            Work Area
            <select value={workAreaId} onChange={(event) => setWorkAreaId(event.target.value)}>
              <option value="">Unassigned</option>
              {workAreas.map((workArea) => (
                <option key={workArea.id} value={workArea.id}>{workArea.name}</option>
              ))}
            </select>
          </label>

          <label>
            Start
            <input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} required />
          </label>

          <label>
            End
            <input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} required />
          </label>

          <label>
            Status
            <select value={status} onChange={(event) => setStatus(event.target.value as ShiftStatus)}>
              <option value="scheduled">Scheduled</option>
              <option value="on_duty">On Duty</option>
              <option value="break">Break</option>
              <option value="off_shift">Off Shift</option>
            </select>
          </label>

          <label>
            Break (minutes)
            <input type="number" min={0} value={breakMinutes} onChange={(event) => setBreakMinutes(event.target.value)} />
          </label>

          <label className="full-width">
            Notes
            <input value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>

          <button type="submit" disabled={busy || !employeeId || (shiftFormMode === 'edit' && !selectedDayShift?.id)}>
            {shiftFormMode === 'edit' ? 'Update Shift' : 'Assign Shift'}
          </button>
          <button
            type="button"
            disabled={busy || shiftFormMode !== 'edit' || !selectedDayShift?.id}
            onClick={() => {
              if (!selectedDayShift?.id) return;
              void toggleShiftPool(selectedDayShift, !selectedDayShift.is_shift_pool);
            }}
          >
            {selectedDayShift?.is_shift_pool ? 'Remove From Shift Pool' : 'Post To Shift Pool'}
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy || shiftFormMode !== 'edit' || !selectedDayShift?.id}
            onClick={() => {
              if (!selectedDayShift?.id) return;
              void removeShift(selectedDayShift.id);
            }}
          >
            Delete Shift
          </button>
        </form>
      </article>

      <article className="scheduling-admin-card">
        <h2>Auto Assign Missing Shifts ({selectedDate})</h2>
        <form className="scheduling-admin-form" onSubmit={submitAutoAssign}>
          <label>
            Default Area
            <select value={autoAreaId} onChange={(event) => setAutoAreaId(event.target.value)}>
              <option value="">Round-robin active areas</option>
              {workAreas.map((workArea) => (
                <option key={workArea.id} value={workArea.id}>{workArea.name}</option>
              ))}
            </select>
          </label>

          <label>
            Start
            <input type="time" value={autoStartTime} onChange={(event) => setAutoStartTime(event.target.value)} required />
          </label>

          <label>
            End
            <input type="time" value={autoEndTime} onChange={(event) => setAutoEndTime(event.target.value)} required />
          </label>

          <label>
            Status
            <select value={autoStatus} onChange={(event) => setAutoStatus(event.target.value as ShiftStatus)}>
              <option value="scheduled">Scheduled</option>
              <option value="on_duty">On Duty</option>
              <option value="break">Break</option>
              <option value="off_shift">Off Shift</option>
            </select>
          </label>

          <label>
            Break (minutes)
            <input type="number" min={0} value={autoBreakMinutes} onChange={(event) => setAutoBreakMinutes(event.target.value)} />
          </label>

          <label>
            Pool Openings / Day
            <input type="number" min={1} max={50} value={poolOpeningsPerDay} onChange={(event) => setPoolOpeningsPerDay(event.target.value)} />
          </label>

          <label className="full-width">
            Notes
            <input value={autoNotes} onChange={(event) => setAutoNotes(event.target.value)} />
          </label>

          <div className="full-width">
            <strong>Shift Timing Templates (Month)</strong>
            <div className="scheduling-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Start</th>
                    <th>End</th>
                    <th>Headcount</th>
                    <th>Break (minutes)</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {shiftTemplates.map((template) => (
                    <tr key={template.id}>
                      <td>
                        <input
                          type="time"
                          value={template.startTime}
                          onChange={(event) => updateShiftTemplate(template.id, 'startTime', event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="time"
                          value={template.endTime}
                          onChange={(event) => updateShiftTemplate(template.id, 'endTime', event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          max={200}
                          value={template.headcount}
                          onChange={(event) => updateShiftTemplate(template.id, 'headcount', event.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          value={template.breakMinutes}
                          onChange={(event) => updateShiftTemplate(template.id, 'breakMinutes', event.target.value)}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => removeShiftTemplate(template.id)}
                          disabled={busy || shiftTemplates.length <= 1}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" onClick={addShiftTemplate} disabled={busy}>
              Add Shift Timing
            </button>
          </div>

          <button type="submit" disabled={busy}>Auto Assign</button>
          <button type="button" onClick={() => void submitAutoAssignMonth()} disabled={busy}>
            Auto Assign Month
          </button>
          <button type="button" onClick={() => void submitFillEntireMonth()} disabled={busy}>
            Fill Entire Month
          </button>
          <button type="button" onClick={() => void submitShiftPoolMonth()} disabled={busy}>
            Create Shift Pool Month
          </button>
          <button type="button" className="danger" onClick={() => void deleteMonthAndReset()} disabled={busy}>
            Delete Month & Reset
          </button>
        </form>
      </article>
      </>
      ) : null}

      {activeSubpage === 'payroll' ? (
      <article className="scheduling-admin-card">
        <h2>Payroll Summary ({monthTitle(selectedDate)})</h2>
        <div className="scheduling-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Hourly Rate</th>
                <th>Worked Hours</th>
                <th>Gross Pay</th>
                <th>Save</th>
              </tr>
            </thead>
            <tbody>
              {payrollRows.map((row) => (
                <tr key={row.employeeId}>
                  <td>{row.employeeName}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={payRateDrafts[row.employeeId] ?? ''}
                      onChange={(event) => {
                        const value = event.target.value;
                        setPayRateDrafts((current) => ({ ...current, [row.employeeId]: value }));
                      }}
                    />
                  </td>
                  <td>{(row.workedMinutes / 60).toFixed(2)}</td>
                  <td>{toCurrency(row.grossPay)}</td>
                  <td>
                    <button type="button" onClick={() => void savePayRate(row.employeeId)} disabled={busy}>
                      Save Rate
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="empty-state">
          Total Worked Hours: {totalWorkedHours.toFixed(2)} | Estimated Gross Payroll: {toCurrency(totalGrossPay)}
        </p>
      </article>
      ) : null}

      {activeSubpage === 'onboarding' ? (
      <article className="scheduling-admin-card schedule-card">
        <h2>Employee Onboarding Account Provisioning</h2>
        <form className="scheduling-admin-form" onSubmit={submitOnboardingAccount}>
          <label>
            Full Name
            <input
              type="text"
              value={onboardingFullName}
              onChange={(event) => setOnboardingFullName(event.target.value)}
              placeholder="Jane Doe"
              required
            />
          </label>

          <label>
            Email
            <input
              type="email"
              value={onboardingEmail}
              onChange={(event) => setOnboardingEmail(event.target.value)}
              placeholder="employee@company.com"
              required
            />
          </label>

          <label>
            Temporary Password
            <input
              type="text"
              value={onboardingTempPassword}
              onChange={(event) => setOnboardingTempPassword(event.target.value)}
              placeholder="Generate or enter secure temporary password"
              required
              minLength={8}
            />
          </label>

          <button type="button" onClick={generateTempPassword} disabled={busy}>
            Generate Temp Password
          </button>
          <button type="submit" disabled={busy}>
            Create Employee Account
          </button>
        </form>

        <p className="empty-state">
          Flow: create account here, send employee their login email + temporary password, and have them complete first-login onboarding.
        </p>
      </article>
      ) : null}

      {activeSubpage === 'requests' ? (
      <>
      <article className="scheduling-admin-card">
        <h2>Exception Requests</h2>
        <form className="scheduling-admin-form" onSubmit={submitException}>
          <label>
            Employee
            <select value={exceptionEmployeeId} onChange={(event) => setExceptionEmployeeId(event.target.value)} required>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.full_name || employee.email}
                </option>
              ))}
            </select>
          </label>

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
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>{task.title}</option>
              ))}
            </select>
          </label>

          <label>
            Related Shift
            <select value={exceptionRelatedShiftId} onChange={(event) => setExceptionRelatedShiftId(event.target.value)}>
              <option value="">None</option>
              {exceptionEmployeeMonthShifts.map((shift) => (
                <option key={shift.id} value={shift.id}>
                  {isoToDateKey(shift.start_at)} {toTimeHHMM(shift.start_at)}-{toTimeHHMM(shift.end_at)}
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
            <input value={exceptionDetails} onChange={(event) => setExceptionDetails(event.target.value)} />
          </label>

          <button type="submit" disabled={busy || !exceptionEmployeeId}>Submit Exception</button>
        </form>

        {allExceptionRequests.length === 0 ? (
          <p className="empty-state">No exception requests.</p>
        ) : (
          <div className="timeoff-admin-list">
            {allExceptionRequests.map((request) => {
              const employee = employeeById.get(request.employee_id);
              const canReview = request.status === 'submitted' || request.status === 'under_review';
              return (
                <div className="timeoff-admin-row" key={request.id}>
                  <div>
                    <strong>{employee?.full_name || employee?.email || request.employee_id}</strong>
                    <span>{request.exception_code} | {statusLabel(request.exception_type)} | {request.start_date} - {request.end_date}</span>
                    <span>Status: {statusLabel(request.status)}</span>
                    <span>{request.title}</span>
                    <span>{request.details || 'No details provided.'}</span>
                  </div>

                  <div className="timeoff-admin-actions">
                    <input
                      placeholder="Review notes"
                      value={exceptionReviewNotes[request.id] ?? ''}
                      onChange={(event) => {
                        setExceptionReviewNotes((current) => ({
                          ...current,
                          [request.id]: event.target.value
                        }));
                      }}
                    />
                    {canReview ? (
                      <>
                        <button type="button" onClick={() => void reviewException(request.id, 'approved')} disabled={busy}>
                          Approve
                        </button>
                        <button type="button" className="danger" onClick={() => void reviewException(request.id, 'denied')} disabled={busy}>
                          Deny
                        </button>
                      </>
                    ) : null}
                    <button type="button" onClick={() => void editExceptionRequest(request)} disabled={busy}>
                      Edit
                    </button>
                    <button type="button" className="danger" onClick={() => void deleteExceptionRequest(request.id)} disabled={busy}>
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </article>

      <article className="scheduling-admin-card">
        <h2>Assign Overtime</h2>
        <form className="scheduling-admin-form" onSubmit={submitAssignOvertime}>
          <label>
            Employee
            <select value={assignOvertimeEmployeeId} onChange={(event) => setAssignOvertimeEmployeeId(event.target.value)} required>
              <option value="" disabled>Select employee</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.full_name || employee.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            Overtime Type
            <select value={assignOvertimeType} onChange={(event) => setAssignOvertimeType(event.target.value as OvertimeRequestType)}>
              <option value="voluntary">Voluntary</option>
              <option value="mandatory">Mandatory</option>
            </select>
          </label>
          <label>
            Date
            <input type="date" value={assignOvertimeDate} onChange={(event) => setAssignOvertimeDate(event.target.value)} required />
          </label>
          <label>
            Start
            <input type="time" step={900} value={assignOvertimeStartTime} onChange={(event) => setAssignOvertimeStartTime(event.target.value)} required />
          </label>
          <label>
            End
            <input type="time" step={900} value={assignOvertimeEndTime} onChange={(event) => setAssignOvertimeEndTime(event.target.value)} required />
          </label>
          <label className="full-width">
            Note
            <input value={assignOvertimeNote} onChange={(event) => setAssignOvertimeNote(event.target.value)} placeholder="Optional overtime note" />
          </label>
          <button type="submit" disabled={busy || !assignOvertimeEmployeeId}>
            {assignOvertimeType === 'mandatory' ? 'Assign Mandatory OT' : 'Assign Voluntary OT'}
          </button>
        </form>
      </article>

      <article className="scheduling-admin-card">
        <h2>Overtime Requests (All)</h2>
        {allOvertimeRequests.length === 0 ? (
          <p className="empty-state">No overtime requests.</p>
        ) : (
          <div className="timeoff-admin-list">
            {allOvertimeRequests.map((request) => {
              const employee = employeeById.get(request.employee_id);
              const canReview = request.status === 'pending';
              return (
                <div className="timeoff-admin-row" key={request.id}>
                  <div>
                    <strong>{employee?.full_name || employee?.email || request.employee_id}</strong>
                    <span>
                      {isoToDateKey(request.start_at)} {toTimeHHMM(request.start_at)}-{toTimeHHMM(request.end_at)}
                    </span>
                    <span>Status: {statusLabel(request.status)}</span>
                    <span>Type: {statusLabel(request.overtime_type)}</span>
                    {request.assigned_by ? <span>Assigned by admin</span> : <span>Self requested</span>}
                    {request.note?.trim() ? <span>{request.note}</span> : null}
                    {request.approved_shift_id ? <span>Approved shift created.</span> : null}
                  </div>

                  <div className="timeoff-admin-actions">
                    <input
                      placeholder="Review notes"
                      value={overtimeReviewNotes[request.id] ?? ''}
                      onChange={(event) => {
                        setOvertimeReviewNotes((current) => ({
                          ...current,
                          [request.id]: event.target.value
                        }));
                      }}
                    />
                    {canReview ? (
                      <>
                        <button type="button" onClick={() => void reviewOvertime(request.id, 'approved')} disabled={busy}>
                          Approve
                        </button>
                        <button type="button" className="danger" onClick={() => void reviewOvertime(request.id, 'denied')} disabled={busy}>
                          Deny
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </article>

      <article className="scheduling-admin-card">
        <h2>Shift Swap Requests (All)</h2>
        {allShiftSwapRequests.length === 0 ? (
          <p className="empty-state">No shift swap requests.</p>
        ) : (
          <div className="timeoff-admin-list">
            {allShiftSwapRequests.map((request) => {
              const requester = employeeById.get(request.requester_id);
              const acceptedBy = request.accepted_by_employee_id ? employeeById.get(request.accepted_by_employee_id) : null;
              const canReview = request.status === 'pending_admin' || request.status === 'open';
              return (
                <div className="timeoff-admin-row" key={request.id}>
                  <div>
                    <strong>{requester?.full_name || requester?.email || request.requester_id}</strong>
                    <span>Status: {statusLabel(request.status)}</span>
                    <span>Shift ID: {request.shift_id}</span>
                    {acceptedBy ? <span>Accepted By: {acceptedBy.full_name || acceptedBy.email}</span> : null}
                    {request.request_note?.trim() ? <span>Request: {request.request_note}</span> : null}
                    {request.acceptance_note?.trim() ? <span>Acceptance: {request.acceptance_note}</span> : null}
                    {request.review_note?.trim() ? <span>Review: {request.review_note}</span> : null}
                  </div>
                  <div className="timeoff-admin-actions">
                    <input
                      placeholder="Review notes"
                      value={swapReviewNotes[request.id] ?? ''}
                      onChange={(event) => {
                        setSwapReviewNotes((current) => ({
                          ...current,
                          [request.id]: event.target.value
                        }));
                      }}
                    />
                    {canReview ? (
                      <>
                        <button type="button" onClick={() => void reviewShiftSwap(request.id, true)} disabled={busy}>
                          Approve
                        </button>
                        <button type="button" className="danger" onClick={() => void reviewShiftSwap(request.id, false)} disabled={busy}>
                          Deny
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </article>

      <article className="scheduling-admin-card">
        <h2>Employee Write-Ups / Punishments</h2>
        <form className="scheduling-admin-form" onSubmit={submitDisciplineAction}>
          <label>
            Employee
            <select value={disciplineEmployeeId} onChange={(event) => setDisciplineEmployeeId(event.target.value)} required>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.full_name || employee.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            Severity
            <select value={disciplineSeverity} onChange={(event) => setDisciplineSeverity(event.target.value as DisciplineSeverity)}>
              <option value="warning">Warning</option>
              <option value="serious">Serious</option>
              <option value="final">Final</option>
            </select>
          </label>
          <label>
            Punishment
            <select
              value={disciplinePunishmentType}
              onChange={(event) => setDisciplinePunishmentType(event.target.value as DisciplinePunishmentType)}
            >
              <option value="none">None</option>
              <option value="pay_rate_reduction">Pay Rate Reduction ($/hr)</option>
              <option value="unpaid_suspension">Unpaid Suspension (days)</option>
              <option value="probation">Probation (days)</option>
            </select>
          </label>
          <label>
            Punishment Value
            <input
              type="number"
              min={0}
              step="0.01"
              value={disciplinePunishmentValue}
              onChange={(event) => setDisciplinePunishmentValue(event.target.value)}
            />
          </label>
          <label>
            Title
            <input required value={disciplineTitle} onChange={(event) => setDisciplineTitle(event.target.value)} />
          </label>
          <label className="full-width">
            Details
            <input value={disciplineDetails} onChange={(event) => setDisciplineDetails(event.target.value)} />
          </label>
          <button type="submit" disabled={busy || !disciplineEmployeeId}>Issue Write-Up</button>
        </form>

        {allDisciplineActions.length === 0 ? (
          <p className="empty-state">No discipline actions.</p>
        ) : (
          <div className="timeoff-admin-list">
            {allDisciplineActions.map((action) => {
              const employee = employeeById.get(action.employee_id);
              const canApply = action.status === 'issued';
              return (
                <div className="timeoff-admin-row" key={action.id}>
                  <div>
                    <strong>{employee?.full_name || employee?.email || action.employee_id}</strong>
                    <span>{statusLabel(action.severity)} | {statusLabel(action.punishment_type)}</span>
                    <span>Punishment Value: {action.punishment_value}</span>
                    <span>Status: {statusLabel(action.status)}</span>
                    <span>{action.title}</span>
                    <span>{action.details || 'No details provided.'}</span>
                    {action.review_notes ? <span>Review: {action.review_notes}</span> : null}
                  </div>

                  <div className="timeoff-admin-actions">
                    <input
                      placeholder="Review notes"
                      value={disciplineReviewNotes[action.id] ?? ''}
                      onChange={(event) => {
                        setDisciplineReviewNotes((current) => ({
                          ...current,
                          [action.id]: event.target.value
                        }));
                      }}
                    />
                    {canApply ? (
                      <button type="button" onClick={() => void applyDiscipline(action.id)} disabled={busy}>
                        Apply
                      </button>
                    ) : null}
                    {action.status !== 'revoked' ? (
                      <button type="button" className="danger" onClick={() => void revokeDiscipline(action.id)} disabled={busy}>
                        Revoke
                      </button>
                    ) : null}
                    <button type="button" onClick={() => void editDisciplineAction(action)} disabled={busy}>
                      Edit
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </article>

      <article className="scheduling-admin-card">
        <h2>Time-Off Requests (All)</h2>
        {allTimeOffRequests.length === 0 ? (
          <p className="empty-state">No time-off requests.</p>
        ) : (
          <div className="timeoff-admin-list">
            {allTimeOffRequests.map((request) => {
              const employee = employeeById.get(request.employee_id);
              const canReview = request.status === 'pending';
              return (
                <div className="timeoff-admin-row" key={request.id}>
                  <div>
                    <strong>{employee?.full_name || employee?.email || request.employee_id}</strong>
                    <span>{request.start_date} - {request.end_date} ({statusLabel(request.request_type)})</span>
                    <span>Status: {statusLabel(request.status)}</span>
                    <span>{request.reason || 'No reason provided.'}</span>
                  </div>

                  <div className="timeoff-admin-actions">
                    <input
                      placeholder="Review notes"
                      value={reviewNotes[request.id] ?? ''}
                      onChange={(event) => {
                        setReviewNotes((current) => ({
                          ...current,
                          [request.id]: event.target.value
                        }));
                      }}
                    />
                    {canReview ? (
                      <>
                        <button type="button" onClick={() => void reviewRequest(request.id, 'approved')} disabled={busy}>
                          Approve
                        </button>
                        <button type="button" className="danger" onClick={() => void reviewRequest(request.id, 'denied')} disabled={busy}>
                          Deny
                        </button>
                      </>
                    ) : null}
                    <button type="button" onClick={() => void editTimeOffRequest(request)} disabled={busy}>
                      Edit
                    </button>
                    <button type="button" className="danger" onClick={() => void deleteTimeOffRequest(request.id)} disabled={busy}>
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </article>
      </>
      ) : null}
      </section>

      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="form-message">{message}</p> : null}
      </section>
  );
}
