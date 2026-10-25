import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type {
  BoardFilters,
  BoardNoteRow,
  DisciplineActionRow,
  ExceptionRequestRow,
  ProfileRow,
  ShiftRow,
  ShiftStatus,
  TaskAssignmentRow,
  TaskPriority,
  TaskRow,
  TaskStatus,
  TimelineZoomHours,
  TimeNullificationRow,
  TimeNullificationStatus,
  TimeOffRequestRow,
  WorkAreaRow
} from '../types';
import { TIMELINE_ZOOM_LEVELS } from '../types';
import { minutesToHHMM, toTimeHHMM } from '../lib/time';
import { DEFAULT_FEATURES } from '../lib/features';
import type { FeatureFlags } from '../lib/features';

export type ShiftPayload = {
  shiftId?: string;
  employeeId: string;
  workAreaId: string | null;
  startAt: string;
  endAt: string;
  status: ShiftStatus;
  breakMinutes: number;
  notes: string;
  actorId: string;
};

export type TaskPayload = {
  taskId: string;
  title: string;
  description: string;
  startAt: string;
  endAt: string;
  workAreaId: string | null;
  shiftId: string | null;
  priority: TaskPriority;
  status?: TaskStatus;
};

export type TaskAssignPayload = {
  employeeId: string;
  title: string;
  description: string;
  startAt: string;
  endAt: string;
  workAreaId: string | null;
  shiftId: string | null;
  priority: TaskPriority;
};

type TimelineBoardProps = {
  employees: ProfileRow[];
  workAreas: WorkAreaRow[];
  shifts: ShiftRow[];
  tasks: TaskRow[];
  taskAssignments: TaskAssignmentRow[];
  filters: BoardFilters;
  onToggleFilter?: (key: keyof BoardFilters) => void;
  shiftFilter?: string;
  onShiftFilterChange?: (value: string) => void;
  selectedDate: string;
  timelineWindowHours: TimelineZoomHours;
  onTimelineWindowChange?: (hours: TimelineZoomHours) => void;
  defaultShiftBreakMinutes: number;
  nowDate: Date;
  actorId: string;
  features?: FeatureFlags;
  busy: boolean;
  boardNotes: BoardNoteRow[];
  timeOffRequests: TimeOffRequestRow[];
  exceptionRequests?: ExceptionRequestRow[];
  disciplineActions?: DisciplineActionRow[];
  timeNullifications: TimeNullificationRow[];
  onCreateTimeNullification: (payload: {
    employeeId: string;
    shiftId: string;
    startAt: string;
    endAt: string;
    reason: string;
    approved?: boolean;
  }) => Promise<unknown>;
  onReviewTimeNullification: (payload: {
    requestId: string;
    status: 'approved' | 'denied' | 'cancelled';
    reviewNote?: string;
  }) => Promise<unknown>;
  onDeleteTimeNullification: (requestId: string) => Promise<unknown>;
  onCreateBoardNote: (payload: {
    body: string;
    isPublic: boolean;
    date: string;
    employeeId?: string | null;
    workAreaId?: string | null;
  }) => Promise<unknown>;
  onDeleteBoardNote: (noteId: string) => Promise<unknown>;
  onUpsertShift: (payload: ShiftPayload) => Promise<void>;
  onDeleteShift: (shiftId: string) => Promise<void>;
  onUpdateShiftWorkArea: (shiftId: string, workAreaId: string | null) => Promise<void>;
  onCreateWorkArea: (payload: { name: string; description: string; color: string; createdBy: string }) => Promise<void>;
  onClockInShift: (shiftId: string, actorId: string) => Promise<void>;
  onClockOutShift: (shiftId: string, actorId: string) => Promise<void>;
  onAssignBreak: (shiftId: string, breakMinutes: number, note: string) => Promise<void>;
  onAssignTask: (payload: TaskAssignPayload) => Promise<void>;
  onUpdateTask: (payload: TaskPayload) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
  onReassignTaskAssignment: (taskId: string, employeeId: string) => Promise<void>;
  onUnassignTaskAssignment: (taskId: string) => Promise<void>;
  onSendMessage: (payload: { recipientId: string; subject: string; message: string }) => Promise<void>;
  onSendNoteTask: (payload: { employeeId: string; note: string }) => Promise<void>;
};

const PX_PER_MINUTE: Record<TimelineZoomHours, number> = { 1: 3.1, 2: 2.2, 4: 1.2, 8: 0.62, 12: 0.45, 24: 0.26 };
const ROW_HEIGHT = 50;
const MIN_SHIFT_GAP_MINUTES = 10;
const LEFT_WIDTH = 250;
const WORK_AREA_COLORS = ['#1f56b9', '#0f8a63', '#b25b00', '#6a3fb5', '#b02033', '#0b7285', '#846200'];

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'open',
  in_progress: 'in progress',
  done: 'complete',
  cancelled: 'cancelled'
};

// A shift line turns into an alert state when the employee's clock-in is off or a
// task on that shift was never acknowledged. One state is shown at a time, most
// urgent first.
type ShiftAlert = 'early' | 'late' | 'missing' | 'ack';
type OperationsAlertKind = ShiftAlert | 'nullification';
type OperationsAlert = {
  id: string;
  kind: OperationsAlertKind;
  title: string;
  detail: string;
  shiftId?: string;
  taskId?: string;
  nullificationId?: string;
};

const SHIFT_ALERT_LABEL: Record<ShiftAlert, string> = {
  early: 'Early in',
  late: 'Late in',
  missing: 'No clock-in',
  ack: 'No ack'
};

const OPERATIONS_ALERT_LABEL: Record<OperationsAlertKind, string> = {
  early: 'Early in',
  late: 'Late in',
  missing: 'No clock-in',
  ack: 'No ack',
  nullification: 'No-task'
};

const SHIFT_ALERT_HINT: Record<ShiftAlert, string> = {
  early: 'clocked in early',
  late: 'clocked in late',
  missing: 'has not clocked in',
  ack: 'a task was not acknowledged within 2 minutes of its start'
};

const CLOCK_GRACE_MS = 60_000;
const TASK_ACK_WINDOW_MS = 2 * 60_000;

type MenuTarget = {
  kind: 'task' | 'shift' | 'slot' | 'area' | 'board' | 'nullification';
  taskId?: string;
  shiftId?: string;
  employeeId?: string;
  workAreaId?: string;
  nullificationId?: string;
  minutes?: number;
};

type MenuState = MenuTarget & { x: number; y: number };

type MenuEntry =
  | { kind: 'separator' }
  | { kind: 'item'; label: string; detail?: string; danger?: boolean; disabled?: boolean; onSelect: () => void };

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateParts(dateValue: string): [number, number, number] {
  const [year, month, day] = dateValue.split('-').map(Number);
  return [year, month - 1, day];
}

function dayStart(dateValue: string): Date {
  const [year, month, day] = dateParts(dateValue);
  return new Date(year, month, day, 0, 0, 0, 0);
}

function isoAtMinutes(dateValue: string, minutes: number): string {
  const [year, month, day] = dateParts(dateValue);
  return new Date(year, month, day, 0, minutes, 0, 0).toISOString();
}

function toDateInputValue(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDateInputValue(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function minutesIntoDay(iso: string, dateValue: string): number {
  const start = dayStart(dateValue).getTime();
  return (new Date(iso).getTime() - start) / 60000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function statusClass(status: ShiftRow['status']): string {
  if (status === 'on_duty') return 'on-duty';
  if (status === 'break') return 'on-break';
  if (status === 'off_shift') return 'off-shift';
  return 'scheduled';
}

function priorityColor(priority: TaskPriority): string {
  if (priority === 'critical') return '#b02033';
  if (priority === 'high') return '#c25c00';
  if (priority === 'low') return '#2f6f8f';
  return '#2b6cb0';
}

function timeOffTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    vacation: 'Vacation',
    sick: 'Sick',
    personal: 'Personal',
    unpaid: 'Unpaid',
    other: 'Time off'
  };
  return labels[type] ?? 'Time off';
}

// Leave that takes an employee off the schedule for the day. Discipline wins over an
// approved day off, which in turn wins over regular time off.
type LeaveKind = 'suspension' | 'probation' | 'vaut' | 'day_off' | 'time_off';

type LeaveMarker = {
  kind: LeaveKind;
  label: string;
  detail: string;
};

const EXCEPTION_LEAVE_LABEL: Record<string, string> = {
  VAUT: 'VAUT',
  DO: 'Day off'
};

function addDays(dateValue: string, offset: number): string {
  const day = dayStart(dateValue);
  day.setDate(day.getDate() + offset);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function coversDate(start: string | null | undefined, end: string | null | undefined, target: string): boolean {
  const from = start?.slice(0, 10);
  const to = end?.slice(0, 10) ?? from;
  if (!from || !to) return false;
  return target >= from && target <= to;
}

export function TimelineBoard({
  employees,
  workAreas,
  shifts,
  tasks,
  taskAssignments,
  filters,
  onToggleFilter,
  shiftFilter = 'all',
  onShiftFilterChange,
  selectedDate,
  timelineWindowHours,
  onTimelineWindowChange,
  defaultShiftBreakMinutes,
  nowDate,
  actorId,
  features = DEFAULT_FEATURES,
  busy,
  boardNotes,
  timeOffRequests,
  exceptionRequests = [],
  disciplineActions = [],
  timeNullifications,
  onCreateTimeNullification,
  onReviewTimeNullification,
  onDeleteTimeNullification,
  onCreateBoardNote,
  onDeleteBoardNote,
  onUpsertShift,
  onDeleteShift,
  onUpdateShiftWorkArea,
  onCreateWorkArea,
  onClockInShift,
  onClockOutShift,
  onAssignBreak,
  onAssignTask,
  onUpdateTask,
  onDeleteTask,
  onReassignTaskAssignment,
  onUnassignTaskAssignment,
  onSendMessage,
  onSendNoteTask
}: TimelineBoardProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState('');
  const [taskSearch, setTaskSearch] = useState('');
  const [taskStatusFilter, setTaskStatusFilter] = useState<'all' | TaskStatus>('all');
  const [taskPriorityFilter, setTaskPriorityFilter] = useState<'all' | TaskPriority>('all');
  const [notice, setNotice] = useState<null | { text: string; tone: 'ok' | 'warn' }>(null);
  const [drag, setDrag] = useState<null | {
    kind: 'shift' | 'task';
    id: string;
    originX: number;
    deltaMinutes: number;
    moved: boolean;
  }>(null);
  const dragRef = useRef<null | {
    kind: 'shift' | 'task';
    id: string;
    originX: number;
    deltaMinutes: number;
    moved: boolean;
  }>(null);
  const skipClickRef = useRef(0);
  const showShifts = features.shifts !== false;
  const showTasks = features.tasks !== false;
  const [shiftDraft, setShiftDraft] = useState<null | {
    shiftId?: string;
    employeeId: string;
    workAreaId: string;
    startAt: string;
    endAt: string;
    status: ShiftStatus;
    breakMinutes: number;
    notes: string;
  }>(null);
  const [taskDraft, setTaskDraft] = useState<null | {
    taskId?: string;
    employeeId: string;
    title: string;
    description: string;
    startAt: string;
    endAt: string;
    workAreaId: string;
    priority: TaskPriority;
    status: TaskStatus;
  }>(null);
  const [areaDraft, setAreaDraft] = useState<null | { name: string; description: string; color: string }>(null);
  const [messageDraft, setMessageDraft] = useState<null | { employeeId: string; subject: string; message: string }>(null);
  const [noteDraft, setNoteDraft] = useState<null | { employeeId: string; note: string }>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [nullificationDraft, setNullificationDraft] = useState<null | {
    employeeId: string;
    shiftId: string;
    shiftLabel: string;
    startAt: string;
    endAt: string;
    reason: string;
  }>(null);
  const [noteBody, setNoteBody] = useState('');
  const [notePublic, setNotePublic] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteBusyId, setNoteBusyId] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteTarget, setNoteTarget] = useState('');
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  // The base value is the zoom level for the selected window. When the viewport is
  // wider than the zoomed grid, stretch the scale so a full day always fills the
  // board instead of leaving dead space to the right.
  const basePpm = PX_PER_MINUTE[timelineWindowHours];
  const fitPpm = viewportWidth > 0 ? Math.max(0, viewportWidth - LEFT_WIDTH - 2) / 1440 : 0;
  const ppm = Math.max(basePpm, fitPpm);
  const gridWidth = Math.round(1440 * ppm);
  const hasViewportWidth = viewportWidth > 0;

  const workAreaById = useMemo(() => new Map(workAreas.map((area) => [area.id, area])), [workAreas]);

  // Notes attached to a person or a work area are drawn on the board itself, in the
  // row they belong to. Notes without a target stay in the Board Notes rail.
  const notesByEmployee = useMemo(() => {
    const map = new Map<string, BoardNoteRow[]>();
    for (const note of boardNotes) {
      if (!note.employee_id) continue;
      const bucket = map.get(note.employee_id) ?? [];
      bucket.push(note);
      map.set(note.employee_id, bucket);
    }
    return map;
  }, [boardNotes]);

  // Leave is a whole-day marker on the board. Discipline (suspension or probation)
  // outranks an approved VAUT/DO day, which outranks regular approved time off.
  const leaveByEmployee = useMemo(() => {
    const map = new Map<string, LeaveMarker>();
    for (const action of disciplineActions) {
      if (action.status === 'revoked') continue;
      const suspended = action.punishment_type === 'unpaid_suspension';
      const probation = action.punishment_type === 'probation';
      if (!suspended && !probation) continue;
      const days = Math.max(1, Math.floor(Number(action.punishment_value) || 0));
      const start = action.leave_starts_on?.slice(0, 10) ?? action.created_at?.slice(0, 10) ?? null;
      const end = action.leave_ends_on?.slice(0, 10) ?? (start ? addDays(start, days - 1) : null);
      if (!coversDate(start, end, selectedDate)) continue;
      if (map.has(action.employee_id)) continue;
      map.set(
        action.employee_id,
        suspended
          ? {
              kind: 'suspension',
              label: 'Suspension',
              detail: `Suspension — ${days} day${days === 1 ? '' : 's'} off (${start} → ${end})`
            }
          : {
              kind: 'probation',
              label: 'Probation',
              detail: `Probation — schedule cleared (${start} → ${end})`
            }
      );
    }
    for (const request of exceptionRequests) {
      if (map.has(request.employee_id)) continue;
      if (request.status !== 'approved') continue;
      const label = EXCEPTION_LEAVE_LABEL[request.exception_code];
      if (!label) continue;
      if (!coversDate(request.start_date, request.end_date, selectedDate)) continue;
      map.set(request.employee_id, {
        kind: request.exception_code === 'VAUT' ? 'vaut' : 'day_off',
        label,
        detail:
          request.exception_code === 'VAUT'
            ? 'Authorized unpaid time off (VAUT)'
            : 'Authorized day off (DO)'
      });
    }
    for (const request of timeOffRequests) {
      if (map.has(request.employee_id)) continue;
      if (request.status !== 'approved') continue;
      if (!coversDate(request.start_date, request.end_date, selectedDate)) continue;
      map.set(request.employee_id, {
        kind: 'time_off',
        label: timeOffTypeLabel(request.request_type),
        detail: `Approved ${request.request_type} time off (${request.start_date.slice(0, 10)} → ${request.end_date.slice(0, 10)})`
      });
    }
    return map;
  }, [timeOffRequests, exceptionRequests, disciplineActions, selectedDate]);

  // Approved (and still-pending) no-task windows grouped per employee row.
  const nullificationsByEmployee = useMemo(() => {
    const map = new Map<string, TimeNullificationRow[]>();
    for (const row of timeNullifications) {
      if (row.status !== 'approved' && row.status !== 'pending') continue;
      const start = minutesIntoDay(row.start_at, selectedDate);
      const end = minutesIntoDay(row.end_at, selectedDate);
      if (end <= 0 || start >= 1440) continue;
      const bucket = map.get(row.employee_id) ?? [];
      bucket.push(row);
      map.set(row.employee_id, bucket);
    }
    return map;
  }, [timeNullifications, selectedDate]);

  const pendingNullificationCount = useMemo(
    () =>
      timeNullifications.filter((row) => {
        if (row.status !== 'pending') return false;
        const start = minutesIntoDay(row.start_at, selectedDate);
        const end = minutesIntoDay(row.end_at, selectedDate);
        return end > 0 && start < 1440;
      }).length,
    [timeNullifications, selectedDate]
  );

  const notesByArea = useMemo(() => {
    const map = new Map<string, BoardNoteRow[]>();
    for (const note of boardNotes) {
      if (!note.work_area_id) continue;
      const bucket = map.get(note.work_area_id) ?? [];
      bucket.push(note);
      map.set(note.work_area_id, bucket);
    }
    return map;
  }, [boardNotes]);

  const shiftsByEmployee = useMemo(() => {
    const map = new Map<string, ShiftRow[]>();
    for (const shift of shifts) {
      if (!shift.employee_id) continue;
      const bucket = map.get(shift.employee_id) ?? [];
      bucket.push(shift);
      map.set(shift.employee_id, bucket);
    }
    return map;
  }, [shifts]);

  const assignmentsByEmployee = useMemo(() => {
    const map = new Map<string, TaskAssignmentRow[]>();
    for (const assignment of taskAssignments) {
      const bucket = map.get(assignment.employee_id) ?? [];
      bucket.push(assignment);
      map.set(assignment.employee_id, bucket);
    }
    return map;
  }, [taskAssignments]);

  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  function shiftGaps(list: ShiftRow[]) {
    const ordered = [...list].sort(
      (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
    );
    const gaps: { key: string; left: number; width: number; label: string }[] = [];
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      const from = clamp(minutesIntoDay(previous.end_at, selectedDate), 0, 1440);
      const to = clamp(minutesIntoDay(current.start_at, selectedDate), 0, 1440);
      const minutes = Math.round(to - from);
      if (minutes < MIN_SHIFT_GAP_MINUTES) continue;
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      gaps.push({
        key: `${previous.id}-${current.id}`,
        left: from,
        width: minutes,
        label: `${hours ? `${hours}h ` : ''}${rest ? `${rest}m ` : ''}between shifts`
      });
    }
    return gaps;
  }

  function shiftAlert(shift: ShiftRow, assignments: TaskAssignmentRow[]): ShiftAlert | null {
    const now = nowDate.getTime();
    const start = new Date(shift.start_at).getTime();
    const clockedIn = shift.clocked_in_at ? new Date(shift.clocked_in_at).getTime() : null;
    if (clockedIn === null) {
      if (now > start + CLOCK_GRACE_MS) return 'missing';
    } else if (clockedIn < start - CLOCK_GRACE_MS) {
      return 'early';
    } else if (clockedIn > start + CLOCK_GRACE_MS) {
      return 'late';
    }
    const shiftEnd = new Date(shift.end_at).getTime();
    for (const assignment of assignments) {
      if (assignment.acknowledged_at) continue;
      const task = taskById.get(assignment.task_id);
      if (!task || task.status === 'done' || task.status === 'cancelled') continue;
      const taskStart = new Date(task.start_at).getTime();
      if (taskStart < start || taskStart > shiftEnd) continue;
      if (now > taskStart + TASK_ACK_WINDOW_MS) return 'ack';
    }
    return null;
  }

  // Declared before the alert memo below: that memo calls taskVisible while it
  // renders, so both the filter term and the predicate must already exist.
  const taskFilterTerm = taskSearch.trim().toLowerCase();

  function taskVisible(task: TaskRow): boolean {
    if (taskStatusFilter !== 'all' && task.status !== taskStatusFilter) return false;
    if (taskPriorityFilter !== 'all' && task.priority !== taskPriorityFilter) return false;
    if (!taskFilterTerm) return true;
    return (
      task.title.toLowerCase().includes(taskFilterTerm) ||
      (task.description ?? '').toLowerCase().includes(taskFilterTerm)
    );
  }

  const operationsAlerts = useMemo<OperationsAlert[]>(() => {
    if (!showShifts && !showTasks) return [];
    const now = nowDate.getTime();
    const alerts: OperationsAlert[] = [];
    const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
    const selectedDayStart = dayStart(selectedDate).getTime();
    const selectedDayEnd = selectedDayStart + 24 * 60 * 60 * 1000;

    for (const row of timeNullifications) {
      if (row.status !== 'pending') continue;
      const start = minutesIntoDay(row.start_at, selectedDate);
      const end = minutesIntoDay(row.end_at, selectedDate);
      if (end <= 0 || start >= 1440) continue;
      const employee = employeeById.get(row.employee_id);
      alerts.push({
        id: `nullification-${row.id}`,
        kind: 'nullification',
        title: `${employee?.full_name || employee?.email || 'Employee'} requested no-task time`,
        detail: `${toTimeHHMM(row.start_at)}–${toTimeHHMM(row.end_at)}${row.reason ? ` · ${row.reason}` : ''}`,
        nullificationId: row.id
      });
    }

    const selectedDayKey = `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())}`;
    if (showShifts && selectedDate === selectedDayKey) {
      for (const shift of shifts) {
        if (!shift.employee_id) continue;
        const start = new Date(shift.start_at).getTime();
        const end = new Date(shift.end_at).getTime();
        if (start >= selectedDayEnd || end < selectedDayStart) continue;
        const employee = employeeById.get(shift.employee_id);
        const name = employee?.full_name || employee?.email || 'Employee';
        const clockedIn = shift.clocked_in_at ? new Date(shift.clocked_in_at).getTime() : null;
        if (clockedIn !== null && clockedIn < start - CLOCK_GRACE_MS) {
          alerts.push({ id: `shift-early-${shift.id}`, kind: 'early', title: `${name} clocked in early`, detail: toTimeHHMM(shift.start_at), shiftId: shift.id });
        } else if (clockedIn !== null && clockedIn > start + CLOCK_GRACE_MS) {
          alerts.push({ id: `shift-late-${shift.id}`, kind: 'late', title: `${name} clocked in late`, detail: toTimeHHMM(shift.start_at), shiftId: shift.id });
        } else if (clockedIn === null && now > start + CLOCK_GRACE_MS) {
          alerts.push({ id: `shift-missing-${shift.id}`, kind: 'missing', title: `${name} has not clocked in`, detail: `Shift started ${toTimeHHMM(shift.start_at)}`, shiftId: shift.id });
        }
      }
    }

    if (showTasks && filters.events) {
      const assignmentByTask = new Map<string, TaskAssignmentRow[]>();
      for (const assignment of taskAssignments) {
        const bucket = assignmentByTask.get(assignment.task_id) ?? [];
        bucket.push(assignment);
        assignmentByTask.set(assignment.task_id, bucket);
      }
      for (const task of tasks) {
        if (!taskVisible(task) || task.status === 'done' || task.status === 'cancelled') continue;
        const start = new Date(task.start_at).getTime();
        if (start < selectedDayStart || start >= selectedDayEnd || now <= start + TASK_ACK_WINDOW_MS) continue;
        const assignments = assignmentByTask.get(task.id) ?? [];
        for (const assignment of assignments) {
          if (assignment.acknowledged_at) continue;
          const employee = employeeById.get(assignment.employee_id);
          alerts.push({
            id: `task-ack-${task.id}-${assignment.employee_id}`,
            kind: 'ack',
            title: `${employee?.full_name || employee?.email || 'Employee'} hasn’t acknowledged “${task.title}”`,
            detail: `Started ${toTimeHHMM(task.start_at)}`,
            taskId: task.id
          });
        }
      }
    }
    return alerts;
  }, [showShifts, showTasks, nowDate, shifts, employees, selectedDate, filters.events, tasks, taskAssignments, taskStatusFilter, taskPriorityFilter, taskSearch, timeNullifications]);

  function focusOperationsAlert(alert: OperationsAlert) {
    const node = scrollRef.current;
    const selector = alert.shiftId
      ? `[data-ops-shift-id="${CSS.escape(alert.shiftId)}"]`
      : alert.nullificationId
        ? `[data-ops-null-id="${CSS.escape(alert.nullificationId)}"]`
        : `[data-ops-task-id="${CSS.escape(alert.taskId ?? '')}"]`;
    const target = node?.querySelector<HTMLElement>(selector);
    if (!node || !target) return;
    const boardRect = node.getBoundingClientRect();
    const targetX = target.getBoundingClientRect().left - boardRect.left + node.scrollLeft + target.offsetWidth / 2;
    node.scrollTo({ left: Math.max(0, targetX - node.clientWidth / 2), behavior: 'smooth' });
    target.classList.add('rs-alert-focus');
    window.setTimeout(() => target.classList.remove('rs-alert-focus'), 1800);
  }

  const assignedTaskIds = useMemo(
    () => new Set(taskAssignments.map((assignment) => assignment.task_id)),
    [taskAssignments]
  );

  const unassignedTasks = useMemo(() => {
    const priorityRank: Record<TaskPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
    return tasks
      .filter(
        (task) =>
          !assignedTaskIds.has(task.id) && (task.status === 'pending' || task.status === 'in_progress')
      )
      .filter(taskVisible)
      .sort((a, b) =>
        priorityRank[a.priority] - priorityRank[b.priority] ||
        new Date(a.start_at).getTime() - new Date(b.start_at).getTime()
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, assignedTaskIds, taskStatusFilter, taskPriorityFilter, taskFilterTerm]);

  const visibleTaskCount = useMemo(
    () => tasks.filter(taskVisible).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, taskStatusFilter, taskPriorityFilter, taskFilterTerm]
  );

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!menu) return;
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
      setMenu(null);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenu(null);
    }
    function handleDismiss() {
      setMenu(null);
    }
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleDismiss, true);
    window.addEventListener('resize', handleDismiss);
    window.addEventListener('blur', handleDismiss);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleDismiss, true);
      window.removeEventListener('resize', handleDismiss);
      window.removeEventListener('blur', handleDismiss);
    };
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 8;
    const nextX = Math.min(menu.x, Math.max(margin, window.innerWidth - rect.width - margin));
    const nextY = Math.min(menu.y, Math.max(margin, window.innerHeight - rect.height - margin));
    if (nextX !== menu.x || nextY !== menu.y) setMenu({ ...menu, x: nextX, y: nextY });
  }, [menu]);

  const visibleEmployees = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return employees;
    return employees.filter((employee) =>
      employee.full_name.toLowerCase().includes(term) ||
      employee.email.toLowerCase().includes(term)
    );
  }, [employees, search]);

  const groups = useMemo(() => {
    const buckets = new Map<string, { area: WorkAreaRow | null; employees: ProfileRow[] }>();
    for (const employee of visibleEmployees) {
      const employeeShifts = shiftsByEmployee.get(employee.id) ?? [];
      const areaId = employeeShifts.find((shift) => shift.work_area_id)?.work_area_id ?? '';
      const key = areaId || 'unassigned';
      const bucket = buckets.get(key) ?? { area: areaId ? workAreaById.get(areaId) ?? null : null, employees: [] };
      bucket.employees.push(employee);
      buckets.set(key, bucket);
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => {
        if (a === 'unassigned') return 1;
        if (b === 'unassigned') return -1;
        return (workAreaById.get(a)?.name ?? '').localeCompare(workAreaById.get(b)?.name ?? '');
      })
      .map(([key, bucket]) => ({ key, ...bucket }));
  }, [visibleEmployees, shiftsByEmployee, workAreaById]);

  const isToday = selectedDate === `${nowDate.getFullYear()}-${pad(nowDate.getMonth() + 1)}-${pad(nowDate.getDate())}`;
  const nowMinutes = (nowDate.getTime() - dayStart(selectedDate).getTime()) / 60000;

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const update = () => setViewportWidth(node.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const minutes = (Date.now() - dayStart(selectedDate).getTime()) / 60000;
    const target = selectedDate === todayKey()
      ? minutes * ppm - node.clientWidth / 3
      : 6 * Math.round(60 * ppm);
    node.scrollLeft = Math.max(0, target);
    // Re-centre once the real board width is known; later resizes keep the user's scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineWindowHours, selectedDate, hasViewportWidth]);

  // Ctrl + wheel zooms the timeline instead of scrolling sideways.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !onTimelineWindowChange) return;
    function handleWheel(event: WheelEvent) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      changeZoom(event.deltaY > 0 ? 1 : -1);
    }
    node.addEventListener('wheel', handleWheel, { passive: false });
    return () => node.removeEventListener('wheel', handleWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTimelineWindowChange, timelineWindowHours]);

  const dragging = drag !== null;

  useEffect(() => {
    if (!dragging) return;
    function handleMove(event: PointerEvent) {
      const current = dragRef.current;
      if (!current) return;
      if (Math.abs(event.clientX - current.originX) > 3) current.moved = true;
      const delta = Math.round((event.clientX - current.originX) / ppm / 15) * 15;
      if (delta !== current.deltaMinutes) {
        current.deltaMinutes = delta;
        setDrag({ ...current });
      }
    }
    function handleUp() {
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!current || !current.moved) return;
      skipClickRef.current = Date.now() + 400;
      if (current.deltaMinutes !== 0) {
        void commitDrag(current.kind, current.id, current.deltaMinutes);
      }
    }
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, ppm]);

  function beginDrag(event: ReactPointerEvent<HTMLElement>, kind: 'shift' | 'task', id: string) {
    if (event.button !== 0) return;
    const current = { kind, id, originX: event.clientX, deltaMinutes: 0, moved: false };
    dragRef.current = current;
    setDrag({ ...current });
  }

  async function commitDrag(kind: 'shift' | 'task', id: string, deltaMinutes: number) {
    try {
      if (kind === 'task') {
        const task = taskById.get(id);
        if (!task) return;
        const duration = (new Date(task.end_at).getTime() - new Date(task.start_at).getTime()) / 60000;
        const start = clamp(minutesIntoDay(task.start_at, selectedDate) + deltaMinutes, 0, 24 * 60 - duration);
        await onUpdateTask({
          taskId: task.id,
          title: task.title,
          description: task.description ?? '',
          startAt: isoAtMinutes(selectedDate, start),
          endAt: isoAtMinutes(selectedDate, start + duration),
          workAreaId: task.work_area_id,
          shiftId: task.shift_id,
          priority: task.priority,
          status: task.status
        });
        setNotice({ text: `Moved “${task.title}” to ${minutesToHHMM(Math.round(start))}.`, tone: 'ok' });
      } else {
        const shift = shifts.find((item) => item.id === id);
        if (!shift || !shift.employee_id) return;
        const duration = (new Date(shift.end_at).getTime() - new Date(shift.start_at).getTime()) / 60000;
        const start = clamp(minutesIntoDay(shift.start_at, selectedDate) + deltaMinutes, 0, 24 * 60 - duration);
        await onUpsertShift({
          shiftId: shift.id,
          employeeId: shift.employee_id,
          workAreaId: shift.work_area_id,
          startAt: isoAtMinutes(selectedDate, start),
          endAt: isoAtMinutes(selectedDate, start + duration),
          status: shift.status,
          breakMinutes: shift.break_minutes,
          notes: shift.notes ?? '',
          actorId
        });
        setNotice({ text: `Moved shift to ${minutesToHHMM(Math.round(start))}.`, tone: 'ok' });
      }
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not move that item.', tone: 'warn' });
    }
  }

  function openCreateShift(employeeId: string, minutes: number) {
    const rounded = Math.round(clamp(minutes, 0, 23 * 60) / 30) * 30;
    const end = Math.min(rounded + 8 * 60, 24 * 60 - 1);
    const employeeShifts = shiftsByEmployee.get(employeeId) ?? [];
    const areaId = employeeShifts.find((shift) => shift.work_area_id)?.work_area_id ?? '';
    setFormError(null);
    setShiftDraft({
      employeeId,
      workAreaId: areaId,
      startAt: toDateInputValue(isoAtMinutes(selectedDate, rounded)),
      endAt: toDateInputValue(isoAtMinutes(selectedDate, end)),
      status: 'scheduled',
      breakMinutes: defaultShiftBreakMinutes,
      notes: ''
    });
  }

  function openEditShift(shift: ShiftRow) {
    setFormError(null);
    setShiftDraft({
      shiftId: shift.id,
      employeeId: shift.employee_id ?? '',
      workAreaId: shift.work_area_id ?? '',
      startAt: toDateInputValue(shift.start_at),
      endAt: toDateInputValue(shift.end_at),
      status: shift.status,
      breakMinutes: shift.break_minutes,
      notes: shift.notes ?? ''
    });
  }

  function openTask(taskId: string, employeeId = '') {
    const task = taskById.get(taskId);
    if (!task) return;
    setFormError(null);
    setTaskDraft({
      taskId: task.id,
      employeeId,
      title: task.title,
      description: task.description ?? '',
      startAt: toDateInputValue(task.start_at),
      endAt: toDateInputValue(task.end_at),
      workAreaId: task.work_area_id ?? '',
      priority: task.priority,
      status: task.status
    });
  }

  function openCreateTask(employeeId = '', minutes?: number) {
    const start = minutes ?? Math.max(0, Math.round(nowMinutes / 30) * 30);
    setFormError(null);
    setTaskDraft({
      employeeId,
      title: '',
      description: '',
      startAt: toDateInputValue(isoAtMinutes(selectedDate, start)),
      endAt: toDateInputValue(isoAtMinutes(selectedDate, Math.min(start + 60, 24 * 60 - 1))),
      workAreaId: '',
      priority: 'normal',
      status: 'pending'
    });
  }

  function startNote(target: string) {
    setNoteTarget(target);
    setNoteError(null);
    requestAnimationFrame(() => {
      const node = noteInputRef.current;
      if (!node) return;
      node.scrollIntoView({ block: 'nearest' });
      node.focus();
    });
  }

  async function addBoardNote() {
    const body = noteBody.trim();
    if (!body || noteBusy) return;
    setNoteBusy(true);
    setNoteError(null);
    const [targetKind, targetId] = noteTarget.split(':');
    try {
      await onCreateBoardNote({
        body,
        isPublic: notePublic,
        date: selectedDate,
        employeeId: targetKind === 'employee' ? targetId : null,
        workAreaId: targetKind === 'area' ? targetId : null
      });
      setNoteBody('');
      setNotePublic(false);
      setNoteTarget('');
    } catch (error) {
      setNoteError(error instanceof Error ? error.message : 'Could not save the note.');
    } finally {
      setNoteBusy(false);
    }
  }

  async function removeBoardNote(noteId: string) {
    if (noteBusyId) return;
    setNoteBusyId(noteId);
    setNoteError(null);
    try {
      await onDeleteBoardNote(noteId);
    } catch (error) {
      setNoteError(error instanceof Error ? error.message : 'Could not delete the note.');
    } finally {
      setNoteBusyId(null);
    }
  }

  function renderNoteStrips(notes: BoardNoteRow[], scope: 'employee' | 'area') {
    if (!notes.length) return null;
    return notes.map((note) => {
      const expanded = expandedNoteId === note.id;
      return (
        <div key={note.id} className={`rs-note-strip ${scope}`}>
          <div className="rs-note-strip-gutter" style={{ width: LEFT_WIDTH }}>
            <span className="rs-note-strip-tag">{scope === 'area' ? 'Area note' : 'Note'}</span>
          </div>
          <div
            className="rs-note-strip-track"
            style={{ width: gridWidth, backgroundSize: `${gridWidth / 24}px 100%, 100% 100%` }}
          >
            <div className={`rs-note-strip-card ${note.is_public ? 'public' : 'private'}${expanded ? ' expanded' : ''}`}>
              <button
                type="button"
                className="rs-note-strip-main"
                title={expanded ? 'Collapse this note' : 'Show the whole note'}
                onClick={() => setExpandedNoteId(expanded ? null : note.id)}
              >
                <span className={`rs-note-strip-vis ${note.is_public ? 'public' : 'private'}`}>
                  {note.is_public ? 'Kiosk' : 'Only you'}
                </span>
                <span className="rs-note-strip-text">{note.body}</span>
                <span className="rs-note-strip-meta">
                  {note.author_name || 'Unknown'} · {toTimeHHMM(note.created_at)}
                </span>
              </button>
              {note.created_by === actorId ? (
                <button
                  type="button"
                  className="rs-note-strip-delete"
                  title="Delete note"
                  disabled={noteBusyId === note.id}
                  onClick={() => void removeBoardNote(note.id)}
                >
                  ×
                </button>
              ) : null}
            </div>
          </div>
        </div>
      );
    });
  }

  function openMenu(event: MouseEvent<HTMLElement>, target: MenuTarget) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ ...target, x: event.clientX, y: event.clientY });
  }

  function reportMenuError(error: unknown, fallback: string) {
    setNotice({ text: error instanceof Error ? error.message : fallback, tone: 'warn' });
  }

  async function setTaskStatus(task: TaskRow, status: TaskStatus) {
    try {
      await onUpdateTask({
        taskId: task.id,
        title: task.title,
        description: task.description ?? '',
        startAt: task.start_at,
        endAt: task.end_at,
        workAreaId: task.work_area_id,
        shiftId: task.shift_id,
        priority: task.priority,
        status
      });
      setNotice({ text: `“${task.title}” marked ${TASK_STATUS_LABEL[status]}.`, tone: 'ok' });
    } catch (error) {
      reportMenuError(error, 'Could not update that task.');
    }
  }

  async function unassignTask(task: TaskRow) {
    try {
      await onUnassignTaskAssignment(task.id);
      setNotice({ text: `“${task.title}” moved to unassigned tasks.`, tone: 'ok' });
    } catch (error) {
      reportMenuError(error, 'Could not unassign that task.');
    }
  }

  async function removeTask(task: TaskRow) {
    try {
      await onDeleteTask(task.id);
      setNotice({ text: `Deleted “${task.title}”.`, tone: 'ok' });
    } catch (error) {
      reportMenuError(error, 'Could not delete that task.');
    }
  }

  async function toggleClock(shift: ShiftRow) {
    try {
      if (shift.clocked_in_at) {
        await onClockOutShift(shift.id, actorId);
        setNotice({ text: 'Shift clocked out.', tone: 'ok' });
      } else {
        await onClockInShift(shift.id, actorId);
        setNotice({ text: 'Shift clocked in.', tone: 'ok' });
      }
    } catch (error) {
      reportMenuError(error, 'Could not update the shift clock state.');
    }
  }

  async function assignBreak(shift: ShiftRow) {
    try {
      await onAssignBreak(shift.id, shift.break_minutes, shift.notes ?? '');
      setNotice({ text: `Break task assigned (${shift.break_minutes} min).`, tone: 'ok' });
    } catch (error) {
      reportMenuError(error, 'Could not assign the break task.');
    }
  }

  async function removeShift(shift: ShiftRow) {
    try {
      await onDeleteShift(shift.id);
      setNotice({ text: 'Shift deleted.', tone: 'ok' });
    } catch (error) {
      reportMenuError(error, 'Could not delete that shift.');
    }
  }

  function changeZoom(delta: number) {
    if (!onTimelineWindowChange) return;
    const index = TIMELINE_ZOOM_LEVELS.indexOf(timelineWindowHours);
    const next = TIMELINE_ZOOM_LEVELS[clamp(index + delta, 0, TIMELINE_ZOOM_LEVELS.length - 1)];
    if (next !== timelineWindowHours) onTimelineWindowChange(next);
  }

  function zoomIn() {
    changeZoom(-1);
  }

  function zoomOut() {
    changeZoom(1);
  }

  const canZoomIn = Boolean(onTimelineWindowChange) && timelineWindowHours !== TIMELINE_ZOOM_LEVELS[0];
  const canZoomOut = Boolean(onTimelineWindowChange) && timelineWindowHours !== TIMELINE_ZOOM_LEVELS[TIMELINE_ZOOM_LEVELS.length - 1];

  // A no-task window has to sit inside an existing shift, so the draft picks the
  // shift that covers the requested minute (or the employee's first shift).
  function openNullificationDraft(employeeId: string, startMinutes: number, minutes = 30) {
    const employeeShifts = shiftsByEmployee.get(employeeId) ?? [];
    const covering = employeeShifts.find((shift) => {
      const start = minutesIntoDay(shift.start_at, selectedDate);
      const end = minutesIntoDay(shift.end_at, selectedDate);
      return startMinutes >= start && startMinutes < end;
    });
    const target = covering ?? employeeShifts[0];
    if (!target) {
      setNotice({ text: 'That employee has no shift to attach a no-task window to.', tone: 'warn' });
      return;
    }
    const shiftStart = minutesIntoDay(target.start_at, selectedDate);
    const shiftEnd = minutesIntoDay(target.end_at, selectedDate);
    const start = Math.round(clamp(Math.max(startMinutes, shiftStart), shiftStart, shiftEnd - 10) / 5) * 5;
    const end = Math.min(Math.round(clamp(start + minutes, start + 10, shiftEnd) / 5) * 5, shiftEnd);
    setFormError(null);
    setNullificationDraft({
      employeeId,
      shiftId: target.id,
      shiftLabel: `${toTimeHHMM(target.start_at)}–${toTimeHHMM(target.end_at)}`,
      startAt: toDateInputValue(isoAtMinutes(selectedDate, start)),
      endAt: toDateInputValue(isoAtMinutes(selectedDate, end)),
      reason: ''
    });
  }

  async function decideNullification(row: TimeNullificationRow, status: 'approved' | 'denied') {
    try {
      await onReviewTimeNullification({ requestId: row.id, status });
      setNotice({
        text: `${status === 'approved' ? 'Approved' : 'Denied'} no-task time ${toTimeHHMM(row.start_at)}–${toTimeHHMM(row.end_at)}.`,
        tone: 'ok'
      });
    } catch (error) {
      reportMenuError(error, 'Could not update that no-task request.');
    }
  }

  async function removeNullification(row: TimeNullificationRow) {
    try {
      await onDeleteTimeNullification(row.id);
      setNotice({ text: 'No-task window removed.', tone: 'ok' });
    } catch (error) {
      reportMenuError(error, 'Could not remove that no-task window.');
    }
  }

  function buildMenu(): { title: string; subtitle?: string; items: MenuEntry[] } | null {
    if (!menu) return null;

    if (menu.kind === 'task') {
      const task = menu.taskId ? taskById.get(menu.taskId) : undefined;
      if (!task) return null;
      const assignment = taskAssignments.find((item) => item.task_id === task.id);
      const assignee = assignment ? employees.find((employee) => employee.id === assignment.employee_id) : undefined;
      const employeeId = menu.employeeId ?? assignment?.employee_id ?? '';
      const items: MenuEntry[] = [
        { kind: 'item', label: 'Edit task…', onSelect: () => openTask(task.id, employeeId) },
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Mark in progress',
          disabled: task.status === 'in_progress',
          onSelect: () => void setTaskStatus(task, 'in_progress')
        },
        {
          kind: 'item',
          label: 'Mark complete',
          disabled: task.status === 'done',
          onSelect: () => void setTaskStatus(task, 'done')
        },
        {
          kind: 'item',
          label: 'Reopen task',
          disabled: task.status === 'pending',
          onSelect: () => void setTaskStatus(task, 'pending')
        },
        {
          kind: 'item',
          label: 'Cancel task',
          disabled: task.status === 'cancelled',
          onSelect: () => void setTaskStatus(task, 'cancelled')
        }
      ];
      if (assignment) {
        items.push(
          { kind: 'separator' },
          {
            kind: 'item',
            label: assignee ? `Unassign from ${assignee.full_name || assignee.email}` : 'Unassign task',
            onSelect: () => void unassignTask(task)
          }
        );
      }
      items.push({ kind: 'separator' }, { kind: 'item', label: 'Delete task', danger: true, onSelect: () => void removeTask(task) });
      return {
        title: task.title,
        subtitle: [task.priority, TASK_STATUS_LABEL[task.status], assignee ? assignee.full_name || assignee.email : 'Unassigned']
          .filter(Boolean)
          .join(' · '),
        items
      };
    }

    if (menu.kind === 'shift') {
      const shift = shifts.find((item) => item.id === menu.shiftId);
      if (!shift) return null;
      const employee = employees.find((item) => item.id === shift.employee_id);
      const area = shift.work_area_id ? workAreaById.get(shift.work_area_id) : undefined;
      return {
        title: employee ? employee.full_name || employee.email : 'Shift',
        subtitle: [
          `${toTimeHHMM(shift.start_at)}–${toTimeHHMM(shift.end_at)}`,
          area?.name ?? 'No work area',
          shift.status.replace('_', ' ')
        ].join(' · '),
        items: [
          { kind: 'item', label: 'Edit shift…', onSelect: () => openEditShift(shift) },
          {
            kind: 'item',
            label: shift.clocked_in_at ? 'Clock out' : 'Clock in',
            detail: shift.clocked_in_at ? `In at ${toTimeHHMM(shift.clocked_in_at)}` : undefined,
            onSelect: () => void toggleClock(shift)
          },
          {
            kind: 'item',
            label: 'Assign break task',
            detail: `${shift.break_minutes} min`,
            onSelect: () => void assignBreak(shift)
          },
          {
            kind: 'item',
            label: 'Block task time…',
            detail: shift.employee_id ? 'no tasks' : 'unassigned',
            disabled: !shift.employee_id,
            onSelect: () =>
              shift.employee_id &&
              openNullificationDraft(shift.employee_id, minutesIntoDay(shift.start_at, selectedDate))
          },
          { kind: 'separator' },
          { kind: 'item', label: 'Delete shift', danger: true, onSelect: () => void removeShift(shift) }
        ]
      };
    }

    if (menu.kind === 'nullification') {
      const row = timeNullifications.find((item) => item.id === menu.nullificationId);
      if (!row) return null;
      const employee = employees.find((item) => item.id === row.employee_id);
      const items: MenuEntry[] = [];
      if (row.status === 'pending') {
        items.push(
          { kind: 'item', label: 'Approve request', detail: 'blocks tasks', onSelect: () => void decideNullification(row, 'approved') },
          { kind: 'item', label: 'Deny request', onSelect: () => void decideNullification(row, 'denied') }
        );
      }
      items.push({
        kind: 'item',
        label: row.status === 'pending' ? 'Cancel request' : 'Remove no-task window',
        danger: true,
        onSelect: () => void removeNullification(row)
      });
      return {
        title: employee?.full_name || employee?.email || 'No-task window',
        subtitle: `${toTimeHHMM(row.start_at)}–${toTimeHHMM(row.end_at)} · ${row.status}${row.reviewer_name ? ` · ${row.reviewer_name}` : ''}`,
        items
      };
    }

    if (menu.kind === 'slot') {
      const employee = employees.find((item) => item.id === menu.employeeId);
      if (!employee) return null;
      const minutes = Math.round(clamp(menu.minutes ?? nowMinutes, 0, 23 * 60) / 15) * 15;
      const items: MenuEntry[] = [];
      if (showShifts) {
        items.push({ kind: 'item', label: `New shift at ${minutesToHHMM(minutes)}`, onSelect: () => openCreateShift(employee.id, minutes) });
      }
      if (showTasks) {
        items.push({ kind: 'item', label: `New task at ${minutesToHHMM(minutes)}`, onSelect: () => openCreateTask(employee.id, minutes) });
      }
      const employeeShifts = shiftsByEmployee.get(employee.id) ?? [];
      const shiftCovers = employeeShifts.some((shift) => {
        const start = minutesIntoDay(shift.start_at, selectedDate);
        const end = minutesIntoDay(shift.end_at, selectedDate);
        return minutes >= start && minutes < end;
      });
      if (showTasks) {
        items.push({
          kind: 'item',
          label: `Block task time from ${minutesToHHMM(minutes)}…`,
          detail: shiftCovers ? 'no tasks' : 'no shift here',
          disabled: !shiftCovers,
          onSelect: () => openNullificationDraft(employee.id, minutes)
        });
      }
      const employeePending = (nullificationsByEmployee.get(employee.id) ?? []).filter((row) => row.status === 'pending');
      if (employeePending.length > 0) {
        const [next] = employeePending;
        items.push({
          kind: 'item',
          label: `Approve no-task request ${toTimeHHMM(next.start_at)}–${toTimeHHMM(next.end_at)}`,
          detail: employeePending.length > 1 ? `+${employeePending.length - 1} more` : undefined,
          onSelect: () => void decideNullification(next, 'approved')
        });
      }
      items.push(
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Message…',
          onSelect: () => {
            setFormError(null);
            setMessageDraft({ employeeId: employee.id, subject: '', message: '' });
          }
        },
        {
          kind: 'item',
          label: 'Note task…',
          onSelect: () => {
            setFormError(null);
            setNoteDraft({ employeeId: employee.id, note: '' });
          }
        },
        {
          kind: 'item',
          label: `Board note about ${employee.full_name || employee.email}…`,
          onSelect: () => startNote(`employee:${employee.id}`)
        }
      );
      return {
        title: employee.full_name || employee.email,
        subtitle: `${selectedDate} · ${minutesToHHMM(minutes)}`,
        items
      };
    }

    if (menu.kind === 'area') {
      const area = menu.workAreaId ? workAreaById.get(menu.workAreaId) : undefined;
      if (!area) return null;
      return {
        title: area.name,
        subtitle: `${selectedDate} · work area`,
        items: [
          { kind: 'item', label: `Board note about ${area.name}…`, onSelect: () => startNote(`area:${area.id}`) },
          { kind: 'separator' },
          { kind: 'item', label: 'Scroll to current time', onSelect: scrollToNow }
        ]
      };
    }

    const filtersActive = taskStatusFilter !== 'all' || taskPriorityFilter !== 'all' || taskSearch.trim().length > 0;
    const boardItems: MenuEntry[] = [];
    if (showShifts) {
      boardItems.push({
        kind: 'item',
        label: 'New shift…',
        disabled: !employees.length,
        onSelect: () => openCreateShift(employees[0]?.id ?? '', nowMinutes)
      });
    }
    if (showTasks) {
      boardItems.push({
        kind: 'item',
        label: 'New task…',
        disabled: !employees.length,
        onSelect: () => openCreateTask()
      });
    }
    boardItems.push({
      kind: 'item',
      label: 'New work area…',
      onSelect: () => {
        setFormError(null);
        setAreaDraft({ name: '', description: '', color: WORK_AREA_COLORS[0] });
      }
    });
    boardItems.push(
      { kind: 'item', label: 'Board note…', onSelect: () => startNote('') },
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'Zoom in',
        detail: `${timelineWindowHours}h`,
        disabled: !canZoomIn,
        onSelect: zoomIn
      },
      {
        kind: 'item',
        label: 'Zoom out',
        detail: `${timelineWindowHours}h`,
        disabled: !canZoomOut,
        onSelect: zoomOut
      },
      {
        kind: 'item',
        label: 'Reset zoom',
        detail: '8h',
        disabled: timelineWindowHours === 8 || !onTimelineWindowChange,
        onSelect: () => onTimelineWindowChange?.(8)
      },
      { kind: 'separator' },
      { kind: 'item', label: 'Scroll to current time', onSelect: scrollToNow }
    );
    if (filtersActive) {
      boardItems.push({
        kind: 'item',
        label: 'Reset task filters',
        onSelect: () => {
          setTaskSearch('');
          setTaskStatusFilter('all');
          setTaskPriorityFilter('all');
        }
      });
    }
    return { title: 'Operations board', subtitle: `${selectedDate} · right-click actions`, items: boardItems };
  }

  async function run(action: () => Promise<void>, close?: () => void) {
    if (formBusy) return;
    setFormBusy(true);
    setFormError(null);
    try {
      await action();
      close?.();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Request failed.');
    } finally {
      setFormBusy(false);
    }
  }

  function shiftClickMinutes(event: MouseEvent<HTMLDivElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    return clamp((event.clientX - rect.left) / ppm, 0, 1439);
  }

  function scrollToNow() {
    const node = scrollRef.current;
    if (!node) return;
    const minutes = selectedDate === todayKey()
      ? (nowDate.getTime() - dayStart(selectedDate).getTime()) / 60000
      : 8 * 60;
    node.scrollLeft = Math.max(0, minutes * ppm - node.clientWidth / 3);
  }

  const menuView = buildMenu();

  return (
    <section className="rs-board">
      <div className="rs-board-toolbar">
        <div className="rs-board-toolbar-group">
          <strong className="rs-board-title">Operations Board</strong>
        </div>
        <div className="rs-board-toolbar-group rs-employee-filter">
          <input
            type="search"
            placeholder="Find employee..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {onShiftFilterChange ? (
            <select
              aria-label="Employee shift filter"
              value={shiftFilter}
              onChange={(event) => onShiftFilterChange(event.target.value)}
            >
              <option value="all">All Employees</option>
              <option value="current_future">Current + Future</option>
              <option value="future">Future Only</option>
              <option value="06">Early (06:00+)</option>
              <option value="08">Morning (08:00+)</option>
              <option value="10">Midday (10:00+)</option>
              <option value="12">Afternoon (12:00+)</option>
            </select>
          ) : null}
        </div>
        <div className="rs-board-toolbar-group">
          {showShifts ? (
            <button type="button" onClick={() => openCreateShift(employees[0]?.id ?? '', nowMinutes)} disabled={!employees.length}>
              Add Shift
            </button>
          ) : null}
          <button
            type="button"
            title="Create a work area"
            onClick={() => { setFormError(null); setAreaDraft({ name: '', description: '', color: '#1f56b9' }); }}
          >
            New Area
          </button>
          <button type="button" title="Scroll to the current time" onClick={scrollToNow}>
            Now
          </button>
          <div className="rs-zoom" role="group" aria-label="Timeline zoom">
            <button type="button" onClick={zoomOut} disabled={!canZoomOut} title="Zoom out (Ctrl + scroll)">
              −
            </button>
            <span className="rs-zoom-label" title="Visible hours across the board">
              {timelineWindowHours === 24 ? 'Full day' : `${timelineWindowHours}h`}
            </span>
            <button type="button" onClick={zoomIn} disabled={!canZoomIn} title="Zoom in (Ctrl + scroll)">
              +
            </button>
            <button
              type="button"
              className="rs-zoom-reset"
              onClick={() => onTimelineWindowChange?.(8)}
              disabled={!onTimelineWindowChange || timelineWindowHours === 8}
              title="Reset zoom to 8 hours"
            >
              Reset
            </button>
          </div>
        </div>
        {showTasks ? (
          <div className="rs-board-toolbar-group rs-task-filters" title="Task filters">
            <input
              type="search"
              placeholder="Filter tasks..."
              value={taskSearch}
              onChange={(event) => setTaskSearch(event.target.value)}
            />
            <select
              aria-label="Task status filter"
              value={taskStatusFilter}
              onChange={(event) => setTaskStatusFilter(event.target.value as 'all' | TaskStatus)}
            >
              <option value="all">All status</option>
              <option value="pending">Open</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select
              aria-label="Task priority filter"
              value={taskPriorityFilter}
              onChange={(event) => setTaskPriorityFilter(event.target.value as 'all' | TaskPriority)}
            >
              <option value="all">All priorities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
            <span className="rs-filter-count">{visibleTaskCount} task{visibleTaskCount === 1 ? '' : 's'}</span>
            <button type="button" onClick={() => openCreateTask()} disabled={!employees.length}>
              + Task
            </button>
          </div>
        ) : null}
        {onToggleFilter ? (
          <div className="rs-board-toolbar-group rs-view-toggles" title="Layers">
            <label title="Show shift lines per employee">
              <input
                type="checkbox"
                checked={filters.resources}
                onChange={() => onToggleFilter('resources')}
              />
              Areas
            </label>
            {showTasks ? (
              <label title="Show task pucks">
                <input type="checkbox" checked={filters.events} onChange={() => onToggleFilter('events')} />
                Tasks
              </label>
            ) : null}
            {showTasks ? (
              <label title="Show tasks that have no assignee">
                <input
                  type="checkbox"
                  checked={filters.unassigned}
                  onChange={() => onToggleFilter('unassigned')}
                />
                Unassigned
              </label>
            ) : null}
          </div>
        ) : null}
        <div className="rs-board-toolbar-group rs-board-help-group">
          {showTasks && pendingNullificationCount > 0 ? (
            <span className="rs-legend-pending">{pendingNullificationCount} pending</span>
          ) : null}
          <details className="rs-board-help">
            <summary aria-label="Legend and board tips" title="Legend and board tips">?</summary>
            <div className="rs-board-help-panel">
              <strong>Legend</strong>
              <ul>
                {showShifts ? <li><i className="rs-legend-line" />Shift window</li> : null}
                {showTasks ? <li><i className="rs-dot" style={{ background: '#2b6cb0' }} />Task</li> : null}
                {showTasks ? <li><i className="rs-dot" style={{ background: '#b02033' }} />Critical task</li> : null}
                {showShifts ? <li><i className="rs-legend-swatch" />Clock / ack issue</li> : null}
                {showShifts ? <li><i className="rs-legend-swatch pto" />Time off / leave</li> : null}
                {showShifts ? <li><i className="rs-legend-swatch suspension" />Suspension</li> : null}
                {showTasks ? <li><i className="rs-legend-swatch null-task" />No-task window</li> : null}
              </ul>
              <strong>Tips</strong>
              <p className="rs-board-hint">
                {showShifts
                  ? 'Drag a shift line or task puck to move it · click a row to add a shift · right-click anything for actions · Ctrl + scroll to zoom'
                  : 'Drag task pucks to move them · right-click for actions · Ctrl + scroll to zoom'}
              </p>
            </div>
          </details>
        </div>
      </div>

      {operationsAlerts.length > 0 ? (
        <section className="rs-operations-alerts" aria-label="Live operations alerts">
          <strong className="rs-operations-alert-count">{operationsAlerts.length} needs attention</strong>
          <div className="rs-operations-alert-list">
            {operationsAlerts.slice(0, 6).map((alert) => (
              <button
                key={alert.id}
                type="button"
                className={`rs-operations-alert ${alert.kind}`}
                title={`${alert.title} · ${alert.detail}. Click to locate on timeline.`}
                onClick={() => focusOperationsAlert(alert)}
              >
                <span>{OPERATIONS_ALERT_LABEL[alert.kind]}</span>
                <strong>{alert.title}</strong>
                <small>{alert.detail}</small>
              </button>
            ))}
            {operationsAlerts.length > 6 ? <span className="rs-operations-alert-more">+{operationsAlerts.length - 6} more</span> : null}
          </div>
        </section>
      ) : null}

      <div className="rs-board-body">
        <div className="rs-board-scroll" ref={scrollRef}>
          <div
            className="rs-board-canvas"
            style={{ width: LEFT_WIDTH + gridWidth + 2 }}
            onContextMenu={(event) => openMenu(event, { kind: 'board' })}
          >
            <div className="rs-board-head">
              <div className="rs-board-head-left" style={{ width: LEFT_WIDTH }}>Employee</div>
              <div className="rs-board-head-track" style={{ width: gridWidth }}>
                {Array.from({ length: 24 }, (_, hour) => (
                  <div
                    key={hour}
                    className="rs-hour-label"
                    style={{ left: `${(hour / 24) * 100}%`, width: `${100 / 24}%` }}
                  >
                    {minutesToHHMM(hour * 60)}
                  </div>
                ))}
              </div>
            </div>

            {groups.length === 0 ? (
              <p className="empty-state">No employees match this filter.</p>
            ) : null}

            {groups.map((group) => (
              <div key={group.key}>
                <div
                  className="rs-area-row"
                  onContextMenu={(event) =>
                    openMenu(
                      event,
                      group.area
                        ? { kind: 'area', workAreaId: group.area.id }
                        : { kind: 'board' }
                    )
                  }
                >
                  <div className="rs-area-label" style={{ width: LEFT_WIDTH }}>
                    {group.area?.name ?? 'Unassigned Work Area'}
                    <span>{group.employees.length}</span>
                  </div>
                  <div className="rs-area-track" style={{ width: gridWidth }} />
                </div>
                {group.area ? renderNoteStrips(notesByArea.get(group.area.id) ?? [], 'area') : null}

                {group.employees.map((employee) => {
                  const employeeShifts = shiftsByEmployee.get(employee.id) ?? [];
                  const employeeAssignments = assignmentsByEmployee.get(employee.id) ?? [];
                  const leave = leaveByEmployee.get(employee.id);
                  const gaps = shiftGaps(employeeShifts);
                  return (
                    <Fragment key={employee.id}>
                    <div
                      className="rs-row"
                      style={{ height: ROW_HEIGHT }}
                    >
                      <div
                        className="rs-row-label"
                        style={{ width: LEFT_WIDTH }}
                        onContextMenu={(event) => openMenu(event, { kind: 'slot', employeeId: employee.id, minutes: nowMinutes })}
                      >
                        <span className="rs-row-name">{employee.full_name || employee.email}</span>
                        <span className="rs-row-meta">
                          {leave ? (
                            <span className={`rs-row-leave kind-${leave.kind}`} title={leave.detail}>
                              {leave.label}
                            </span>
                          ) : null}
                          {employeeShifts.length > 0
                            ? `${toTimeHHMM(employeeShifts[0].start_at)}–${toTimeHHMM(employeeShifts[0].end_at)}${
                                employeeShifts.length > 1 ? ` +${employeeShifts.length - 1}` : ''
                              }`
                            : leave
                              ? 'On leave'
                              : 'No shift'}
                          {showTasks && employeeAssignments.length > 0
                            ? ` · ${employeeAssignments.length} task${employeeAssignments.length === 1 ? '' : 's'}`
                            : ''}
                        </span>
                        <span className="rs-row-actions">
                          <button type="button" title="Message" onClick={() => { setFormError(null); setMessageDraft({ employeeId: employee.id, subject: '', message: '' }); }}>✉</button>
                          <button type="button" title="Add note task" onClick={() => { setFormError(null); setNoteDraft({ employeeId: employee.id, note: '' }); }}>✎</button>
                          {showTasks ? (
                            <button type="button" title="Assign a task" onClick={() => openCreateTask(employee.id, nowMinutes)}>✓</button>
                          ) : null}
                          {showShifts ? (
                            <button type="button" title="Add shift" onClick={() => openCreateShift(employee.id, nowMinutes)}>＋</button>
                          ) : null}
                        </span>
                      </div>

                      <div
                        className="rs-row-track"
                        style={{
                          width: gridWidth,
                          backgroundSize: `${gridWidth / 24}px 100%, ${gridWidth / 48}px 100%`
                        }}
                        onClick={(event) => {
                          if (!showShifts) return;
                          if ((event.target as HTMLElement).closest('.rs-bar')) return;
                          openCreateShift(employee.id, shiftClickMinutes(event));
                        }}
                        onContextMenu={(event) => {
                          if (!showShifts && !showTasks) return;
                          openMenu(event, { kind: 'slot', employeeId: employee.id, minutes: shiftClickMinutes(event) });
                        }}
                      >
                        {leave ? (
                          <span
                            className={`rs-leave-band kind-${leave.kind}`}
                            aria-hidden="true"
                            title={leave.detail}
                          />
                        ) : null}

                        {showShifts ? gaps.map((gap) => (
                          <span
                            key={gap.key}
                            className="rs-shift-gap"
                            style={{ left: gap.left * ppm, width: gap.width * ppm }}
                            title={gap.label}
                            aria-hidden="true"
                          />
                        )) : null}

                        {isToday ? (
                          <span className="rs-now-line" style={{ left: nowMinutes * ppm }} />
                        ) : null}

                        {showShifts ? employeeShifts.map((shift) => {
                          const start = clamp(minutesIntoDay(shift.start_at, selectedDate), 0, 1440);
                          const end = clamp(minutesIntoDay(shift.end_at, selectedDate), 0, 1440);
                          const width = Math.max(10, (end - start) * ppm);
                          const area = shift.work_area_id ? workAreaById.get(shift.work_area_id) : null;
                          const color = area?.color && /^#[0-9a-f]{6}$/i.test(area.color) ? area.color : '#1f56b9';
                          const alert = shiftAlert(shift, employeeAssignments);
                          const multiplier = Number(shift.pay_multiplier);
                          const overtime = shift.is_unscheduled_overtime || multiplier > 1;
                          const dragOffset = drag?.kind === 'shift' && drag.id === shift.id ? drag.deltaMinutes * ppm : 0;
                          return (
                            <button
                              key={shift.id}
                              type="button"
                              className={`rs-shift-line ${statusClass(shift.status)}${alert ? ` alert-${alert}` : ''}${width < 52 ? ' compact' : ''}${drag?.kind === 'shift' && drag.id === shift.id ? ' rs-dragging' : ''}`}
                              style={{ left: start * ppm + dragOffset, width, color }}
                              data-ops-shift-id={shift.id}
                              title={`${area?.name ?? 'No work area'} ${toTimeHHMM(shift.start_at)}–${toTimeHHMM(shift.end_at)} (${shift.status.replace('_', ' ')})${alert ? ` — ${SHIFT_ALERT_HINT[alert]}` : ''} — drag to move, right-click for actions`}
                              onPointerDown={(event) => beginDrag(event, 'shift', shift.id)}
                              onContextMenu={(event) => openMenu(event, { kind: 'shift', shiftId: shift.id })}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (Date.now() < skipClickRef.current) return;
                                openEditShift(shift);
                              }}
                            >
                              <span className="rs-shift-line-label">
                                <span className="rs-shift-line-time">
                                  {toTimeHHMM(shift.start_at)}–{toTimeHHMM(shift.end_at)}
                                </span>
                                {overtime ? (
                                  <span
                                    className="rs-shift-line-chip ot"
                                    title={`Overtime shift${shift.is_unscheduled_overtime ? ' (unscheduled)' : ''}${Number.isFinite(multiplier) ? ` — ${multiplier.toFixed(1)}x pay` : ''}`}
                                  >
                                    {Number.isFinite(multiplier) && multiplier > 1 ? `OT ${multiplier.toFixed(1)}x` : 'OT'}
                                  </span>
                                ) : null}
                                {alert ? (
                                  <span className={`rs-shift-line-chip alert ${alert}`}>{SHIFT_ALERT_LABEL[alert]}</span>
                                ) : null}
                                {shift.clocked_in_at ? <span className="rs-shift-line-chip">IN</span> : null}
                                {shift.shift_pool_claimed_at ? <span className="rs-shift-line-chip">POOL</span> : null}
                                {area ? <span className="rs-shift-line-area">{area.name}</span> : null}
                              </span>
                              <span className="rs-shift-line-band" aria-hidden="true" />
                              <span className="rs-shift-line-track" aria-hidden="true" />
                            </button>
                          );
                        }) : null}

                        {(nullificationsByEmployee.get(employee.id) ?? []).map((row) => {
                          const start = clamp(minutesIntoDay(row.start_at, selectedDate), 0, 1440);
                          const end = clamp(minutesIntoDay(row.end_at, selectedDate), 0, 1440);
                          const width = Math.max(6, (end - start) * ppm);
                          return (
                            <span
                              key={row.id}
                              className={`rs-null-band ${row.status}`}
                              style={{ left: start * ppm, width }}
                              data-ops-null-id={row.id}
                              role="button"
                              tabIndex={0}
                              title={`${row.status === 'pending' ? 'Requested' : 'Approved'} no-task time ${toTimeHHMM(row.start_at)}–${toTimeHHMM(row.end_at)}${row.reason ? ` — ${row.reason}` : ''}${row.reviewer_name ? ` (${row.reviewer_name})` : ''} — click or right-click for actions`}
                              onClick={(event) => openMenu(event, { kind: 'nullification', nullificationId: row.id })}
                              onContextMenu={(event) => openMenu(event, { kind: 'nullification', nullificationId: row.id })}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter' && event.key !== ' ') return;
                                event.preventDefault();
                                const rect = event.currentTarget.getBoundingClientRect();
                                setMenu({
                                  kind: 'nullification',
                                  nullificationId: row.id,
                                  x: rect.left,
                                  y: rect.bottom
                                });
                              }}
                            >
                              {width > 56 ? <small>{row.status === 'pending' ? 'Requested' : 'No tasks'}</small> : null}
                            </span>
                          );
                        })}

                        {showTasks && filters.events ? employeeAssignments.map((assignment) => {
                          const task = taskById.get(assignment.task_id);
                          if (!task || !taskVisible(task)) return null;
                          const start = clamp(minutesIntoDay(task.start_at, selectedDate), 0, 1440);
                          const end = clamp(minutesIntoDay(task.end_at, selectedDate), 0, 1440);
                          const width = Math.max(8, (end - start) * ppm);
                          const ackOverdue =
                            !assignment.acknowledged_at &&
                            task.status !== 'done' &&
                            task.status !== 'cancelled' &&
                            nowDate.getTime() > new Date(task.start_at).getTime() + TASK_ACK_WINDOW_MS;
                          const dragOffset = drag?.kind === 'task' && drag.id === task.id ? drag.deltaMinutes * ppm : 0;
                          return (
                            <button
                              key={assignment.id}
                              type="button"
                              className={`rs-bar rs-task-bar ${task.status}${ackOverdue ? ' ack-overdue' : ''}${drag?.kind === 'task' && drag.id === task.id ? ' rs-dragging' : ''}`}
                              style={{ left: start * ppm + dragOffset, width, background: priorityColor(task.priority) }}
                              data-ops-task-id={task.id}
                              title={`${task.title} (${task.priority}, ${task.status})${ackOverdue ? ' — acknowledgement overdue' : ''} — drag to move, right-click for actions`}
                              onPointerDown={(event) => beginDrag(event, 'task', task.id)}
                              onContextMenu={(event) => openMenu(event, { kind: 'task', taskId: task.id, employeeId: employee.id })}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (Date.now() < skipClickRef.current) return;
                                openTask(task.id, employee.id);
                              }}
                            >
                              <span className="rs-bar-label">{task.title}</span>
                              {!assignment.acknowledged_at ? <span className="rs-bar-flag warn">ACK</span> : null}
                            </button>
                          );
                        }) : null}
                      </div>
                    </div>
                    {renderNoteStrips(notesByEmployee.get(employee.id) ?? [], 'employee')}
                    </Fragment>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="rs-board-side">
          {showTasks && filters.unassigned ? (
          <aside className="rs-unassigned">
            <header>
              <strong>Unassigned Tasks</strong>
              <span>{unassignedTasks.length}</span>
            </header>
            <div className="rs-unassigned-list">
              {unassignedTasks.length === 0 ? (
                <p className="empty-state">Every task is assigned.</p>
              ) : unassignedTasks.map((task) => (
                <article
                  key={task.id}
                  className="rs-unassigned-item"
                  onContextMenu={(event) => openMenu(event, { kind: 'task', taskId: task.id, employeeId: '' })}
                >
                  <button type="button" className="rs-unassigned-title" onClick={() => openTask(task.id)}>
                    {task.title}
                  </button>
                  <p>
                    {toTimeHHMM(task.start_at)}–{toTimeHHMM(task.end_at)} · {task.priority}
                    {task.status !== 'pending' ? ` · ${task.status.replace('_', ' ')}` : ''}
                  </p>
                  <label>
                    Assign
                    <select
                      value=""
                      onChange={(event) => {
                        const employeeId = event.target.value;
                        if (!employeeId) return;
                        void run(() => onReassignTaskAssignment(task.id, employeeId));
                      }}
                    >
                      <option value="">Select employee…</option>
                      {employees.map((employee) => (
                        <option key={employee.id} value={employee.id}>{employee.full_name || employee.email}</option>
                      ))}
                    </select>
                  </label>
                </article>
              ))}
            </div>
            <footer>
              <button type="button" onClick={() => openCreateTask()}>New Task</button>
            </footer>
          </aside>
          ) : null}

          <aside className="rs-board-notes">
            <header>
              <strong>Board Notes</strong>
              <span>{boardNotes.length}</span>
            </header>
            <form
              className="rs-note-form"
              onSubmit={(event) => {
                event.preventDefault();
                void addBoardNote();
              }}
            >
              <select
                className="rs-note-target"
                aria-label="What the note is about"
                value={noteTarget}
                onChange={(event) => setNoteTarget(event.target.value)}
              >
                <option value="">About the whole board</option>
                {employees.length ? (
                  <optgroup label="About a person">
                    {employees.map((employee) => (
                      <option key={employee.id} value={`employee:${employee.id}`}>
                        {employee.full_name || employee.email}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {workAreas.length ? (
                  <optgroup label="About a work area">
                    {workAreas.map((area) => (
                      <option key={area.id} value={`area:${area.id}`}>{area.name}</option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <textarea
                ref={noteInputRef}
                rows={2}
                maxLength={1000}
                placeholder={`Add a note for ${selectedDate}…`}
                value={noteBody}
                onChange={(event) => setNoteBody(event.target.value)}
              />
              <div className="rs-note-form-row">
                <label className="rs-note-visibility">
                  <input
                    type="checkbox"
                    checked={notePublic}
                    onChange={(event) => setNotePublic(event.target.checked)}
                  />
                  Show on kiosk
                </label>
                <button type="submit" disabled={noteBusy || !noteBody.trim()}>
                  {noteBusy ? 'Saving…' : 'Add note'}
                </button>
              </div>
              {noteError ? <p className="rs-note-error">{noteError}</p> : null}
            </form>
            <div className="rs-note-list">
              {boardNotes.length === 0 ? (
                <p className="empty-state">No notes for this day.</p>
              ) : boardNotes.map((note) => (
                <article key={note.id} className={`rs-note ${note.is_public ? 'public' : 'private'}`}>
                  <div className="rs-note-meta">
                    <span className={`rs-note-badge ${note.is_public ? 'public' : 'private'}`}>
                      {note.is_public ? 'Kiosk' : 'Only you'}
                    </span>
                    <span>{note.author_name || 'Unknown'}</span>
                    <time>{toTimeHHMM(note.created_at)}</time>
                  </div>
                  {note.employee_name || note.work_area_name ? (
                    <span className="rs-note-target-label">
                      About {note.employee_name || note.work_area_name}
                    </span>
                  ) : null}
                  <p>{note.body}</p>
                  {note.created_by === actorId ? (
                    <button
                      type="button"
                      className="rs-note-delete"
                      disabled={noteBusyId === note.id}
                      onClick={() => void removeBoardNote(note.id)}
                    >
                      {noteBusyId === note.id ? 'Deleting…' : 'Delete'}
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
          </aside>
        </div>
      </div>

      {menu && menuView ? (
        <div
          ref={menuRef}
          className="rs-context-menu"
          role="menu"
          aria-label={menuView.title}
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <header className="rs-context-menu-head">
            <strong>{menuView.title}</strong>
            {menuView.subtitle ? <span>{menuView.subtitle}</span> : null}
          </header>
          <ul>
            {menuView.items.map((item, index) =>
              item.kind === 'separator' ? (
                <li key={`separator-${index}`} className="rs-context-separator" role="separator" />
              ) : (
                <li key={`${item.label}-${index}`}>
                  <button
                    type="button"
                    role="menuitem"
                    className={item.danger ? 'danger' : undefined}
                    disabled={item.disabled}
                    onClick={() => {
                      setMenu(null);
                      item.onSelect();
                    }}
                  >
                    <span>{item.label}</span>
                    {item.detail ? <em>{item.detail}</em> : null}
                  </button>
                </li>
              )
            )}
          </ul>
        </div>
      ) : null}

      {nullificationDraft ? (
        <div className="ops-editor-backdrop" onClick={() => setNullificationDraft(null)}>
          <form
            className="ops-editor-modal rs-null-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const startAt = fromDateInputValue(nullificationDraft.startAt);
                const endAt = fromDateInputValue(nullificationDraft.endAt);
                if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
                  throw new Error('The end time must be after the start time.');
                }
                await onCreateTimeNullification({
                  employeeId: nullificationDraft.employeeId,
                  shiftId: nullificationDraft.shiftId,
                  startAt,
                  endAt,
                  reason: nullificationDraft.reason,
                  approved: true
                });
                setNotice({ text: 'No-task window saved. Tasks cannot be assigned inside it.', tone: 'ok' });
              }, () => setNullificationDraft(null));
            }}
          >
            <header className="ops-editor-head">
              <h3>Block Task Time</h3>
              <button type="button" onClick={() => setNullificationDraft(null)}>Close</button>
            </header>
            <div className="ops-editor-body">
              <p className="rs-null-modal-subject" style={{ gridColumn: '1 / -1' }}>
                {employees.find((employee) => employee.id === nullificationDraft.employeeId)?.full_name ??
                  employees.find((employee) => employee.id === nullificationDraft.employeeId)?.email ??
                  'Employee'}
                {' · shift '}
                {nullificationDraft.shiftLabel}
              </p>
              <label>
                Start
                <input
                  type="datetime-local"
                  value={nullificationDraft.startAt}
                  onChange={(event) => setNullificationDraft({ ...nullificationDraft, startAt: event.target.value })}
                  required
                />
              </label>
              <label>
                End
                <input
                  type="datetime-local"
                  value={nullificationDraft.endAt}
                  onChange={(event) => setNullificationDraft({ ...nullificationDraft, endAt: event.target.value })}
                  required
                />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                Reason
                <textarea
                  rows={2}
                  placeholder="Why should no tasks land in this window?"
                  value={nullificationDraft.reason}
                  onChange={(event) => setNullificationDraft({ ...nullificationDraft, reason: event.target.value })}
                />
              </label>
              <p className="rs-task-assignment-hint" style={{ gridColumn: '1 / -1' }}>
                Approved immediately — the board will refuse task assignments that overlap this window.
              </p>
              {formError ? <p className="auth-error" style={{ gridColumn: '1 / -1' }}>{formError}</p> : null}
              <div className="ops-editor-actions" style={{ gridColumn: '1 / -1' }}>
                <button type="submit" disabled={formBusy}>{formBusy ? 'Saving…' : 'Block Time'}</button>
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {shiftDraft ? (
        <div className="ops-editor-backdrop" onClick={() => setShiftDraft(null)}>
          <form
            className="ops-editor-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await onUpsertShift({
                  shiftId: shiftDraft.shiftId,
                  employeeId: shiftDraft.employeeId,
                  workAreaId: shiftDraft.workAreaId || null,
                  startAt: fromDateInputValue(shiftDraft.startAt),
                  endAt: fromDateInputValue(shiftDraft.endAt),
                  status: shiftDraft.status,
                  breakMinutes: shiftDraft.breakMinutes,
                  notes: shiftDraft.notes,
                  actorId
                });
              }, () => setShiftDraft(null));
            }}
          >
            <header className="ops-editor-head">
              <h3>{shiftDraft.shiftId ? 'Edit Shift' : 'Create Shift'}</h3>
              <button type="button" onClick={() => setShiftDraft(null)}>Close</button>
            </header>
            <div className="ops-editor-body">
              <label>
                Employee
                <select
                  value={shiftDraft.employeeId}
                  onChange={(event) => setShiftDraft({ ...shiftDraft, employeeId: event.target.value })}
                  required
                >
                  <option value="">Select employee</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.full_name || employee.email}</option>
                  ))}
                </select>
              </label>
              <label>
                Work Area
                <select
                  value={shiftDraft.workAreaId}
                  onChange={(event) => setShiftDraft({ ...shiftDraft, workAreaId: event.target.value })}
                >
                  <option value="">No work area</option>
                  {workAreas.filter((area) => area.is_active).map((area) => (
                    <option key={area.id} value={area.id}>{area.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Start
                <input
                  type="datetime-local"
                  value={shiftDraft.startAt}
                  onChange={(event) => setShiftDraft({ ...shiftDraft, startAt: event.target.value })}
                  required
                />
              </label>
              <label>
                End
                <input
                  type="datetime-local"
                  value={shiftDraft.endAt}
                  onChange={(event) => setShiftDraft({ ...shiftDraft, endAt: event.target.value })}
                  required
                />
              </label>
              <label>
                Status
                <select
                  value={shiftDraft.status}
                  onChange={(event) => setShiftDraft({ ...shiftDraft, status: event.target.value as ShiftStatus })}
                >
                  <option value="scheduled">Scheduled</option>
                  <option value="on_duty">On Duty</option>
                  <option value="break">On Break</option>
                  <option value="off_shift">Off Shift</option>
                </select>
              </label>
              <label>
                Break minutes
                <input
                  type="number"
                  min={0}
                  value={shiftDraft.breakMinutes}
                  onChange={(event) => setShiftDraft({ ...shiftDraft, breakMinutes: Number(event.target.value) })}
                />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                Notes
                <textarea
                  rows={2}
                  value={shiftDraft.notes}
                  onChange={(event) => setShiftDraft({ ...shiftDraft, notes: event.target.value })}
                />
              </label>
              {formError ? <p className="auth-error" style={{ gridColumn: '1 / -1' }}>{formError}</p> : null}
              <div className="ops-editor-actions" style={{ gridColumn: '1 / -1' }}>
                <button type="submit" disabled={formBusy}>{formBusy ? 'Saving…' : 'Save Shift'}</button>
                {shiftDraft.shiftId ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void run(async () => {
                        const shift = shifts.find((item) => item.id === shiftDraft.shiftId);
                        if (!shift) return;
                        await onAssignBreak(shift.id, shiftDraft.breakMinutes, shiftDraft.notes);
                      })}
                    >
                      Assign Break Task
                    </button>
                    <button
                      type="button"
                      onClick={() => void run(async () => {
                        if (!shiftDraft.shiftId) return;
                        const shift = shifts.find((item) => item.id === shiftDraft.shiftId);
                        if (shift?.clocked_in_at) {
                          await onClockOutShift(shift.id, actorId);
                        } else {
                          await onClockInShift(shiftDraft.shiftId, actorId);
                        }
                        setShiftDraft(null);
                      })}
                    >
                      Clock In / Out
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void run(async () => {
                        if (!shiftDraft.shiftId) return;
                        await onDeleteShift(shiftDraft.shiftId);
                      }, () => setShiftDraft(null))}
                    >
                      Delete
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {taskDraft ? (
        <div className="ops-editor-backdrop" onClick={() => setTaskDraft(null)}>
          <form
            className="ops-editor-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const editingTaskId = taskDraft.taskId;
                if (editingTaskId) {
                  await onUpdateTask({
                    taskId: editingTaskId,
                    title: taskDraft.title,
                    description: taskDraft.description,
                    startAt: fromDateInputValue(taskDraft.startAt),
                    endAt: fromDateInputValue(taskDraft.endAt),
                    workAreaId: taskDraft.workAreaId || null,
                    shiftId: null,
                    priority: taskDraft.priority,
                    status: taskDraft.status
                  });
                  const currentAssignment = taskAssignments.find((assignment) => assignment.task_id === editingTaskId);
                  if (!taskDraft.employeeId) {
                    if (currentAssignment) await onUnassignTaskAssignment(editingTaskId);
                  } else if (currentAssignment?.employee_id !== taskDraft.employeeId) {
                    await onReassignTaskAssignment(editingTaskId, taskDraft.employeeId);
                  }
                } else {
                  await onAssignTask({
                    employeeId: taskDraft.employeeId,
                    title: taskDraft.title,
                    description: taskDraft.description,
                    startAt: fromDateInputValue(taskDraft.startAt),
                    endAt: fromDateInputValue(taskDraft.endAt),
                    workAreaId: taskDraft.workAreaId || null,
                    shiftId: null,
                    priority: taskDraft.priority
                  });
                }
              }, () => setTaskDraft(null));
            }}
          >
            <header className="ops-editor-head">
              <h3>{taskDraft.taskId ? 'Edit Task' : 'Create Task'}</h3>
              <button type="button" onClick={() => setTaskDraft(null)}>Close</button>
            </header>
            <div className="ops-editor-body">
              <label style={{ gridColumn: '1 / -1' }}>
                Title
                <input
                  value={taskDraft.title}
                  onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })}
                  required
                />
              </label>
              <label>
                Assign to
                <select
                  value={taskDraft.employeeId}
                  onChange={(event) => setTaskDraft({ ...taskDraft, employeeId: event.target.value })}
                >
                  <option value="">Unassigned</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.full_name || employee.email}</option>
                  ))}
                </select>
              </label>
              <label>
                Work Area
                <select
                  value={taskDraft.workAreaId}
                  onChange={(event) => setTaskDraft({ ...taskDraft, workAreaId: event.target.value })}
                >
                  <option value="">No work area</option>
                  {workAreas.filter((area) => area.is_active).map((area) => (
                    <option key={area.id} value={area.id}>{area.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Start
                <input
                  type="datetime-local"
                  value={taskDraft.startAt}
                  onChange={(event) => setTaskDraft({ ...taskDraft, startAt: event.target.value })}
                  required
                />
              </label>
              <label>
                End
                <input
                  type="datetime-local"
                  value={taskDraft.endAt}
                  onChange={(event) => setTaskDraft({ ...taskDraft, endAt: event.target.value })}
                  required
                />
              </label>
              <label>
                Priority
                <select
                  value={taskDraft.priority}
                  onChange={(event) => setTaskDraft({ ...taskDraft, priority: event.target.value as TaskPriority })}
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </label>
              <label>
                Status
                <select
                  value={taskDraft.status}
                  onChange={(event) => setTaskDraft({ ...taskDraft, status: event.target.value as TaskStatus })}
                >
                  <option value="pending">Open</option>
                  <option value="in_progress">In progress</option>
                  <option value="done">Done</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </label>
              {taskDraft.taskId ? (
                <p className="rs-task-assignment-hint">
                  Currently assigned to{' '}
                  {employees.find((employee) =>
                    (taskAssignments.find((assignment) => assignment.task_id === taskDraft.taskId)?.employee_id ?? '') === employee.id
                  )?.full_name ?? 'nobody'}
                </p>
              ) : null}
              <label style={{ gridColumn: '1 / -1' }}>
                Description
                <textarea
                  rows={2}
                  value={taskDraft.description}
                  onChange={(event) => setTaskDraft({ ...taskDraft, description: event.target.value })}
                />
              </label>
              {formError ? <p className="auth-error" style={{ gridColumn: '1 / -1' }}>{formError}</p> : null}
              <div className="ops-editor-actions" style={{ gridColumn: '1 / -1' }}>
                <button type="submit" disabled={formBusy}>{formBusy ? 'Saving…' : 'Save Task'}</button>
                {taskDraft.taskId ? (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void run(async () => {
                      if (!taskDraft.taskId) return;
                      await onDeleteTask(taskDraft.taskId);
                    }, () => setTaskDraft(null))}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {areaDraft ? (
        <div className="ops-editor-backdrop" onClick={() => setAreaDraft(null)}>
          <form
            className="ops-editor-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await onCreateWorkArea({
                  name: areaDraft.name.trim(),
                  description: areaDraft.description,
                  color: areaDraft.color,
                  createdBy: actorId
                });
                setAreaDraft(null);
              });
            }}
          >
            <header className="ops-editor-head">
              <h3>New Work Area</h3>
              <button type="button" onClick={() => setAreaDraft(null)}>Close</button>
            </header>
            <div className="ops-editor-body">
              <label>
                Name
                <input
                  value={areaDraft.name}
                  onChange={(event) => setAreaDraft({ ...areaDraft, name: event.target.value })}
                  required
                />
              </label>
              <label>
                Color
                <input
                  type="color"
                  value={areaDraft.color}
                  onChange={(event) => setAreaDraft({ ...areaDraft, color: event.target.value })}
                />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                Description
                <textarea
                  rows={2}
                  value={areaDraft.description}
                  onChange={(event) => setAreaDraft({ ...areaDraft, description: event.target.value })}
                />
              </label>
              {formError ? <p className="auth-error" style={{ gridColumn: '1 / -1' }}>{formError}</p> : null}
              <div className="ops-editor-actions" style={{ gridColumn: '1 / -1' }}>
                <button type="submit" disabled={formBusy}>{formBusy ? 'Saving…' : 'Create Work Area'}</button>
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {messageDraft ? (
        <div className="ops-editor-backdrop" onClick={() => setMessageDraft(null)}>
          <form
            className="ops-editor-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await onSendMessage({
                  recipientId: messageDraft.employeeId,
                  subject: messageDraft.subject,
                  message: messageDraft.message
                });
                setMessageDraft(null);
              });
            }}
          >
            <header className="ops-editor-head">
              <h3>Send Message</h3>
              <button type="button" onClick={() => setMessageDraft(null)}>Close</button>
            </header>
            <div className="ops-editor-body">
              <label>
                Employee
                <select
                  value={messageDraft.employeeId}
                  onChange={(event) => setMessageDraft({ ...messageDraft, employeeId: event.target.value })}
                >
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.full_name || employee.email}</option>
                  ))}
                </select>
              </label>
              <label>
                Subject
                <input
                  value={messageDraft.subject}
                  onChange={(event) => setMessageDraft({ ...messageDraft, subject: event.target.value })}
                />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                Message
                <textarea
                  rows={4}
                  value={messageDraft.message}
                  onChange={(event) => setMessageDraft({ ...messageDraft, message: event.target.value })}
                  required
                />
              </label>
              {formError ? <p className="auth-error" style={{ gridColumn: '1 / -1' }}>{formError}</p> : null}
              <div className="ops-editor-actions" style={{ gridColumn: '1 / -1' }}>
                <button type="submit" disabled={formBusy}>{formBusy ? 'Sending…' : 'Send'}</button>
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {noteDraft ? (
        <div className="ops-editor-backdrop" onClick={() => setNoteDraft(null)}>
          <form
            className="ops-editor-modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await onSendNoteTask({ employeeId: noteDraft.employeeId, note: noteDraft.note });
                setNoteDraft(null);
              });
            }}
          >
            <header className="ops-editor-head">
              <h3>Create Note Task</h3>
              <button type="button" onClick={() => setNoteDraft(null)}>Close</button>
            </header>
            <div className="ops-editor-body">
              <label style={{ gridColumn: '1 / -1' }}>
                Note
                <textarea
                  rows={3}
                  value={noteDraft.note}
                  onChange={(event) => setNoteDraft({ ...noteDraft, note: event.target.value })}
                  required
                />
              </label>
              {formError ? <p className="auth-error" style={{ gridColumn: '1 / -1' }}>{formError}</p> : null}
              <div className="ops-editor-actions" style={{ gridColumn: '1 / -1' }}>
                <button type="submit" disabled={formBusy || !noteDraft.note.trim()}>{formBusy ? 'Saving…' : 'Create Note'}</button>
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {notice ? <div className={`rs-board-notice ${notice.tone}`}>{notice.text}</div> : null}
      {busy ? <div className="rs-board-busy">Saving…</div> : null}
    </section>
  );
}
