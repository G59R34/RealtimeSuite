import { useMemo, useState } from 'react';
import {
  formatDateInput,
  formatDay,
  formatRange,
  formatShortDay,
  shiftMinutes,
  statusLabel
} from '../lib/format';
import { formatDuration } from '../lib/format';
import type { ActionKind, Workspace } from '../types';
import { Card, Empty, Field, Pill } from './ui';

type Tab = 'time_off' | 'overtime' | 'exception' | 'swap' | 'history';

const TABS: { id: Tab; label: string }[] = [
  { id: 'time_off', label: 'Time off' },
  { id: 'overtime', label: 'Overtime' },
  { id: 'exception', label: 'Exceptions' },
  { id: 'swap', label: 'Swaps' },
  { id: 'history', label: 'History' }
];

const TIME_OFF_TYPES = ['vacation', 'sick', 'personal', 'unpaid', 'other'];
const EXCEPTION_CODES = [
  { code: 'DO', label: 'Day off' },
  { code: 'VAUT', label: 'Vacation / authorized leave' },
  { code: 'NCNS', label: 'No call, no show' },
  { code: 'LTDR', label: 'Late / left early' }
];

interface Props {
  workspace: Workspace;
  onSubmit: (kind: ActionKind, payload: Record<string, unknown>) => Promise<void>;
}

type Entry = {
  id: string;
  type: string;
  title: string;
  detail: string;
  status: string;
  created: string | null;
};

export function RequestsView({ workspace, onSubmit }: Props) {
  const { employee, shifts, directory, timeOff, overtime, exceptions, swaps, actions } = workspace;
  const [tab, setTab] = useState<Tab>('time_off');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const todayInput = formatDateInput(today);

  const [timeOffStart, setTimeOffStart] = useState(formatDateInput(tomorrow));
  const [timeOffEnd, setTimeOffEnd] = useState(formatDateInput(tomorrow));
  const [timeOffType, setTimeOffType] = useState('vacation');
  const [timeOffReason, setTimeOffReason] = useState('');

  const [overtimeStart, setOvertimeStart] = useState(`${todayInput}T18:00`);
  const [overtimeEnd, setOvertimeEnd] = useState(`${todayInput}T22:00`);
  const [overtimeNote, setOvertimeNote] = useState('');

  const [exceptionCode, setExceptionCode] = useState('DO');
  const [exceptionStart, setExceptionStart] = useState(todayInput);
  const [exceptionEnd, setExceptionEnd] = useState(todayInput);
  const [exceptionTitle, setExceptionTitle] = useState('');
  const [exceptionDetails, setExceptionDetails] = useState('');

  const [swapShift, setSwapShift] = useState('');
  const [swapTarget, setSwapTarget] = useState('');
  const [swapNote, setSwapNote] = useState('');

  const upcomingShifts = useMemo(
    () =>
      shifts
        .filter(
          (shift) =>
            shift.employee_id === employee.id &&
            shift.status === 'scheduled' &&
            new Date(shift.start_at) > today
        )
        .sort((a, b) => a.start_at.localeCompare(b.start_at)),
    [shifts, employee.id, today]
  );

  const history = useMemo<Entry[]>(() => {
    const entries: Entry[] = [
      ...timeOff.map((request) => ({
        id: `time-off-${request.id}`,
        type: 'Time off',
        title: `${statusLabel(request.request_type)} time off`,
        detail: `${formatDay(request.start_date)} – ${formatDay(request.end_date)}`,
        status: request.status,
        created: request.created_at_local
      })),
      ...overtime.map((request) => ({
        id: `overtime-${request.id}`,
        type: 'Overtime',
        title: `${statusLabel(request.overtime_type)} overtime`,
        detail: `${formatShortDay(request.start_at)} · ${formatRange(request.start_at, request.end_at)}`,
        status: request.status,
        created: request.created_at_local
      })),
      ...exceptions.map((request) => ({
        id: `exception-${request.id}`,
        type: 'Exception',
        title: request.title || `${request.exception_code} request`,
        detail: `${formatDay(request.start_date)} – ${formatDay(request.end_date)}`,
        status: request.status,
        created: request.created_at_local
      })),
      ...swaps.map((request) => ({
        id: `swap-${request.id}`,
        type: 'Swap',
        title: 'Shift swap',
        detail: request.shift_start_at ? formatShortDay(request.shift_start_at) : 'Shift',
        status: request.status,
        created: request.created_at_local
      })),
      ...actions
        .filter((action) => action.kind.endsWith('.create'))
        .map((action) => ({
          id: `action-${action.id}`,
          type: 'Queued',
          title: `${statusLabel(action.kind.split('.')[0])} request`,
          detail: action.result ?? action.error ?? 'Waiting for your site to apply it',
          status: action.status,
          created: action.requested_at
        }))
    ];
    return entries.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));
  }, [timeOff, overtime, exceptions, swaps, actions]);

  async function run(
    kind: ActionKind,
    payload: Record<string, unknown>,
    key: string,
    reset: () => void
  ) {
    setBusy(key);
    setError(null);
    try {
      await onSubmit(kind, payload);
      reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That request did not go through.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="requests-tabs" role="tablist" aria-label="Request types">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && <p className="form-error">{error}</p>}

      {tab === 'time_off' && (
        <Card title="Request time off" hint="Your manager reviews it in RealtimeSuite; you will see the answer here.">
          <div className="form-grid">
            <Field label="First day">
              <input
                type="date"
                value={timeOffStart}
                min={todayInput}
                onChange={(event) => {
                  setTimeOffStart(event.target.value);
                  if (event.target.value > timeOffEnd) setTimeOffEnd(event.target.value);
                }}
              />
            </Field>
            <Field label="Last day">
              <input
                type="date"
                value={timeOffEnd}
                min={timeOffStart}
                onChange={(event) => setTimeOffEnd(event.target.value)}
              />
            </Field>
            <Field label="Type">
              <select value={timeOffType} onChange={(event) => setTimeOffType(event.target.value)}>
                {TIME_OFF_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {statusLabel(type)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason" hint="Optional, but helpful for your manager.">
              <textarea
                rows={2}
                value={timeOffReason}
                onChange={(event) => setTimeOffReason(event.target.value)}
                placeholder="Family trip, appointment…"
              />
            </Field>
          </div>
          <button
            className="btn primary"
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run(
                'time_off.create',
                {
                  start_date: timeOffStart,
                  end_date: timeOffEnd,
                  request_type: timeOffType,
                  reason: timeOffReason
                },
                'time-off',
                () => setTimeOffReason('')
              )
            }
          >
            {busy === 'time-off' ? 'Sending…' : 'Send request'}
          </button>
        </Card>
      )}

      {tab === 'overtime' && (
        <Card title="Request overtime" hint="Pick the window you can work; approval creates the shift.">
          <div className="form-grid">
            <Field label="Starts">
              <input
                type="datetime-local"
                value={overtimeStart}
                onChange={(event) => setOvertimeStart(event.target.value)}
              />
            </Field>
            <Field label="Ends">
              <input
                type="datetime-local"
                value={overtimeEnd}
                onChange={(event) => setOvertimeEnd(event.target.value)}
              />
            </Field>
            <Field label="Note" hint="Optional">
              <textarea
                rows={2}
                value={overtimeNote}
                onChange={(event) => setOvertimeNote(event.target.value)}
                placeholder="Covering the late truck, extra cleaning…"
              />
            </Field>
          </div>
          <button
            className="btn primary"
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run(
                'overtime.create',
                { start_at: overtimeStart, end_at: overtimeEnd, note: overtimeNote },
                'overtime',
                () => setOvertimeNote('')
              )
            }
          >
            {busy === 'overtime' ? 'Sending…' : 'Send request'}
          </button>
        </Card>
      )}

      {tab === 'exception' && (
        <Card title="Report an exception" hint="No-shows, late arrivals, leave days and other attendance notes.">
          <div className="form-grid">
            <Field label="Type">
              <select value={exceptionCode} onChange={(event) => setExceptionCode(event.target.value)}>
                {EXCEPTION_CODES.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.code} · {item.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="First day">
              <input
                type="date"
                value={exceptionStart}
                onChange={(event) => {
                  setExceptionStart(event.target.value);
                  if (event.target.value > exceptionEnd) setExceptionEnd(event.target.value);
                }}
              />
            </Field>
            <Field label="Last day">
              <input
                type="date"
                value={exceptionEnd}
                min={exceptionStart}
                onChange={(event) => setExceptionEnd(event.target.value)}
              />
            </Field>
            <Field label="Title" hint="Optional — defaults to the code.">
              <input
                value={exceptionTitle}
                onChange={(event) => setExceptionTitle(event.target.value)}
                placeholder="Doctor appointment"
              />
            </Field>
            <Field label="Details">
              <textarea
                rows={3}
                value={exceptionDetails}
                onChange={(event) => setExceptionDetails(event.target.value)}
                placeholder="What happened, and anything your manager should know."
              />
            </Field>
          </div>
          <button
            className="btn primary"
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run(
                'exception.create',
                {
                  exception_code: exceptionCode,
                  start_date: exceptionStart,
                  end_date: exceptionEnd,
                  title: exceptionTitle,
                  details: exceptionDetails
                },
                'exception',
                () => {
                  setExceptionTitle('');
                  setExceptionDetails('');
                }
              )
            }
          >
            {busy === 'exception' ? 'Sending…' : 'Send exception'}
          </button>
        </Card>
      )}

      {tab === 'swap' && (
        <Card title="Ask for a swap" hint="Post one of your shifts; a teammate can pick it up in RealtimeSuite.">
          {upcomingShifts.length ? (
            <>
              <div className="form-grid">
                <Field label="My shift">
                  <select value={swapShift} onChange={(event) => setSwapShift(event.target.value)}>
                    <option value="">Choose a shift</option>
                    {upcomingShifts.map((shift) => (
                      <option key={shift.id} value={shift.id}>
                        {formatShortDay(shift.start_at)} · {formatRange(shift.start_at, shift.end_at)} ·{' '}
                        {formatDuration(shiftMinutes(shift.start_at, shift.end_at, shift.break_minutes))}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="For" hint="Optional">
                  <select value={swapTarget} onChange={(event) => setSwapTarget(event.target.value)}>
                    <option value="">Anyone available</option>
                    {directory
                      .filter((person) => person.id !== employee.id)
                      .map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.full_name ?? 'Teammate'}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Note">
                  <textarea
                    rows={2}
                    value={swapNote}
                    onChange={(event) => setSwapNote(event.target.value)}
                    placeholder="Why the swap helps"
                  />
                </Field>
              </div>
              <button
                className="btn primary"
                type="button"
                disabled={busy !== null || !swapShift}
                onClick={() =>
                  void run(
                    'swap.create',
                    {
                      shift_id: swapShift,
                      requested_employee_id: swapTarget || null,
                      request_note: swapNote
                    },
                    'swap',
                    () => {
                      setSwapShift('');
                      setSwapTarget('');
                      setSwapNote('');
                    }
                  )
                }
              >
                {busy === 'swap' ? 'Posting…' : 'Post swap request'}
              </button>
            </>
          ) : (
            <Empty title="No future shifts to swap" body="You can only swap shifts that have not started yet." />
          )}
        </Card>
      )}

      {tab === 'history' && (
        <Card title="Request history" hint="Newest first — status updates arrive with the next sync">
          {history.length ? (
            <div className="list">
              {history.map((entry) => (
                <div className="history-row" key={entry.id}>
                  <div className="history-type">{entry.type}</div>
                  <div className="history-body">
                    <strong>{entry.title}</strong>
                    <span className="muted small">{entry.detail}</span>
                  </div>
                  <Pill status={entry.status} />
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Nothing submitted yet" body="Time off, overtime, exceptions and swaps all show up here." />
          )}
        </Card>
      )}
    </div>
  );
}
