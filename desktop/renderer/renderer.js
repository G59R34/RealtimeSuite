'use strict';

const api = window.manager;

const state = {
  status: null,
  check: null,
  settings: null,
  version: '1.0.0',
  logs: [],
  users: [],
  pendingDelete: null,
  pendingDeleteTimer: null,
  featureSchema: null,
  features: null,
  featureDraft: null
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatUptime(startedAt) {
  if (!startedAt) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function banner(message, kind = 'error') {
  const node = $('banner');
  if (!message) {
    node.className = 'banner hidden';
    node.textContent = '';
    return;
  }
  node.className = `banner ${kind}`;
  node.textContent = message;
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label || 'Working...';
    button.disabled = true;
  } else {
    if (button.dataset.label) button.textContent = button.dataset.label;
    button.disabled = false;
  }
}

async function withBusy(button, label, fn) {
  banner('');
  setBusy(button, true, label);
  try {
    await fn();
  } catch (error) {
    banner(error && error.message ? error.message : String(error));
  } finally {
    setBusy(button, false);
  }
}

function stateLabel(value) {
  return { stopped: 'Stopped', starting: 'Starting', running: 'Online', stopping: 'Stopping', error: 'Error' }[value] || value;
}

function renderStatus(status) {
  if (!status) return;
  state.status = status;
  const label = stateLabel(status.state);
  const dotClass = status.state === 'running'
    ? 'running'
    : status.state === 'error'
      ? 'error'
      : status.state === 'starting' || status.state === 'stopping'
        ? 'starting'
        : 'stopped';

  for (const id of ['status-dot', 'side-dot']) {
    const node = $(id);
    node.className = `dot ${dotClass}`;
  }
  $('status-pill').className = `status-pill ${dotClass}`;
  $('status-text').textContent = label;
  $('side-state').textContent = label;
  $('side-url').textContent = status.state === 'running' ? status.url : 'Not running';
  const accessBadge = $('access-badge');
  if (accessBadge) accessBadge.textContent = state.check && state.check.config.host === '127.0.0.1' ? 'Local only' : 'LAN enabled';

  const heroTitle = $('hero-title');
  const heroSubtitle = $('hero-subtitle');
  if (status.state === 'running') {
    heroTitle.textContent = 'RealtimeSuite is online';
    heroSubtitle.textContent = `Listening on port ${status.port}. Share a LAN address below with employees.`;
  } else if (status.state === 'starting') {
    heroTitle.textContent = 'Starting server...';
    heroSubtitle.textContent = 'Waiting for the API to answer health checks.';
  } else if (status.state === 'stopping') {
    heroTitle.textContent = 'Stopping server...';
    heroSubtitle.textContent = 'Finishing active requests.';
  } else if (status.state === 'error') {
    heroTitle.textContent = 'Server needs attention';
    heroSubtitle.textContent = status.lastError || 'The server stopped unexpectedly. Check the log.';
  } else {
    heroTitle.textContent = 'RealtimeSuite is stopped';
    heroSubtitle.textContent = 'Start the server to let employees connect on the local network.';
  }

  $('fact-pid').textContent = status.pid ? String(status.pid) : '—';
  $('fact-uptime').textContent = formatUptime(status.startedAt);
  $('fact-port').textContent = String(status.port);
  $('fact-auto').textContent = status.autoRestart ? 'On' : 'Off';
  $('auto-restart-pill').textContent = status.autoRestart ? 'Automatic recovery enabled' : 'Automatic recovery disabled';
  $('auto-restart-pill').className = `step-badge ${status.autoRestart ? 'ok' : ''}`;

  $('btn-start').disabled = status.state === 'running' || status.state === 'starting' || status.state === 'stopping';
  $('btn-start').title = status.state === 'error' ? 'Try starting the server again.' : '';
  $('btn-stop').disabled = status.state !== 'running' && status.state !== 'starting' && status.state !== 'stopping';
  $('btn-restart').disabled = status.state !== 'running' && status.state !== 'error';
  $('btn-restart').title = status.state === 'error' ? 'Start a fresh server process.' : 'Restart the running server.';

  const list = $('address-list');
  list.textContent = '';
  const urls = status.lanUrls || [];
  for (const url of urls) {
    const row = document.createElement('div');
    row.className = 'address-row';
    const code = document.createElement('code');
    code.textContent = url.replace(/\/$/, '');
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.style.marginTop = '0';
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Open';
    open.disabled = status.state !== 'running';
    open.addEventListener('click', () => api.open(url));
    const board = document.createElement('button');
    board.type = 'button';
    board.textContent = 'Board';
    board.disabled = status.state !== 'running';
    board.addEventListener('click', () => api.open(`${url.replace(/\/$/, '')}/opsboard.html`));
    actions.append(open, board);
    row.append(code, actions);
    list.appendChild(row);
  }
  if (urls.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No network addresses detected.';
    list.appendChild(empty);
  }
}

function checkRow(kind, label, detail, statusText) {
  return { kind, label, detail, statusText };
}

function renderChecklist() {
  if (!state.check) return;
  const check = state.check;
  const port = state.status ? state.status.port : check.config.port;
  const items = [
    check.backendExists
      ? checkRow('ok', 'Backend files', 'FastAPI application found.', 'Ready')
      : checkRow('bad', 'Backend files', 'backend/app/main.py is missing.', 'Missing'),
    check.python
      ? checkRow('ok', 'Python', `Python ${check.python.version} detected.`, 'Ready')
      : checkRow('bad', 'Python', 'Install Python 3.10 or newer.', 'Missing'),
    check.venvExists
      ? checkRow('ok', 'Virtual environment', '.venv is present.', 'Ready')
      : checkRow('warn', 'Virtual environment', 'Create it from the Setup tab.', 'Pending'),
    check.databaseProbe && check.databaseProbe.ok
      ? checkRow('ok', 'Database connection', check.databaseProbe.detail, 'Connected')
      : checkRow(check.config.databaseUrl ? 'bad' : 'warn', 'Database connection', check.databaseProbe ? check.databaseProbe.detail : 'Database check has not run yet.', check.config.databaseUrl ? 'Unavailable' : 'Not set'),
    check.config.portValid
      ? checkRow('ok', 'Network binding', `Listening on ${check.config.host}:${port} (${check.config.hostBinding}).`, check.config.hostBinding)
      : checkRow('bad', 'Network binding', 'The configured port is invalid. Choose a port from 1 to 65535.', 'Invalid'),
    check.config.host === '127.0.0.1'
      ? checkRow('warn', 'LAN access', 'Loopback binding prevents other devices from connecting. Change Bind host in Settings for LAN access.', 'Local only')
      : checkRow('ok', 'LAN access', 'Server is configured to accept connections on network interfaces.', 'Enabled'),
    check.config.jwtSecretSet
      ? checkRow('ok', 'Session secret', 'JWT secret is customised.', 'Secure')
      : checkRow('warn', 'Session secret', 'Generate a secret in Settings before production use.', 'Default'),
    check.frontendBuilt
      ? checkRow('ok', 'Web app build', 'frontend/dist is available.', 'Ready')
      : checkRow('warn', 'Web app build', 'Run npm run build in frontend/.', 'Missing'),
    state.status && state.status.state === 'running'
      ? checkRow('ok', 'Server health', `Answering on port ${port}.`, 'Online')
      : checkRow('warn', 'Server health', 'The API is not answering yet.', 'Offline')
  ];

  const list = $('checklist');
  list.textContent = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = item.kind;
    const icon = document.createElement('span');
    icon.className = 'check-icon';
    icon.textContent = item.kind === 'ok' ? '✓' : item.kind === 'warn' ? '!' : '×';
    const text = document.createElement('div');
    text.innerHTML = `<strong>${escapeHtml(item.label)}</strong><div class="muted">${escapeHtml(item.detail)}</div>`;
    const status = document.createElement('strong');
    status.textContent = item.statusText;
    li.append(icon, text, status);
    list.appendChild(li);
  }

  $('network-summary').textContent = `Current binding: ${check.config.host}:${port} (${check.config.hostBinding}). Router forwarding and firewall status cannot be verified from this computer.`;

  $('setup-python-detail').textContent = check.python
    ? `Python ${check.python.version} at ${check.python.path}`
    : 'Python 3.10+ not found. Install it from python.org, then reopen this window.';
  $('setup-env-badge').textContent = check.venvExists ? 'Ready' : 'Pending';
  $('setup-env-badge').className = `step-badge ${check.venvExists ? 'ok' : ''}`;

  const dbConfigured = Boolean(check.config.databaseUrl);
  $('setup-db-badge').textContent = dbConfigured ? 'Configured' : 'Pending';
  $('setup-db-badge').className = `step-badge ${dbConfigured ? 'ok' : ''}`;

  if (shouldSyncField('set-db-url')) {
    $('setup-db-url').value = check.config.databaseUrl;
  }
  if (!$('admin-email').value) $('admin-email').value = check.config.adminEmail;
}

// Fields the user has typed into but not saved yet. Painters must never overwrite
// those, or an in-progress edit silently snaps back to the saved value.
const dirtyFields = new Set();
const UNSAVED_FIELD_IDS = [
  'set-port', 'set-host', 'set-org', 'set-jwt', 'set-board-token',
  'set-github-repos', 'set-github-poll', 'set-github-token', 'set-db-url'
];

function trackUnsavedEdits() {
  for (const id of UNSAVED_FIELD_IDS) {
    const node = $(id);
    if (!node) continue;
    const mark = () => dirtyFields.add(id);
    node.addEventListener('input', mark);
    node.addEventListener('change', mark);
  }
}

function releaseUnsavedEdits(ids) {
  for (const id of ids) dirtyFields.delete(id);
}

function shouldSyncField(id) {
  const node = $(id);
  return Boolean(node) && !dirtyFields.has(id) && !node.matches(':focus');
}

function renderSettings() {
  if (!state.settings || !state.check) return;
  const settings = state.settings;
  const config = state.check.config;
  if (shouldSyncField('set-port')) $('set-port').value = config.port;
  if (shouldSyncField('set-host')) $('set-host').value = config.host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
  if (shouldSyncField('set-org')) $('set-org').value = config.organizationName;
  if (shouldSyncField('set-github-repos')) $('set-github-repos').value = config.githubRepos || '';
  if (shouldSyncField('set-github-poll')) $('set-github-poll').value = config.githubPollMinutes || 5;
  $('set-github-token').placeholder = config.githubTokenSet
    ? 'Token saved — leave blank to keep it'
    : 'Paste a personal access token';
  $('set-autostart').checked = Boolean(settings.autoStart);
  $('set-autorestart').checked = Boolean(settings.autoRestart);
  $('set-openonstart').checked = Boolean(settings.openOnStart);
}

function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 800) state.logs.shift();
  const view = $('log-view');
  const line = document.createElement('span');
  line.className = `log-line ${entry.stream}`;
  const time = new Date(entry.at).toLocaleTimeString([], { hour12: false });
  line.innerHTML = `<span class="ts">${escapeHtml(time)}</span><span class="msg">${escapeHtml(entry.line)}</span>`;
  view.appendChild(line);
  while (view.childElementCount > 800) view.removeChild(view.firstChild);
  if ($('log-follow').checked) view.scrollTop = view.scrollHeight;
}

function renderLogs(entries) {
  state.logs = entries.slice();
  const view = $('log-view');
  view.textContent = '';
  for (const entry of state.logs) appendLog(entry);
  view.scrollTop = view.scrollHeight;
}

function applyState(payload) {
  if (!payload) return;
  state.status = payload.status || state.status;
  state.check = payload.check || state.check;
  state.settings = payload.settings || state.settings;
  if (state.status) renderStatus(state.status);
  state.version = payload.version || state.version;
  $('app-version').textContent = `v${state.version}`;
  renderChecklist();
  renderSettings();
  if (payload.logs) renderLogs(payload.logs);
}

async function refresh() {
  const payload = await api.getState();
  applyState(payload);
}

// --------------------------------------------------------------- users tab

function generatePassword() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const raw = Array.from(bytes, (value) => value.toString(36).padStart(2, '0')).join('');
  return `RS-${raw.slice(0, 6)}-${raw.slice(6, 12)}`;
}

function formatCreatedAt(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

function resetPendingDelete() {
  state.pendingDelete = null;
  if (state.pendingDeleteTimer) {
    clearTimeout(state.pendingDeleteTimer);
    state.pendingDeleteTimer = null;
  }
}

function renderUsers() {
  const body = $('user-table-body');
  body.textContent = '';
  $('user-count').textContent = state.users.length
    ? `${state.users.length} account${state.users.length === 1 ? '' : 's'}`
    : 'No accounts';

  if (state.users.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'muted';
    cell.textContent = 'No accounts yet. Create the first administrator in Setup, then add people here.';
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  for (const user of state.users) {
    const row = document.createElement('tr');

    const name = document.createElement('td');
    name.textContent = user.full_name || '—';
    name.title = `Created ${formatCreatedAt(user.created_at)}`;

    const email = document.createElement('td');
    email.textContent = user.email;

    const role = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `role-badge ${user.role === 'admin' ? 'admin' : 'employee'}`;
    badge.textContent = user.role === 'admin' ? 'Admin' : 'Employee';
    role.appendChild(badge);

    const onboarding = document.createElement('td');
    onboarding.textContent = user.onboarding_complete ? 'Complete' : 'Not started';
    onboarding.className = user.onboarding_complete ? '' : 'muted';

    const scheduled = document.createElement('td');
    scheduled.textContent = `${user.shifts} shift${user.shifts === 1 ? '' : 's'} · ${user.tasks} task${user.tasks === 1 ? '' : 's'}`;

    const actions = document.createElement('td');
    actions.className = 'actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'small danger';
    const armed = state.pendingDelete === user.email;
    if (armed) button.classList.add('armed');
    button.textContent = armed ? 'Confirm delete' : 'Delete';
    button.title = `Deletes ${user.full_name || user.email} and their shifts, task assignments and requests`;
    button.addEventListener('click', () => {
      if (state.pendingDelete !== user.email) {
        resetPendingDelete();
        state.pendingDelete = user.email;
        state.pendingDeleteTimer = setTimeout(() => {
          resetPendingDelete();
          renderUsers();
        }, 5000);
        renderUsers();
        return;
      }
      resetPendingDelete();
      void withBusy(button, 'Deleting...', async () => {
        const result = await api.deleteUser({ email: user.email });
        if (!result.ok) throw new Error(result.error);
        state.users = result.users;
        renderUsers();
        banner(`Deleted ${user.email}.`, 'ok');
      });
    });
    actions.appendChild(button);

    row.append(name, email, role, onboarding, scheduled, actions);
    body.appendChild(row);
  }
}

async function loadUsers() {
  resetPendingDelete();
  $('user-list-status').textContent = 'Loading accounts...';
  const result = await api.listUsers();
  if (!result.ok) {
    state.users = [];
    renderUsers();
    $('user-list-status').textContent = result.error;
    $('user-count').textContent = 'Unavailable';
    return;
  }
  state.users = result.users;
  $('user-list-status').textContent = '';
  renderUsers();
}

// ------------------------------------------------------------ features tab

function featureChanges() {
  if (!state.features || !state.featureDraft) return {};
  const patch = {};
  for (const [key, value] of Object.entries(state.featureDraft)) {
    if (state.features[key] !== value) patch[key] = value;
  }
  return patch;
}

function updateFeatureSummary() {
  const node = $('feature-summary');
  const changes = Object.keys(featureChanges()).length;
  if (changes === 0) {
    node.className = 'banner hidden';
    node.textContent = '';
    return;
  }
  node.className = 'banner warn';
  node.textContent = `${changes} unsaved change${changes === 1 ? '' : 's'}. Save to apply them to RealtimeSuite.`;
}

function renderFeatures() {
  const container = $('feature-groups');
  container.textContent = '';
  const schema = state.featureSchema;
  const draft = state.featureDraft;
  if (!schema || !draft) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Feature schema is unavailable.';
    container.appendChild(empty);
    return;
  }

  const groups = schema.groups && Object.keys(schema.groups).length
    ? schema.groups
    : { Features: Object.keys(draft) };
  const meta = schema.meta || {};

  for (const [groupName, keys] of Object.entries(groups)) {
    const card = document.createElement('article');
    card.className = 'feature-group';
    const heading = document.createElement('h2');
    heading.textContent = groupName;
    card.appendChild(heading);

    for (const key of keys) {
      const info = meta[key] || {};
      const row = document.createElement('div');
      row.className = 'feature-row';
      row.dataset.key = key;
      if (state.features && state.features[key] !== draft[key]) row.classList.add('changed');

      const text = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = info.label || key.replace(/_/g, ' ');
      const description = document.createElement('p');
      description.textContent = info.description || '';
      text.append(title, description);

      const label = document.createElement('label');
      label.className = 'switch';
      label.title = `Toggle ${info.label || key}`;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(draft[key]);
      input.setAttribute('aria-label', info.label || key);
      const track = document.createElement('span');
      input.addEventListener('change', () => {
        state.featureDraft[key] = input.checked;
        row.classList.toggle('changed', state.features ? state.features[key] !== input.checked : true);
        updateFeatureSummary();
      });
      label.append(input, track);

      row.append(text, label);
      card.appendChild(row);
    }

    container.appendChild(card);
  }
  updateFeatureSummary();
}

async function loadFeatures() {
  const result = await api.getFeatures();
  const container = $('feature-groups');
  if (!result.ok) {
    container.textContent = '';
    const message = document.createElement('p');
    message.className = 'muted';
    message.textContent = result.error;
    container.appendChild(message);
    $('feature-summary').className = 'banner hidden';
    return;
  }
  state.featureSchema = result.schema;
  state.features = result.flags;
  state.featureDraft = { ...result.flags };
  renderFeatures();
}

// -------------------------------------------------------------- database tab

const dbState = {
  tables: [],
  data: null,
  limit: 25,
  offset: 0,
  editing: null,
  editorInputs: new Map()
};

function editorInitialValue(value) {
  if (value === null) return 'NULL';
  return value === 'NULL' ? "'NULL'" : value;
}

function parseEditorValue(raw) {
  const trimmed = String(raw).trim();
  if (trimmed === 'NULL') return null;
  if (trimmed === "'NULL'") return 'NULL';
  return String(raw);
}

function renderDatabaseTables() {
  const select = $('db-table');
  const previous = dbState.data ? dbState.data.name : select.value;
  select.textContent = '';
  if (dbState.tables.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No tables found';
    select.appendChild(option);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const table of dbState.tables) {
    const option = document.createElement('option');
    option.value = table.name;
    option.textContent = table.rows === null ? table.name : `${table.name} (${table.rows})`;
    if (table.name === previous) option.selected = true;
    select.appendChild(option);
  }
  if (!select.value) select.value = dbState.tables[0].name;
}

async function loadDatabaseTables(offset = 0) {
  const result = await api.listDatabaseTables();
  if (!result.ok) {
    dbState.tables = [];
    renderDatabaseTables();
    $('db-status').textContent = result.error;
    return;
  }
  dbState.tables = result.tables;
  renderDatabaseTables();
  const selected = $('db-table').value;
  if (selected) await loadDatabaseRows({ table: selected, offset });
}

async function loadDatabaseRows({ table, offset } = {}) {
  const target = table || $('db-table').value;
  if (!target) {
    $('db-status').textContent = 'Choose a table to load its rows.';
    return;
  }
  closeRowEditor();
  $('db-status').textContent = `Loading ${target}...`;
  const nextOffset = Math.max(offset === undefined ? dbState.offset : offset, 0);
  const result = await api.readDatabaseRows({ table: target, limit: dbState.limit, offset: nextOffset });
  if (!result.ok) {
    dbState.data = null;
    renderDatabaseRows();
    $('db-status').textContent = result.error;
    return;
  }
  if (result.table.rows.length === 0 && result.table.total > 0 && nextOffset > 0) {
    const lastPage = Math.floor((result.table.total - 1) / result.table.limit) * result.table.limit;
    if (lastPage !== nextOffset) return loadDatabaseRows({ table: target, offset: lastPage });
  }
  dbState.data = result.table;
  dbState.offset = result.table.offset;
  $('db-status').textContent = result.table.total === 0 ? `${result.table.name} is empty.` : '';
  renderDatabaseRows();
}

function renderDatabaseRows() {
  const head = $('db-row-table').querySelector('thead tr');
  const body = $('db-row-body');
  head.textContent = '';
  body.textContent = '';

  const data = dbState.data;
  if (!data) {
    $('db-range').textContent = '—';
    $('btn-db-prev').disabled = true;
    $('btn-db-next').disabled = true;
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.className = 'muted';
    cell.textContent = 'No table loaded.';
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  const actionsTh = document.createElement('th');
  actionsTh.textContent = 'Actions';
  head.appendChild(actionsTh);
  for (const column of data.columns) {
    const th = document.createElement('th');
    th.textContent = column.name;
    th.title = `${column.type}${column.required ? ' · not null' : ''}`;
    if (data.primaryKey.includes(column.name)) {
      th.textContent = `🔑 ${column.name}`;
      th.title = `${column.type} · primary key`;
    }
    head.appendChild(th);
  }

  if (data.rows.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = data.columns.length + 1;
    cell.className = 'muted';
    cell.textContent = 'This table has no rows.';
    row.appendChild(cell);
    body.appendChild(row);
  }

  data.rows.forEach((record, index) => {
    const row = document.createElement('tr');
    const actions = document.createElement('td');
    actions.className = 'actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'small';
    edit.textContent = 'Edit';
    edit.disabled = data.primaryKey.length === 0;
    edit.title = edit.disabled ? 'This table has no primary key.' : 'Edit this row';
    edit.addEventListener('click', () => openRowEditor(index));
    actions.appendChild(edit);
    row.appendChild(actions);
    for (const column of data.columns) {
      const cell = document.createElement('td');
      cell.className = 'db-cell';
      const value = record[column.name];
      if (value === null) {
        cell.classList.add('muted');
        cell.textContent = 'NULL';
      } else {
        cell.textContent = value;
        cell.title = value;
      }
      row.appendChild(cell);
    }
    body.appendChild(row);
  });

  const first = data.total === 0 ? 0 : data.offset + 1;
  const last = Math.min(data.offset + data.rows.length, data.total);
  $('db-range').textContent = `${first}–${last} of ${data.total} row${data.total === 1 ? '' : 's'}`;
  $('btn-db-prev').disabled = data.offset <= 0;
  $('btn-db-next').disabled = data.offset + data.rows.length >= data.total;
}

function closeRowEditor() {
  dbState.editing = null;
  dbState.editorInputs = new Map();
  $('db-editor').classList.add('hidden');
  $('db-editor-fields').textContent = '';
  $('db-editor-status').textContent = '';
}

function openRowEditor(index) {
  const data = dbState.data;
  if (!data || !data.rows[index]) return;
  dbState.editing = { index, row: data.rows[index] };
  dbState.editorInputs = new Map();
  const container = $('db-editor-fields');
  container.textContent = '';
  $('db-editor-title').textContent = `Edit ${data.name}`;
  $('db-editor-subtitle').textContent = `Row ${data.offset + index + 1} · key ${data.primaryKey.map((column) => data.rows[index][column]).join(' / ')}`;
  $('db-editor-status').textContent = '';

  for (const column of data.columns) {
    const field = document.createElement('label');
    field.className = 'field db-field';
    const caption = document.createElement('span');
    caption.textContent = column.name;
    const meta = document.createElement('em');
    meta.className = 'db-type';
    meta.textContent = column.type;
    caption.appendChild(meta);

    const value = data.rows[index][column.name];
    const initial = editorInitialValue(value);
    const multiline = value !== null && (value.length > 70 || /text|json/i.test(column.type));
    const input = document.createElement(multiline ? 'textarea' : 'input');
    if (multiline) input.rows = 3;
    else input.type = 'text';
    input.value = initial;
    input.spellcheck = false;
    input.dataset.column = column.name;
    if (column.name === 'password_hash' || column.name === 'hashed_password') {
      input.title = 'Password hashes cannot be read back; set a new password in the Users tab instead.';
      input.disabled = true;
    }
    dbState.editorInputs.set(column.name, input);

    field.append(caption, input);
    container.appendChild(field);
  }

  $('db-editor').classList.remove('hidden');
  $('db-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function editorChanges() {
  const editing = dbState.editing;
  if (!editing) return {};
  const changes = {};
  for (const [column, input] of dbState.editorInputs) {
    if (input.disabled) continue;
    const original = editing.row[column];
    const value = parseEditorValue(input.value);
    if (original === null && value === null) continue;
    if (original !== null && value !== null && String(original) === value) continue;
    changes[column] = value;
  }
  return changes;
}

function editorKey() {
  const data = dbState.data;
  const row = dbState.editing ? dbState.editing.row : null;
  const key = {};
  for (const column of data.primaryKey) key[column] = row[column];
  return key;
}

$('btn-db-save-row').addEventListener('click', () => withBusy($('btn-db-save-row'), 'Saving...', async () => {
  if (!dbState.editing || !dbState.data) throw new Error('Choose a row to edit first.');
  const changes = editorChanges();
  if (Object.keys(changes).length === 0) {
    $('db-editor-status').textContent = 'No changes to save.';
    return;
  }
  const result = await api.updateDatabaseRow({
    table: dbState.data.name,
    key: editorKey(),
    changes
  });
  if (!result.ok) throw new Error(result.error);
  const offset = dbState.offset;
  closeRowEditor();
  await loadDatabaseTables(offset);
  banner(result.message || 'Row saved.', 'ok');
}));

$('btn-db-delete-row').addEventListener('click', () => withBusy($('btn-db-delete-row'), 'Deleting...', async () => {
  if (!dbState.editing || !dbState.data) throw new Error('Choose a row to delete first.');
  const table = dbState.data.name;
  const key = editorKey();
  const label = Object.entries(key).map(([column, value]) => `${column}=${value}`).join(', ');
  if (!window.confirm(`Delete this row from ${table} (${label})? This cannot be undone.`)) return;
  const result = await api.deleteDatabaseRow({ table, key });
  if (!result.ok) throw new Error(result.error);
  const offset = dbState.offset;
  closeRowEditor();
  await loadDatabaseTables(offset);
  banner(result.message || 'Row deleted.', 'ok');
}));

$('btn-db-close-editor').addEventListener('click', () => closeRowEditor());
$('btn-db-refresh').addEventListener('click', () => withBusy($('btn-db-refresh'), 'Loading...', loadDatabaseTables));
$('db-table').addEventListener('change', () => {
  void loadDatabaseRows({ table: $('db-table').value, offset: 0 }).catch((error) => {
    $('db-status').textContent = error.message || String(error);
  });
});
$('db-page-size').addEventListener('change', () => {
  dbState.limit = Number($('db-page-size').value) || 25;
  void loadDatabaseRows({ offset: 0 }).catch((error) => {
    $('db-status').textContent = error.message || String(error);
  });
});
$('btn-db-prev').addEventListener('click', () => {
  void loadDatabaseRows({ offset: Math.max(dbState.offset - dbState.limit, 0) }).catch((error) => {
    $('db-status').textContent = error.message || String(error);
  });
});
$('btn-db-next').addEventListener('click', () => {
  void loadDatabaseRows({ offset: dbState.offset + dbState.limit }).catch((error) => {
    $('db-status').textContent = error.message || String(error);
  });
});

function updateResetButton() {
  const armed = $('db-reset-confirm').value.trim() === 'RESET';
  const running = Boolean(state.status && (state.status.state === 'running' || state.status.state === 'starting'));
  const button = $('btn-db-reset');
  button.disabled = !armed || running;
  button.title = running
    ? 'Stop the application server before resetting the database.'
    : armed ? 'Delete every record and rebuild the schema.' : 'Type RESET to enable this button.';
}

$('db-reset-confirm').addEventListener('input', updateResetButton);

$('btn-db-reset').addEventListener('click', () => {
  const task = withBusy($('btn-db-reset'), 'Resetting...', async () => {
    const confirmation = $('db-reset-confirm').value.trim();
    if (confirmation !== 'RESET') throw new Error('Type RESET to confirm the database reset.');
    if (!window.confirm('Reset the database? Every record will be deleted and the schema rebuilt. A safety backup is created first when possible.')) return;
    $('db-reset-status').textContent = 'Resetting the database...';
    const result = await api.resetDatabase({ confirmed: true });
    if (!result.ok) throw new Error(result.error);
    $('db-reset-confirm').value = '';
    $('db-reset-status').textContent = result.message || 'Database reset complete.';
    updateResetButton();
    await refresh();
    await loadDatabaseTables();
    banner(result.message || 'Database reset complete.', 'ok');
  });
  void task.then(updateResetButton, updateResetButton);
});

// ---------------------------------------------------------------- navigation

document.querySelectorAll('.nav button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.nav button').forEach((node) => node.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((node) => node.classList.remove('active'));
    button.classList.add('active');
    const tab = $('tab-' + button.dataset.tab);
    if (tab) tab.classList.add('active');
    if (button.dataset.tab === 'logs') {
      const view = $('log-view');
      view.scrollTop = view.scrollHeight;
    }
    if (button.dataset.tab === 'users') {
      void loadUsers().catch((error) => { $('user-list-status').textContent = error.message; });
    }
    if (button.dataset.tab === 'features') {
      void loadFeatures().catch((error) => banner(error.message || String(error)));
    }
    if (button.dataset.tab === 'database') {
      updateResetButton();
      void loadDatabaseTables().catch((error) => {
        $('db-status').textContent = error.message || String(error);
      });
    }
  });
});

// ------------------------------------------------------------------ actions

$('btn-start').addEventListener('click', () => withBusy($('btn-start'), 'Starting...', async () => {
  const result = await api.start();
  if (!result.ok) throw new Error(result.error);
  await refresh();
  banner('Server started. Share a LAN address to let employees sign in.', 'ok');
}));

$('btn-stop').addEventListener('click', () => withBusy($('btn-stop'), 'Stopping...', async () => {
  await api.stop();
  await refresh();
  banner('Server stopped. It will remain offline until you start it again.', 'ok');
}));

$('btn-restart').addEventListener('click', () => withBusy($('btn-restart'), 'Restarting...', async () => {
  const result = await api.restart();
  if (!result.ok) throw new Error(result.error);
  await refresh();
  banner('Server restarted.', 'ok');
}));

$('btn-open-app').addEventListener('click', () => api.open('app'));
$('btn-open-board').addEventListener('click', () => api.open('board'));
$('btn-open-backend').addEventListener('click', () => api.open('backend'));
$('btn-open-logs').addEventListener('click', () => api.open('logs'));
$('btn-refresh').addEventListener('click', () => withBusy($('btn-refresh'), 'Checking...', refresh));

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function loadBackups() {
  const body = $('backup-table-body');
  body.textContent = '';
  const result = await api.listBackups();
  if (!result.backups.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'muted';
    cell.textContent = 'No backups yet. Create one before making database changes.';
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }
  for (const backup of result.backups) {
    const row = document.createElement('tr');
    const name = document.createElement('td'); name.textContent = backup.name;
    const size = document.createElement('td'); size.textContent = formatBytes(backup.size);
    const created = document.createElement('td'); created.textContent = new Date(backup.createdAt).toLocaleString();
    const actions = document.createElement('td'); actions.className = 'actions';
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'small danger'; restore.textContent = 'Restore';
    restore.disabled = Boolean(state.status && state.status.state === 'running');
    restore.title = restore.disabled ? 'Stop the server before restoring a backup.' : 'Replace the current database with this backup.';
    restore.addEventListener('click', () => void withBusy(restore, 'Restoring...', async () => {
      const confirmed = window.confirm(`Restore ${backup.name}? This replaces current database contents. Stop the server first and ensure you have a recent backup.`);
      if (!confirmed) return;
      await api.restoreBackup({ name: backup.name, confirmed: true });
      $('backup-status').textContent = `Restored ${backup.name}.`;
      await refresh();
      await loadBackups();
    }));
    actions.appendChild(restore);
    row.append(name, size, created, actions);
    body.appendChild(row);
  }
}

$('btn-refresh-backups').addEventListener('click', () => withBusy($('btn-refresh-backups'), 'Loading...', loadBackups));
$('btn-create-backup').addEventListener('click', () => withBusy($('btn-create-backup'), 'Creating...', async () => {
  const backup = await api.createBackup();
  $('backup-status').textContent = `Backup created: ${backup.name} (${formatBytes(backup.size)}).`;
  await loadBackups();
}));

$('btn-setup-env').addEventListener('click', () => withBusy($('btn-setup-env'), 'Setting up...', async () => {
  await api.setup();
  await refresh();
  banner('Python environment is ready.', 'ok');
}));

$('btn-save-db').addEventListener('click', () => withBusy($('btn-save-db'), 'Saving...', async () => {
  const value = $('setup-db-url').value.trim();
  if (!value) throw new Error('Enter a DATABASE_URL first.');
  await api.saveEnv({ DATABASE_URL: value });
  releaseUnsavedEdits(['set-db-url']);
  await refresh();
  banner('Database URL saved. Run Initialize Schema when Postgres is ready.', 'ok');
}));

$('btn-test-db').addEventListener('click', () => withBusy($('btn-test-db'), 'Testing...', async () => {
  const result = await api.testDatabase();
  $('setup-db-status').textContent = result.detail || 'Database check complete.';
  banner(result.detail || 'Database check complete.', result.ok ? 'ok' : 'error');
}));

$('btn-init-db').addEventListener('click', () => withBusy($('btn-init-db'), 'Initializing...', async () => {
  await api.initDatabase();
  await refresh();
  $('setup-db-status').textContent = 'Schema initialized.';
  banner('Database schema is ready.', 'ok');
}));

$('btn-create-admin').addEventListener('click', () => withBusy($('btn-create-admin'), 'Creating...', async () => {
  const payload = {
    name: $('admin-name').value.trim(),
    email: $('admin-email').value.trim(),
    password: $('admin-password').value
  };
  if (!payload.email || !payload.password) throw new Error('Email and password are required.');
  const result = $('admin-reset').checked
    ? await api.resetPassword(payload)
    : await api.createAdmin(payload);
  $('setup-admin-status').textContent = result.detail || 'Administrator saved.';
  $('admin-password').value = '';
  banner($('admin-reset').checked ? 'Password updated.' : 'Administrator account created.', 'ok');
}));

$('btn-generate-jwt').addEventListener('click', () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  $('set-jwt').value = hex;
});

$('btn-save-settings').addEventListener('click', () => withBusy($('btn-save-settings'), 'Saving...', async () => {
  const port = Number($('set-port').value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  if (port < 1024 && !portAllowedBelow1024()) {
    throw new Error(`Port ${port} is privileged on this system. Use a port above 1024 or start the manager with administrator rights.`);
  }
  await api.saveSettings({
    port,
    host: $('set-host').value,
    autoStart: $('set-autostart').checked,
    autoRestart: $('set-autorestart').checked,
    openOnStart: $('set-openonstart').checked
  });
  // The organization name sits in this card too, so honour a pending rename here.
  let orgNameNote = '';
  if (dirtyFields.has('set-org')) {
    const name = $('set-org').value.trim() || 'RealtimeSuite';
    await api.saveEnv({ ORGANIZATION_NAME: name });
    orgNameNote = await applyOrganizationToDatabase(name);
    releaseUnsavedEdits(['set-org']);
  }
  releaseUnsavedEdits(['set-port', 'set-host']);
  await refresh();
  banner(`Manager settings saved.${orgNameNote}`, orgNameNote ? 'warn' : 'ok');
}));

function portAllowedBelow1024() {
  // Windows does not reserve the low ports for administrators; macOS and Linux do.
  return Boolean(state.check && state.check.lowPortsAllowed);
}

async function applyOrganizationToDatabase(name) {
  try {
    const result = await api.setOrganizationName(name);
    return result && result.ok === false
      ? ` Organization name was saved but not applied to the database: ${result.error}`
      : '';
  } catch (error) {
    return ' Organization name is saved to .env and will apply once the database is initialized.';
  }
}

$('btn-save-env').addEventListener('click', () => withBusy($('btn-save-env'), 'Saving...', async () => {
  const updates = {
    PORT: String(Number($('set-port').value) || 8000),
    HOST: $('set-host').value,
    ORGANIZATION_NAME: $('set-org').value.trim() || 'RealtimeSuite'
  };
  const jwt = $('set-jwt').value.trim();
  if (jwt) updates.JWT_SECRET = jwt;
  updates.OPSBOARD_TOKEN = $('set-board-token').value.trim();
  const githubPoll = Number($('set-github-poll').value);
  if (!Number.isInteger(githubPoll) || githubPoll < 1 || githubPoll > 1440) {
    throw new Error('GitHub sync interval must be between 1 and 1440 minutes.');
  }
  updates.GITHUB_REPOS = $('set-github-repos').value.trim();
  updates.GITHUB_POLL_MINUTES = String(githubPoll);
  const githubToken = $('set-github-token').value.trim();
  if (githubToken) updates.GITHUB_TOKEN = githubToken;
  await api.saveEnv(updates);
  releaseUnsavedEdits([
    'set-port', 'set-host', 'set-org', 'set-jwt', 'set-board-token',
    'set-github-repos', 'set-github-poll', 'set-github-token'
  ]);
  const orgNameNote = await applyOrganizationToDatabase(updates.ORGANIZATION_NAME);
  await refresh();
  banner(
    `Server configuration saved. Restart the server to apply the GitHub sync settings.${orgNameNote}`,
    orgNameNote ? 'warn' : 'ok'
  );
}));

$('btn-refresh-users').addEventListener('click', () => withBusy($('btn-refresh-users'), 'Loading...', loadUsers));

$('btn-generate-password').addEventListener('click', () => {
  $('user-password').value = generatePassword();
  $('user-password').focus();
  $('user-password').select();
});

$('btn-create-user').addEventListener('click', () => withBusy($('btn-create-user'), 'Creating...', async () => {
  const payload = {
    name: $('user-name').value.trim(),
    email: $('user-email').value.trim(),
    role: $('user-role').value,
    password: $('user-password').value
  };
  if (!payload.name) throw new Error('Enter the person\'s full name.');
  if (!payload.email.includes('@')) throw new Error('Enter a valid email address.');
  if (payload.password.length < 8) throw new Error('Password must be at least 8 characters.');
  const result = await api.createUser(payload);
  if (!result.ok) throw new Error(result.error);
  state.users = result.users;
  renderUsers();
  $('user-name').value = '';
  $('user-email').value = '';
  $('user-password').value = '';
  $('user-role').value = 'employee';
  $('user-list-status').textContent = `Created ${payload.email.toLowerCase()}. Share the temporary password with them.`;
  banner(`Account created for ${payload.email.toLowerCase()}.`, 'ok');
}));

$('btn-feature-save').addEventListener('click', () => withBusy($('btn-feature-save'), 'Saving...', async () => {
  const patch = featureChanges();
  if (Object.keys(patch).length === 0) {
    banner('No feature changes to save.', 'ok');
    return;
  }
  const result = await api.setFeatures(patch);
  if (!result.ok) throw new Error(result.error);
  state.features = result.flags;
  state.featureDraft = { ...result.flags };
  renderFeatures();
  banner(`Saved ${Object.keys(patch).length} feature change${Object.keys(patch).length === 1 ? '' : 's'}. Reload RealtimeSuite to see them.`, 'ok');
}));

$('btn-feature-reset').addEventListener('click', () => {
  if (!state.featureSchema) return;
  state.featureDraft = { ...state.featureSchema.defaults };
  renderFeatures();
});

$('btn-clear-logs').addEventListener('click', async () => {
  await api.clearLogs();
  $('log-view').textContent = '';
  state.logs = [];
});

api.onLog((entry) => appendLog(entry));
api.onStatus((status) => {
  renderStatus(status);
  updateResetButton();
});
api.onLogsCleared(() => {
  $('log-view').textContent = '';
  state.logs = [];
});

window.setInterval(() => {
  if (state.status) $('fact-uptime').textContent = formatUptime(state.status.startedAt);
}, 1000);

trackUnsavedEdits();
refresh().then(() => loadBackups()).catch((error) => banner(error.message || String(error)));
