#!/usr/bin/env node
/**
 * Local Supabase stand-in for RealtimeCorp development.
 *
 * It answers the small slice of the Supabase API the app uses (password sign-in,
 * session lookup, RPCs and PostgREST reads/writes) with in-memory sample data. It
 * is NOT a security boundary: there is no row level security here. Use it to
 * review the UI without a hosted project, never for real data.
 *
 *   node scripts/mock-supabase.mjs            # http://127.0.0.1:54321
 *   MOCK_PORT=54322 node scripts/mock-supabase.mjs
 *
 * Then set in corp/.env:
 *   VITE_SUPABASE_URL=http://127.0.0.1:54321
 *   VITE_SUPABASE_ANON_KEY=local-anon-key
 *
 * Accounts: corp@northwind.test / CorpDemo!2026 (administrator),
 *           viewer@northwind.test / CorpDemo!2026 (viewer),
 *           new@northwind.test / CorpDemo!2026 (no company yet)
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 54321);
const PASSWORD = 'CorpDemo!2026';

const company = {
  id: '0d6f2b1a-1111-4a2b-9c3d-000000000001',
  name: 'Northwind Retail Group',
  slug: 'northwind',
  industry: 'Retail',
  headquarters: 'Denver, CO',
  created_at: daysAgo(240)
};

const locations = [
  {
    id: '0d6f2b1a-1111-4a2b-9c3d-000000000101',
    company_id: company.id,
    name: 'Denver Flagship',
    code: 'DEN-01',
    address: '1600 Wynkoop St, Denver, CO',
    timezone: 'America/Denver',
    status: 'active',
    created_at: daysAgo(200)
  },
  {
    id: '0d6f2b1a-1111-4a2b-9c3d-000000000102',
    company_id: company.id,
    name: 'Boulder Outpost',
    code: 'BLD-02',
    address: '1420 Pearl St, Boulder, CO',
    timezone: 'America/Denver',
    status: 'active',
    created_at: daysAgo(120)
  }
];

const sites = [
  {
    id: '0d6f2b1a-1111-4a2b-9c3d-000000000201',
    company_id: company.id,
    location_id: locations[0].id,
    name: 'Denver Flagship',
    app_version: '1.0.0',
    last_sync_at: minutesAgo(3),
    record_counts: { employees: 4, shifts: 38, tasks: 5, time_off_requests: 3 },
    created_at: daysAgo(30),
    updated_at: minutesAgo(3)
  },
  {
    id: '0d6f2b1a-1111-4a2b-9c3d-000000000202',
    company_id: company.id,
    location_id: locations[1].id,
    name: 'Boulder Outpost',
    app_version: '1.0.0',
    last_sync_at: minutesAgo(95),
    record_counts: { employees: 2, shifts: 12, tasks: 1 },
    created_at: daysAgo(20),
    updated_at: minutesAgo(95)
  }
];

const people = [
  ['Avery Chen', 'avery@northwind.test', 'employee', 24.5, sites[0].id],
  ['Jordan Ruiz', 'jordan@northwind.test', 'employee', 22.75, sites[0].id],
  ['Priya Patel', 'priya@northwind.test', 'employee', 26, sites[0].id],
  ['Sam Okafor', 'sam@northwind.test', 'employee', 21, sites[0].id],
  ['Dana Whitfield', 'dana@northwind.test', 'admin', 38, sites[1].id],
  ['Luis Ortega', 'luis@northwind.test', 'employee', 23.25, sites[1].id]
];

const employees = people.map(([full_name, email, role, rate, site_id], index) => ({
  id: `0d6f2b1a-1111-4a2b-9c3d-0000000003${String(index).padStart(2, '0')}`,
  site_id,
  company_id: company.id,
  email,
  full_name,
  role,
  hourly_rate: rate,
  onboarding_completed_at: index === 3 ? null : daysAgo(60),
  is_training_manager: index === 4,
  is_active: true,
  created_at_local: daysAgo(90),
  updated_at_local: daysAgo(1)
}));

const shifts = [];
for (let day = 0; day < 26; day += 1) {
  employees.forEach((employee, index) => {
    if ((day + index) % 3 === 0) return;
    const date = new Date();
    date.setDate(date.getDate() - day);
    const start = new Date(date);
    start.setHours(index % 2 === 0 ? 8 : 12, 0, 0, 0);
    const end = new Date(start);
    end.setHours(start.getHours() + 6 + (index % 3));
    const isToday = day === 0;
    const worked = isToday ? (index < 2 ? 180 : 0) : (end - start) / 60000 - 30;
    shifts.push({
      id: randomUUID(),
      site_id: employee.site_id,
      company_id: company.id,
      employee_id: employee.id,
      employee_name: employee.full_name,
      work_area_name: index % 2 === 0 ? 'Operations' : 'Management',
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      status: isToday ? (index < 2 ? 'on_duty' : 'scheduled') : 'off_shift',
      break_minutes: 30,
      worked_minutes: Math.max(0, Math.round(worked)),
      pay_multiplier: index === 3 ? 1.5 : 1,
      clocked_in_at: isToday && index < 2 ? start.toISOString() : null,
      clocked_out_at: !isToday && worked > 0 ? end.toISOString() : null,
      is_unscheduled_overtime: index === 3
    });
  });
}

const tasks = [
  ['Restock seasonal aisle', 'open', 'high', 'Avery Chen', employees[0].id, 0],
  ['Close register tills', 'done', 'normal', 'Jordan Ruiz', employees[1].id, 1],
  ['Cycle count: dry goods', 'in_progress', 'normal', 'Priya Patel', employees[2].id, 0],
  ['Update safety signage', 'open', 'low', 'Unassigned', null, 1],
  ['Customer recovery follow-up', 'cancelled', 'normal', 'Sam Okafor', employees[3].id, 2]
].map(([title, status, priority, assignee, assigneeId, dayOffset]) => {
  const start = new Date();
  start.setDate(start.getDate() - dayOffset);
  start.setHours(9, 30, 0, 0);
  const end = new Date(start);
  end.setHours(start.getHours() + 2);
  return {
    id: randomUUID(),
    site_id: sites[0].id,
    company_id: company.id,
    title,
    description: null,
    status,
    priority,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    work_area_name: 'Operations',
    assignee_id: assigneeId,
    assignee_name: assigneeId ? assignee : null,
    acknowledged_at: status === 'done' ? start.toISOString() : null,
    source_system: null
  };
});

const timeOff = [
  ['Avery Chen', employees[0].id, 6, 9, 'vacation', 'Family trip', 'pending'],
  ['Jordan Ruiz', employees[1].id, 20, 22, 'sick', 'Medical appointment', 'approved'],
  ['Luis Ortega', employees[5].id, 2, 3, 'personal', null, 'denied']
].map(([name, id, from, to, type, reason, status]) => ({
  id: randomUUID(),
  site_id: sites[0].id,
  company_id: company.id,
  employee_id: id,
  employee_name: name,
  start_date: isoDay(from),
  end_date: isoDay(to),
  request_type: type,
  reason,
  status,
  created_at_local: daysAgo(4),
  reviewed_at: status === 'pending' ? null : daysAgo(2)
}));

const overtime = [
  ['Sam Okafor', employees[3].id, 'approved', 1],
  ['Dana Whitfield', employees[4].id, 'pending', 0]
].map(([name, id, status, offset]) => {
  const start = new Date();
  start.setDate(start.getDate() + offset);
  start.setHours(18, 0, 0, 0);
  const end = new Date(start);
  end.setHours(22, 0, 0, 0);
  return {
    id: randomUUID(),
    site_id: sites[0].id,
    company_id: company.id,
    employee_id: id,
    employee_name: name,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    overtime_type: 'scheduled',
    note: 'Coverage for late delivery',
    status,
    created_at_local: daysAgo(1)
  };
});

const exceptions = [
  ['Priya Patel', employees[2].id, 'VAUT', 'approved', 1],
  ['Avery Chen', employees[0].id, 'NCNS', 'pending', 0]
].map(([name, id, code, status, offset]) => ({
  id: randomUUID(),
  site_id: sites[0].id,
  company_id: company.id,
  employee_id: id,
  employee_name: name,
  exception_code: code,
  exception_type: code === 'VAUT' ? 'leave' : 'attendance',
  title: code === 'VAUT' ? 'Approved vacation' : 'No call no show',
  details: null,
  start_date: isoDay(offset),
  end_date: isoDay(offset + 2),
  status,
  created_at_local: daysAgo(3)
}));

const discipline = [
  ['Sam Okafor', employees[3].id, 'Late arrival (third time)', 'medium', 'probation', 'applied'],
  ['Luis Ortega', employees[5].id, 'Missed task acknowledgement', 'low', 'none', 'issued']
].map(([name, id, title, severity, punishment, status]) => ({
  id: randomUUID(),
  site_id: sites[0].id,
  company_id: company.id,
  employee_id: id,
  employee_name: name,
  title,
  details: null,
  severity,
  punishment_type: punishment,
  status,
  leave_starts_on: punishment === 'probation' ? isoDay(0) : null,
  leave_ends_on: punishment === 'probation' ? isoDay(30) : null,
  created_at_local: daysAgo(7)
}));

const training = [
  ['Avery Chen', employees[0].id, 'Food safety refresher', 'completed'],
  ['Jordan Ruiz', employees[1].id, 'POS upgrade walkthrough', 'assigned'],
  ['Luis Ortega', employees[5].id, 'Lifting and safety', 'assigned']
].map(([name, id, title, status]) => ({
  id: randomUUID(),
  site_id: sites[0].id,
  company_id: company.id,
  employee_id: id,
  employee_name: name,
  course_title: title,
  status,
  due_at: daysAhead(9),
  completed_at: status === 'completed' ? daysAgo(5) : null
}));

const syncEvents = [
  { id: randomUUID(), site_id: sites[0].id, status: 'ok', kind: 'change' },
  { id: randomUUID(), site_id: sites[0].id, status: 'ok', kind: 'interval' },
  { id: randomUUID(), site_id: sites[1].id, status: 'failed', kind: 'interval' },
  { id: randomUUID(), site_id: sites[0].id, status: 'ok', kind: 'startup' }
].map((event, index) => ({
  ...event,
  company_id: company.id,
  record_counts: { employees: 4, shifts: 38, tasks: 5 },
  message: event.status === 'failed' ? 'Connection refused by Supabase' : null,
  received_at: minutesAgo(index * 12 + 2)
}));

const policies = [
  ['Attendance and punctuality', 'hr', 'Employees must arrive on time...', 'active', 'VP of People'],
  ['Cash handling', 'finance', 'Two-person verification for tills...', 'active', 'Controller'],
  ['Holiday scheduling', 'operations', 'Bid window opens November 1...', 'draft', 'VP of Operations']
].map(([title, category, body, status, owner], index) => ({
  id: randomUUID(),
  company_id: company.id,
  title,
  category,
  body,
  version: 1,
  status,
  effective_on: isoDay(index * 5 - 10),
  owner,
  created_by: null,
  updated_by: null,
  created_at: daysAgo(30 - index),
  updated_at: daysAgo(2 + index)
}));

const siteSettings = sites.map((site, index) => ({
  site_id: site.id,
  company_id: company.id,
  feature_flags: {
    tasks: true,
    reports: true,
    time_off: index === 0,
    shift_pool: true,
    payroll: false,
    training: true,
    clock_in_audit: true,
    geofence_clock_in: false
  },
  policy_settings: {
    enable_extended_leave_lock: true,
    extended_leave_threshold_days: 5,
    enable_retail_floor_simulation: false,
    enable_admin_realtime_notifications: true,
    default_shift_break_minutes: 30,
    default_timeline_window_hours: 8,
    training_mode: { training_time_multiplier: 10, training_fake_employee_count: 18 }
  },
  synced_at: minutesAgo(index === 0 ? 3 : 95)
}));

const commands = [
  {
    id: '0d6f2b1a-1111-4a2b-9c3d-0000000007a1',
    site_id: sites[0].id,
    company_id: company.id,
    kind: 'set_pay_rate',
    target_id: employees[0].id,
    payload: { hourly_rate: 25.5 },
    note: null,
    status: 'applied',
    requested_by: 'aaaa1111-2222-3333-4444-555555555555',
    requested_at: daysAgo(2),
    applied_at: daysAgo(2),
    attempts: 1,
    error: null
  },
  {
    id: '0d6f2b1a-1111-4a2b-9c3d-0000000007a2',
    site_id: sites[0].id,
    company_id: company.id,
    kind: 'set_feature_flags',
    target_id: null,
    payload: { flags: { tasks: true, reports: true } },
    note: 'Enable reporting for the month end',
    status: 'pending',
    requested_by: 'aaaa1111-2222-3333-4444-555555555555',
    requested_at: minutesAgo(4),
    applied_at: null,
    attempts: 0,
    error: null
  }
];

const TABLES = {
  corp_companies: [company],
  corp_locations: locations,
  corp_sites: sites,
  corp_employees: employees,
  corp_shifts: shifts,
  corp_tasks: tasks,
  corp_time_off_requests: timeOff,
  corp_exception_requests: exceptions,
  corp_overtime_requests: overtime,
  corp_discipline_actions: discipline,
  corp_training_assignments: training,
  corp_sync_events: syncEvents,
  corp_policies: policies,
  corp_settings: siteSettings,
  corp_commands: commands
};

const users = [
  { email: 'corp@northwind.test', id: 'aaaa1111-2222-3333-4444-555555555555', role: 'corp_admin' },
  { email: 'viewer@northwind.test', id: 'bbbb1111-2222-3333-4444-555555555555', role: 'corp_viewer' },
  { email: 'new@northwind.test', id: 'cccc1111-2222-3333-4444-555555555555', role: null }
];

const sessions = new Map();

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function daysAhead(days) {
  return daysAgo(-days);
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

function isoDay(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
    ...headers
  });
  res.end(payload);
}

function userPayload(user) {
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: daysAgo(90),
    created_at: daysAgo(90),
    updated_at: daysAgo(1),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { full_name: user.email.split('@')[0] },
    identities: []
  };
}

function makeSession(user) {
  const token = `mock-${randomUUID()}`;
  const session = {
    access_token: token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `refresh-${token}`,
    user: userPayload(user)
  };
  sessions.set(token, user);
  return session;
}

function memberFor(email) {
  const user = users.find((item) => item.email === email);
  if (!user || !user.role) return null;
  return {
    user_id: user.id,
    company_id: company.id,
    location_id: null,
    role: user.role,
    full_name: user.email.split('@')[0],
    email: user.email
  };
}

function scopeRows(email) {
  const member = memberFor(email);
  if (!member) return [];
  return [
    {
      company_id: company.id,
      company_name: company.name,
      company_slug: company.slug,
      location_id: member.location_id,
      location_name: null,
      role: member.role,
      email: member.email
    }
  ];
}

function applyFilters(rows, params) {
  let result = [...rows];
  for (const [key, raw] of params.entries()) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) continue;
    const [operator, ...rest] = raw.split('.');
    const value = rest.join('.');
    if (operator === 'eq') result = result.filter((row) => String(row[key]) === value);
    else if (operator === 'neq') result = result.filter((row) => String(row[key]) !== value);
    else if (operator === 'in') {
      const list = value.replace(/^\(|\)$/g, '').split(',');
      result = result.filter((row) => list.includes(String(row[key])));
    } else if (operator === 'is') {
      result = result.filter((row) =>
        value === 'null' ? row[key] === null : String(row[key]) === value
      );
    }
  }
  const order = params.get('order');
  if (order) {
    const [column, ...modifiers] = order.split('.');
    const descending = modifiers.includes('desc');
    result.sort((a, b) => {
      const left = a[column] ?? '';
      const right = b[column] ?? '';
      if (left === right) return 0;
      return (left < right ? -1 : 1) * (descending ? -1 : 1);
    });
  }
  return result;
}

function authorized(req) {
  const header = req.headers.authorization ?? '';
  return sessions.has(header.replace(/^Bearer\s+/i, ''));
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
    json(res, 200, { service: 'mock-supabase', tables: Object.keys(TABLES) });
    return;
  }

  if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
    const user = users.find((item) => item.email === body?.email);
    if (!user || body?.password !== PASSWORD) {
      json(res, 400, {
        error: 'invalid_grant',
        error_description: 'Invalid login credentials'
      });
      return;
    }
    json(res, 200, makeSession(user));
    return;
  }

  if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const user = sessions.get(token);
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

  if (url.pathname.startsWith('/rest/v1/')) {
    if (!authorized(req) && !url.pathname.startsWith('/rest/v1/rpc/')) {
      json(res, 401, { message: 'JWT missing or invalid' });
      return;
    }

    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.split('/').pop();
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const email = sessions.get(token)?.email ?? null;
      if (fn === 'corp_my_scope') {
        json(res, 200, scopeRows(email));
        return;
      }
      if (fn === 'corp_cancel_command') {
        const id = body?.p_command;
        const row = commands.find((item) => item.id === id);
        if (!row) {
          json(res, 400, { message: 'Command not found.' });
          return;
        }
        if (row.status !== 'pending') {
          json(res, 400, { message: 'Only pending commands can be cancelled.' });
          return;
        }
        row.status = 'cancelled';
        json(res, 200, id);
        return;
      }
      if (fn === 'corp_bootstrap_company') {
        const user = users.find((item) => item.email === email);
        if (!user) {
          json(res, 401, { message: 'JWT missing or invalid' });
          return;
        }
        if (user.role) {
          json(res, 400, { message: 'This account already belongs to a company.' });
          return;
        }
        user.role = 'corp_admin';
        if (body?.p_name) company.name = String(body.p_name).trim();
        if (body?.p_location && !locations.some((row) => row.name === body.p_location)) {
          locations.push({
            id: randomUUID(),
            company_id: company.id,
            name: String(body.p_location).trim(),
            code: null,
            address: null,
            timezone: 'America/Denver',
            status: 'active',
            created_at: daysAgo(0)
          });
        }
        json(res, 200, company.id);
        return;
      }
      json(res, 404, { message: `Unknown rpc ${fn}` });
      return;
    }

    const table = url.pathname.split('/')[3];
    const rows = TABLES[table];
    if (!rows) {
      json(res, 404, { message: `Unknown table ${table}` });
      return;
    }
    const wantsSingle = (req.headers.accept ?? '').includes('vnd.pgrst.object');

    if (req.method === 'GET') {
      let result = applyFilters(rows, url.searchParams);
      const limit = url.searchParams.get('limit');
      if (limit) result = result.slice(0, Number(limit));
      json(res, 200, wantsSingle ? (result[0] ?? null) : result);
      return;
    }

    if (req.method === 'POST') {
      const inserted = (Array.isArray(body) ? body : [body]).map((row) => ({
        id: row.id ?? randomUUID(),
        created_at: row.created_at ?? daysAgo(0),
        updated_at: row.updated_at ?? daysAgo(0),
        ...row
      }));
      for (const row of inserted) {
        const existing = rows.find((item) => item.id === row.id);
        if (existing) Object.assign(existing, row);
        else rows.push(row);
      }
      const prefer = req.headers.prefer ?? '';
      if (prefer.includes('return=representation')) json(res, 201, inserted);
      else json(res, 201, null);
      return;
    }

    if (req.method === 'PATCH') {
      const target = url.searchParams.get('id');
      const matches = target
        ? rows.filter((row) => row.id === target.replace('eq.', ''))
        : applyFilters(rows, url.searchParams);
      for (const row of matches) Object.assign(row, body, { updated_at: daysAgo(0) });
      json(res, 200, null);
      return;
    }

    if (req.method === 'DELETE') {
      const target = url.searchParams.get('id');
      const id = target?.replace('eq.', '');
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
      json(res, 204, null);
      return;
    }
  }

  json(res, 404, { message: `Unhandled ${req.method} ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-supabase listening on http://127.0.0.1:${PORT}`);
  console.log(`sign in: corp@northwind.test / ${PASSWORD}`);
});
