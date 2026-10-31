// Dev-only Supabase stand-in for RTLink.
//
// Answers the slice of the Supabase API this app uses (password auth + the
// rtlink_* tables) with in-memory sample data, and simulates the LAN bridge by
// applying queued actions a few seconds after they are inserted.
//
// It has no row level security, no persistence and no real credentials. Never
// run it against real employee data.
//
//   node scripts/mock-supabase.mjs      → http://127.0.0.1:54321
//   sign in: jordan@northwind.test / RTLinkDemo!2026

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// Some dev runners export PORT=0; treat anything non-positive as unset.
const requestedPort = Number(process.env.PORT ?? 0);
const PORT = requestedPort > 0 ? requestedPort : 54321;
const PASSWORD = 'RTLinkDemo!2026';

const SITE_ID = '5f1c1f0e-9b2a-4f6f-9d3a-0d6a1c2b3e40';
const JORDAN_ID = 'a1000000-0000-4000-8000-000000000001';
const SAM_ID = 'a1000000-0000-4000-8000-000000000002';
const OPS_AREA = 'b2000000-0000-4000-8000-000000000001';
const FLOOR_AREA = 'b2000000-0000-4000-8000-000000000002';

const users = [
  { id: JORDAN_ID, email: 'jordan@northwind.test', name: 'Jordan Avery' },
  { id: SAM_ID, email: 'sam@northwind.test', name: 'Sam Patel' }
];

function at(dayOffset, hour, minute = 0) {
  const value = new Date();
  value.setDate(value.getDate() + dayOffset);
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

function dateOnly(dayOffset) {
  const value = new Date();
  value.setDate(value.getDate() + dayOffset);
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

const TABLES = {
  rtlink_sites: [
    {
      id: SITE_ID,
      name: 'Denver Flagship',
      organization_name: 'Northwind Retail',
      org_code: 'NORTHWIND',
      timezone: 'MDT',
      app_version: '1.0.0',
      last_sync_at: at(0, Math.max(0, new Date().getHours() - 1)),
      record_counts: {},
      created_at: at(-30, 8),
      updated_at: at(0, 8)
    }
  ],
  rtlink_settings: [
    {
      site_id: SITE_ID,
      organization_name: 'Northwind Retail',
      portal_label: 'Northwind Retail',
      feature_flags: { tasks: true, shift_pool: true, messaging: true },
      clock_in_required: false,
      synced_at: at(0, 8)
    }
  ],
  rtlink_employees: [
    {
      id: JORDAN_ID,
      site_id: SITE_ID,
      email: 'jordan@northwind.test',
      full_name: 'Jordan Avery',
      role: 'employee',
      hourly_rate: 21.5,
      is_training_manager: false,
      onboarding_completed_at: at(-60, 9),
      created_at_local: at(-90, 9),
      updated_at_local: at(-2, 9),
      synced_at: at(0, 8)
    },
    {
      id: SAM_ID,
      site_id: SITE_ID,
      email: 'sam@northwind.test',
      full_name: 'Sam Patel',
      role: 'employee',
      hourly_rate: 22,
      is_training_manager: false,
      onboarding_completed_at: at(-45, 9),
      created_at_local: at(-80, 9),
      updated_at_local: at(-3, 9),
      synced_at: at(0, 8)
    }
  ],
  rtlink_work_areas: [
    { id: OPS_AREA, site_id: SITE_ID, name: 'Operations', color: '#86d56e', is_active: true, synced_at: at(0, 8) },
    { id: FLOOR_AREA, site_id: SITE_ID, name: 'Front of House', color: '#7bb7ea', is_active: true, synced_at: at(0, 8) }
  ],
  rtlink_shifts: [
    {
      id: 'c3000000-0000-4000-8000-000000000001',
      site_id: SITE_ID,
      employee_id: JORDAN_ID,
      work_area_id: OPS_AREA,
      work_area_name: 'Operations',
      // Relative to the current time so the demo always has a shift to clock into.
      start_at: hoursFromNow(-1),
      end_at: hoursFromNow(7),
      status: 'scheduled',
      break_minutes: 30,
      worked_minutes: null,
      clocked_in_at: null,
      clocked_out_at: null,
      is_unscheduled_overtime: false,
      is_shift_pool: false,
      shift_pool_posted_at: null,
      notes: 'Opening coverage',
      synced_at: at(0, 8)
    },
    {
      id: 'c3000000-0000-4000-8000-000000000002',
      site_id: SITE_ID,
      employee_id: JORDAN_ID,
      work_area_id: FLOOR_AREA,
      work_area_name: 'Front of House',
      start_at: at(1, 10),
      end_at: at(1, 18),
      status: 'scheduled',
      break_minutes: 30,
      worked_minutes: null,
      clocked_in_at: null,
      clocked_out_at: null,
      is_unscheduled_overtime: false,
      is_shift_pool: false,
      shift_pool_posted_at: null,
      notes: '',
      synced_at: at(0, 8)
    },
    {
      id: 'c3000000-0000-4000-8000-000000000003',
      site_id: SITE_ID,
      employee_id: JORDAN_ID,
      work_area_id: OPS_AREA,
      work_area_name: 'Operations',
      start_at: at(2, 8),
      end_at: at(2, 16),
      status: 'scheduled',
      break_minutes: 30,
      worked_minutes: null,
      clocked_in_at: null,
      clocked_out_at: null,
      is_unscheduled_overtime: false,
      is_shift_pool: false,
      shift_pool_posted_at: null,
      notes: '',
      synced_at: at(0, 8)
    },
    {
      id: 'c3000000-0000-4000-8000-000000000004',
      site_id: SITE_ID,
      employee_id: JORDAN_ID,
      work_area_id: OPS_AREA,
      work_area_name: 'Operations',
      start_at: at(-1, 9),
      end_at: at(-1, 17),
      status: 'off_shift',
      break_minutes: 30,
      worked_minutes: 450,
      clocked_in_at: at(-1, 8, 56),
      clocked_out_at: at(-1, 17, 2),
      is_unscheduled_overtime: false,
      is_shift_pool: false,
      shift_pool_posted_at: null,
      notes: '',
      synced_at: at(0, 8)
    },
    {
      id: 'c3000000-0000-4000-8000-000000000005',
      site_id: SITE_ID,
      employee_id: null,
      work_area_id: FLOOR_AREA,
      work_area_name: 'Front of House',
      start_at: at(1, 12),
      end_at: at(1, 20),
      status: 'scheduled',
      break_minutes: 30,
      worked_minutes: null,
      clocked_in_at: null,
      clocked_out_at: null,
      is_unscheduled_overtime: false,
      is_shift_pool: true,
      shift_pool_posted_at: at(0, 7),
      notes: 'Cover for a call-out',
      synced_at: at(0, 8)
    },
    {
      id: 'c3000000-0000-4000-8000-000000000006',
      site_id: SITE_ID,
      employee_id: null,
      work_area_id: OPS_AREA,
      work_area_name: 'Operations',
      start_at: at(3, 8),
      end_at: at(3, 16),
      status: 'scheduled',
      break_minutes: 30,
      worked_minutes: null,
      clocked_in_at: null,
      clocked_out_at: null,
      is_unscheduled_overtime: false,
      is_shift_pool: true,
      shift_pool_posted_at: at(0, 7),
      notes: '',
      synced_at: at(0, 8)
    }
  ],
  rtlink_tasks: [
    {
      id: 'd4000000-0000-4000-8000-000000000001',
      site_id: SITE_ID,
      title: 'Restock the front cooler',
      description: 'Pull dates forward and note anything short-dated before the lunch rush.',
      status: 'pending',
      priority: 'high',
      start_at: at(0, 10),
      end_at: at(0, 10, 45),
      work_area_id: FLOOR_AREA,
      work_area_name: 'Front of House',
      assignee_id: JORDAN_ID,
      assignment_id: 'e5000000-0000-4000-8000-000000000001',
      acknowledged_at: null,
      acknowledgment_note: null,
      source_system: 'suite',
      synced_at: at(0, 8)
    },
    {
      id: 'd4000000-0000-4000-8000-000000000002',
      site_id: SITE_ID,
      title: 'Safety walkthrough',
      description: 'Check aisle clearance, spill kit and fire exits. Log anything missing.',
      status: 'pending',
      priority: 'normal',
      start_at: at(0, 13),
      end_at: at(0, 13, 30),
      work_area_id: OPS_AREA,
      work_area_name: 'Operations',
      assignee_id: JORDAN_ID,
      assignment_id: 'e5000000-0000-4000-8000-000000000002',
      acknowledged_at: null,
      acknowledgment_note: null,
      source_system: 'suite',
      synced_at: at(0, 8)
    },
    {
      id: 'd4000000-0000-4000-8000-000000000003',
      site_id: SITE_ID,
      title: 'Merge queue: register patch',
      description: 'Run the register patch on till 3 and confirm a test transaction.',
      status: 'pending',
      priority: 'normal',
      start_at: at(1, 9, 15),
      end_at: at(1, 9, 45),
      work_area_id: OPS_AREA,
      work_area_name: 'Operations',
      assignee_id: JORDAN_ID,
      assignment_id: 'e5000000-0000-4000-8000-000000000003',
      acknowledged_at: at(-1, 16),
      acknowledgment_note: 'Seen, picking it up tomorrow',
      source_system: 'github',
      synced_at: at(0, 8)
    }
  ],
  rtlink_announcements: [
    {
      id: 'f6000000-0000-4000-8000-000000000001',
      site_id: SITE_ID,
      message: 'Inventory count is Saturday at 7am. Breakfast is on us — see the duty manager when you arrive.',
      is_active: true,
      starts_at: at(-1, 8),
      ends_at: at(4, 20),
      synced_at: at(0, 8)
    }
  ],
  rtlink_board_notes: [
    {
      id: '07000000-0000-4000-8000-000000000001',
      site_id: SITE_ID,
      note_date: dateOnly(0),
      body: 'Two pallets arriving before noon. Keep the loading bay clear and sign for them at the desk.',
      created_at_local: at(0, 7, 15),
      synced_at: at(0, 8)
    }
  ],
  rtlink_time_off_requests: [
    {
      id: '08000000-0000-4000-8000-000000000001',
      site_id: SITE_ID,
      employee_id: JORDAN_ID,
      start_date: dateOnly(12),
      end_date: dateOnly(14),
      request_type: 'vacation',
      reason: 'Family wedding',
      status: 'approved',
      review_notes: 'Approved, cover arranged.',
      created_at_local: at(-9, 10),
      reviewed_at: at(-7, 9),
      synced_at: at(0, 8)
    }
  ],
  rtlink_overtime_requests: [
    {
      id: '09000000-0000-4000-8000-000000000001',
      site_id: SITE_ID,
      employee_id: JORDAN_ID,
      start_at: at(1, 18),
      end_at: at(1, 21),
      overtime_type: 'voluntary',
      note: 'Stock take help',
      status: 'pending',
      review_notes: null,
      created_at_local: at(-1, 15),
      reviewed_at: null,
      synced_at: at(0, 8)
    }
  ],
  rtlink_exception_requests: [],
  rtlink_swap_requests: [
    {
      id: '0a000000-0000-4000-8000-000000000001',
      site_id: SITE_ID,
      requester_id: JORDAN_ID,
      shift_id: 'c3000000-0000-4000-8000-000000000003',
      requested_employee_id: null,
      status: 'open',
      request_note: 'Doctor appointment that morning',
      review_note: '',
      shift_start_at: at(2, 8),
      created_at_local: at(-1, 12),
      synced_at: at(0, 8)
    }
  ],
  rtlink_training_assignments: [
    {
      id: '0b000000-0000-4000-8000-000000000001',
      site_id: SITE_ID,
      employee_id: JORDAN_ID,
      course_title: 'Food safety refresher',
      course_description: 'Temperature checks, labelling and allergen handling.',
      status: 'assigned',
      due_at: at(9, 17),
      completed_at: null,
      synced_at: at(0, 8)
    },
    {
      id: '0b000000-0000-4000-8000-000000000002',
      site_id: SITE_ID,
      employee_id: JORDAN_ID,
      course_title: 'Ladder safety',
      course_description: 'Ten minute module and sign-off.',
      status: 'completed',
      due_at: at(-20, 17),
      completed_at: at(-22, 11),
      synced_at: at(0, 8)
    }
  ],
  rtlink_requests: [],
  rtlink_sync_events: [
    {
      id: randomUUID(),
      site_id: SITE_ID,
      kind: 'startup',
      status: 'ok',
      record_counts: {},
      message: null,
      received_at: at(0, 8)
    }
  ]
};

const sessions = new Map();

function base64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeToken(user) {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64url({ alg: 'HS256', typ: 'JWT' }),
    base64url({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 }),
    'mock-signature'
  ].join('.');
}

function userPayload(user) {
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: new Date().toISOString(),
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: user.name },
    identities: [],
    created_at: at(-90, 9),
    updated_at: at(0, 9)
  };
}

function makeSession(user) {
  const token = makeToken(user);
  sessions.set(token, user);
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `refresh-${user.id}`,
    user: userPayload(user)
  };
}

function currentUser(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return sessions.get(token) ?? null;
}

function json(res, status, body) {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Range',
    'Content-Range': `0-${Array.isArray(body) ? Math.max(0, body.length - 1) : 0}/*`
  });
  res.end(payload);
}

function matches(value, op, expected) {
  switch (op) {
    case 'eq':
      return String(value ?? '') === expected || (expected === 'null' && value === null);
    case 'neq':
      return String(value ?? '') !== expected;
    case 'gt':
      return value != null && String(value) > expected;
    case 'gte':
      return value != null && String(value) >= expected;
    case 'lt':
      return value != null && String(value) < expected;
    case 'lte':
      return value != null && String(value) <= expected;
    case 'is':
      if (expected === 'null') return value === null;
      if (expected === 'true') return value === true;
      if (expected === 'false') return value === false;
      return false;
    case 'in': {
      const list = expected.replace(/^\(|\)$/g, '').split(',');
      return list.includes(String(value ?? ''));
    }
    case 'ilike':
    case 'like': {
      const pattern = expected.replace(/%/g, '');
      return String(value ?? '').toLowerCase().includes(pattern.toLowerCase());
    }
    default:
      return true;
  }
}

function filterRows(rows, params) {
  let result = rows.slice();
  for (const [key, raw] of params.entries()) {
    if (['select', 'order', 'limit', 'offset', 'or', 'on_conflict'].includes(key)) continue;
    const [op, ...rest] = raw.split('.');
    const expected = rest.join('.');
    result = result.filter((row) => matches(row[key], op, expected));
  }

  const orParam = params.get('or');
  if (orParam) {
    const clauses = orParam.replace(/^\(|\)$/g, '').split(',');
    result = result.filter((row) =>
      clauses.some((clause) => {
        const [field, op, ...rest] = clause.split('.');
        return matches(row[field], op, rest.join('.'));
      })
    );
  }

  const order = params.get('order');
  if (order) {
    const [field, direction] = order.split('.');
    result.sort((a, b) => {
      const left = a[field];
      const right = b[field];
      if (left == null && right == null) return 0;
      if (left == null) return 1;
      if (right == null) return -1;
      const comparison = String(left).localeCompare(String(right), undefined, { numeric: true });
      return direction === 'desc' ? -comparison : comparison;
    });
  }

  const offset = Number(params.get('offset') ?? 0);
  if (offset) result = result.slice(offset);
  const limit = params.get('limit');
  if (limit) result = result.slice(0, Number(limit));
  return result;
}

/** Row level security, approximated for the demo. */
function scopeRows(table, rows, user, orgCode) {
  const site = orgCode
    ? TABLES.rtlink_sites.find((row) => (row.org_code ?? '').toUpperCase() === orgCode)
    : null;
  if (orgCode && !site) return [];
  const me = TABLES.rtlink_employees.find(
    (employee) => employee.email === user.email && (!site || employee.site_id === site.id)
  );
  if (!me) return [];
  switch (table) {
    case 'rtlink_sites':
      return rows.filter((row) => !site || row.id === site.id);
    case 'rtlink_employees':
      return rows.filter((row) => row.id === me.id);
    case 'rtlink_shifts':
      return rows.filter((row) => row.employee_id === me.id || (row.is_shift_pool && !row.employee_id));
    case 'rtlink_tasks':
      return rows.filter((row) => row.assignee_id === me.id);
    case 'rtlink_time_off_requests':
    case 'rtlink_overtime_requests':
    case 'rtlink_exception_requests':
    case 'rtlink_training_assignments':
      return rows.filter((row) => row.employee_id === me.id);
    case 'rtlink_swap_requests':
      return rows.filter((row) => row.requester_id === me.id || row.requested_employee_id === me.id);
    case 'rtlink_requests':
      return rows.filter((row) => row.employee_id === me.id);
    case 'rtlink_directory':
      return rows.filter((row) => row.site_id === me.site_id);
    default:
      return rows;
  }
}

function selectFields(row, params) {
  const select = params.get('select');
  if (!select || select.trim() === '*') return row;
  const fields = select.split(',').map((field) => field.trim()).filter(Boolean);
  const result = {};
  for (const field of fields) {
    if (field in row) result[field] = row[field];
  }
  return result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Simulate the LAN bridge applying one queued action. Keeps the demo honest:
 * the UI has to wait for a status change, exactly like production.
 */
async function applyQueuedAction(action) {
  await sleep(4500);
  const payload = action.payload ?? {};
  const employee = TABLES.rtlink_employees.find((row) => row.id === action.employee_id);
  try {
    switch (action.kind) {
      case 'time_off.create':
        TABLES.rtlink_time_off_requests.unshift({
          id: randomUUID(),
          site_id: SITE_ID,
          employee_id: action.employee_id,
          start_date: payload.start_date,
          end_date: payload.end_date,
          request_type: payload.request_type ?? 'vacation',
          reason: payload.reason ?? '',
          status: 'pending',
          review_notes: null,
          created_at_local: new Date().toISOString(),
          reviewed_at: null,
          synced_at: new Date().toISOString()
        });
        action.result = 'Time off submitted for approval.';
        break;
      case 'overtime.create':
        TABLES.rtlink_overtime_requests.unshift({
          id: randomUUID(),
          site_id: SITE_ID,
          employee_id: action.employee_id,
          start_at: payload.start_at,
          end_at: payload.end_at,
          overtime_type: 'voluntary',
          note: payload.note ?? '',
          status: 'pending',
          review_notes: null,
          created_at_local: new Date().toISOString(),
          reviewed_at: null,
          synced_at: new Date().toISOString()
        });
        action.result = 'Overtime request submitted.';
        break;
      case 'exception.create':
        TABLES.rtlink_exception_requests.unshift({
          id: randomUUID(),
          site_id: SITE_ID,
          employee_id: action.employee_id,
          exception_code: payload.exception_code ?? 'DO',
          exception_type: 'other',
          title: payload.title || 'Exception request',
          details: payload.details ?? '',
          start_date: payload.start_date,
          end_date: payload.end_date,
          status: 'submitted',
          review_notes: null,
          created_at_local: new Date().toISOString(),
          reviewed_at: null,
          synced_at: new Date().toISOString()
        });
        action.result = 'Exception request submitted.';
        break;
      case 'swap.create':
        TABLES.rtlink_swap_requests.unshift({
          id: randomUUID(),
          site_id: SITE_ID,
          requester_id: action.employee_id,
          shift_id: payload.shift_id,
          requested_employee_id: payload.requested_employee_id ?? null,
          status: 'open',
          request_note: payload.request_note ?? '',
          review_note: '',
          shift_start_at:
            TABLES.rtlink_shifts.find((row) => row.id === payload.shift_id)?.start_at ?? null,
          created_at_local: new Date().toISOString(),
          synced_at: new Date().toISOString()
        });
        action.result = 'Swap posted.';
        break;
      case 'task.acknowledge': {
        const task = TABLES.rtlink_tasks.find((row) => row.assignment_id === payload.assignment_id);
        if (!task) throw new Error('That task assignment no longer exists.');
        task.acknowledged_at = new Date().toISOString();
        action.result = 'Task acknowledged.';
        break;
      }
      case 'shift.claim': {
        const shift = TABLES.rtlink_shifts.find((row) => row.id === payload.shift_id);
        if (!shift) throw new Error('That shift no longer exists.');
        shift.employee_id = action.employee_id;
        shift.is_shift_pool = false;
        shift.notes = `${shift.notes ? `${shift.notes} · ` : ''}Claimed by ${employee?.full_name ?? 'employee'}`;
        action.result = 'Shift claimed.';
        break;
      }
      case 'shift.clock_in': {
        const shift = TABLES.rtlink_shifts.find((row) => row.id === payload.shift_id);
        if (!shift) throw new Error('That shift no longer exists.');
        shift.clocked_in_at = new Date().toISOString();
        shift.clocked_out_at = null;
        shift.status = 'on_duty';
        action.result = 'Clocked in.';
        break;
      }
      case 'shift.clock_out': {
        const shift = TABLES.rtlink_shifts.find((row) => row.id === payload.shift_id);
        if (!shift) throw new Error('That shift no longer exists.');
        shift.clocked_out_at = new Date().toISOString();
        shift.status = 'off_shift';
        action.result = 'Clocked out.';
        break;
      }
      case 'shift.clock_in_unscheduled':
        TABLES.rtlink_shifts.unshift({
          id: randomUUID(),
          site_id: SITE_ID,
          employee_id: action.employee_id,
          work_area_id: null,
          work_area_name: 'Unscheduled overtime',
          start_at: new Date().toISOString(),
          end_at: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
          status: 'on_duty',
          break_minutes: 0,
          worked_minutes: null,
          clocked_in_at: new Date().toISOString(),
          clocked_out_at: null,
          is_unscheduled_overtime: true,
          is_shift_pool: false,
          shift_pool_posted_at: null,
          notes: payload.note ?? 'Clocked in from RTLink',
          synced_at: new Date().toISOString()
        });
        action.result = 'Clocked in (unscheduled overtime).';
        break;
      default:
        throw new Error(`Unsupported action ${action.kind}`);
    }
    action.status = 'applied';
    action.error = null;
    action.processed_at = new Date().toISOString();
    action.attempts = 1;
  } catch (cause) {
    action.status = 'failed';
    action.error = cause instanceof Error ? cause.message : String(cause);
    action.processed_at = new Date().toISOString();
    action.attempts = 1;
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '600'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = raw ? JSON.parse(raw) : null;

  if (url.pathname === '/') {
    json(res, 200, { service: 'rtlink-mock-supabase', tables: Object.keys(TABLES) });
    return;
  }

  if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'refresh_token') {
      const id = String(body?.refresh_token ?? '').replace('refresh-', '');
      const user = users.find((item) => item.id === id);
      if (!user) {
        json(res, 400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
        return;
      }
      json(res, 200, makeSession(user));
      return;
    }
    const user = users.find((item) => item.email === String(body?.email ?? '').toLowerCase());
    if (!user || body?.password !== PASSWORD) {
      json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      return;
    }
    json(res, 200, makeSession(user));
    return;
  }

  if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
    const user = currentUser(req);
    if (!user) {
      json(res, 401, { message: 'invalid claim: missing sub claim' });
      return;
    }
    json(res, 200, userPayload(user));
    return;
  }

  if (url.pathname === '/auth/v1/logout') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    sessions.delete(token);
    json(res, 204, null);
    return;
  }

  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = url.pathname.split('/').pop();
    if (fn === 'rtlink_lookup_org') {
      const code = String(body?.p_code ?? '').trim().toUpperCase();
      const site = TABLES.rtlink_sites.find((row) => (row.org_code ?? '').toUpperCase() === code);
      json(
        res,
        200,
        site
          ? [
              {
                site_id: site.id,
                site_name: site.name,
                organization_name: site.organization_name,
                org_code: site.org_code
              }
            ]
          : []
      );
      return;
    }
    json(res, 404, { message: `Unknown rpc ${fn}` });
    return;
  }

  if (url.pathname.startsWith('/rest/v1/')) {
    const user = currentUser(req);
    if (!user) {
      json(res, 401, { message: 'JWT missing or invalid' });
      return;
    }

    const table = url.pathname.split('/')[3];
    // The production schema exposes a view, not a table, for the colleague list.
    const rows =
      table === 'rtlink_directory'
        ? TABLES.rtlink_employees.map(({ id, full_name, site_id }) => ({ id, full_name, site_id }))
        : TABLES[table];
    if (!rows) {
      json(res, 404, { message: `Unknown table ${table}` });
      return;
    }

    const params = url.searchParams;
    const orgCode = String(req.headers['x-rtlink-org'] ?? '').trim().toUpperCase();
    const wantsSingle = (req.headers.accept ?? '').includes('vnd.pgrst.object');
    const prefer = req.headers.prefer ?? '';

    if (req.method === 'GET') {
      const scoped = scopeRows(table, rows, user, orgCode);
      const result = filterRows(scoped, params).map((row) => selectFields(row, params));
      if (wantsSingle) {
        if (result.length > 1) {
          json(res, 406, { message: 'JSON object requested, multiple rows returned' });
          return;
        }
        json(res, 200, result[0] ?? null);
        return;
      }
      json(res, 200, result);
      return;
    }

    if (req.method === 'POST') {
      const incoming = (Array.isArray(body) ? body : [body]).filter(Boolean);
      const inserted = [];
      for (const item of incoming) {
        if (table === 'rtlink_requests') {
          const me = TABLES.rtlink_employees.find((row) => row.email === user.email);
          if (!me) {
            json(res, 403, { message: 'This account is not linked to an employee.' });
            return;
          }
          const action = {
            id: randomUUID(),
            site_id: me.site_id,
            employee_id: me.id,
            kind: item.kind,
            payload: item.payload ?? {},
            status: 'pending',
            result: null,
            error: null,
            attempts: 0,
            requested_at: new Date().toISOString(),
            processed_at: null
          };
          rows.unshift(action);
          inserted.push(action);
          void applyQueuedAction(action);
          continue;
        }
        const conflict = params.get('on_conflict') ?? 'id';
        const existing = rows.find((row) => row[conflict] === item[conflict]);
        if (existing && prefer.includes('merge-duplicates')) {
          Object.assign(existing, item);
          inserted.push(existing);
        } else {
          const row = { id: item.id ?? randomUUID(), ...item };
          rows.unshift(row);
          inserted.push(row);
        }
      }
      if (prefer.includes('return=representation')) {
        json(res, 201, wantsSingle ? (inserted[0] ?? null) : inserted);
      } else {
        json(res, 201, null);
      }
      return;
    }

    if (req.method === 'PATCH') {
      const scoped = scopeRows(table, rows, user, orgCode);
      const matched = filterRows(scoped, params);
      for (const row of matched) Object.assign(row, body);
      json(res, 200, null);
      return;
    }

    if (req.method === 'DELETE') {
      const matched = filterRows(rows, params);
      for (const row of matched) {
        const index = rows.indexOf(row);
        if (index >= 0) rows.splice(index, 1);
      }
      json(res, 204, null);
      return;
    }
  }

  json(res, 404, { message: `Unhandled ${req.method} ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`rtlink mock-supabase listening on http://127.0.0.1:${PORT}`);
  console.log(`sign in: jordan@northwind.test / ${PASSWORD}`);
});
