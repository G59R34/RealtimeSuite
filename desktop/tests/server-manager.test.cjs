'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const {
  ServerManager,
  parseEnv,
  upsertEnv,
  pythonCandidates,
  versionAtLeast,
  parseTrailingJson,
  cliFailureMessage,
  quoteIdent,
  normalizeDatabaseValue,
  formatDatabaseValue
} = require('../electron/server-manager.cjs');

function tempBackend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-manager-'));
  fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app', 'main.py'), '# test');
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'fastapi\n');
  fs.writeFileSync(
    path.join(dir, '.env.example'),
    '# example\nDATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:5432/suite\nPORT=8000\nJWT_SECRET=change-me\n'
  );
  return dir;
}

test('parseEnv ignores comments and strips quotes', () => {
  const values = parseEnv('# note\nA=1\nB="two"\nC=\'three\'\nBAD LINE\n');
  assert.deepEqual(values, { A: '1', B: 'two', C: 'three' });
});

test('upsertEnv updates in place and appends missing keys', () => {
  const text = '# config\nPORT=8000\nHOST=0.0.0.0\n';
  const next = upsertEnv(text, { PORT: '9000', ORGANIZATION_NAME: 'Ops' });
  assert.match(next, /^# config\nPORT=9000\nHOST=0\.0\.0\.0\n\nORGANIZATION_NAME=Ops\n$/);
});

test('pythonCandidates differ per platform', () => {
  const mac = pythonCandidates('darwin', {});
  const win = pythonCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
  const linux = pythonCandidates('linux', {});
  assert.ok(mac.includes('/opt/homebrew/bin/python3'));
  assert.ok(win.some((entry) => entry.endsWith('python.exe')));
  assert.ok(win.includes('py'));
  assert.deepEqual(linux.slice(0, 2), ['/usr/bin/python3', '/usr/local/bin/python3']);
});

test('versionAtLeast enforces Python 3.10+', () => {
  assert.equal(versionAtLeast('3.10.2', 3, 10), true);
  assert.equal(versionAtLeast('3.9.18', 3, 10), false);
  assert.equal(versionAtLeast('4.0.0', 3, 10), true);
});

test('manager reads and writes .env inside the backend folder', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });

  const envPath = await manager.ensureEnvFile();
  assert.equal(envPath, path.join(backendDir, '.env'));
  assert.equal(manager.readEnv().PORT, '8000');

  await manager.applyEnvValues({ PORT: '8123', ORGANIZATION_NAME: 'Test Org' });
  assert.equal(manager.readEnv().PORT, '8123');
  assert.equal(manager.readEnv().ORGANIZATION_NAME, 'Test Org');

  await manager.saveSettings({ port: 8123, autoRestart: false });
  const reloaded = new ServerManager({ backendDir, userDataDir });
  assert.equal(reloaded.settings.port, 8123);
  assert.equal(reloaded.settings.autoRestart, false);
});

test('saveSettings accepts low ports and rejects out-of-range ones', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });
  await manager.ensureEnvFile();

  const saved = await manager.saveSettings({ port: 53 });
  assert.equal(saved.port, 53);
  assert.equal(manager.readEnv().PORT, '53');

  await assert.rejects(() => manager.saveSettings({ port: 0 }), /between 1 and 65535/);
  await assert.rejects(() => manager.saveSettings({ port: 70000 }), /between 1 and 65535/);
  await assert.rejects(() => manager.saveSettings({ port: 80.5 }), /between 1 and 65535/);
  assert.equal(manager.settings.port, 53);
});

test('check reports whether privileged ports are usable', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });
  const check = await manager.check();
  assert.equal(check.lowPortsAllowed, process.platform === 'win32');
});

test('setOrganizationName validates the name and goes through the admin CLI', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });

  await assert.rejects(() => manager.setOrganizationName('   '), /Enter an organization name/);
  await assert.rejects(() => manager.setOrganizationName('x'.repeat(121)), /120 characters/);
  // Without a virtualenv the CLI path cannot run: proves the rename is applied to the database, not just .env.
  await assert.rejects(() => manager.setOrganizationName('Kateo Ops'), /Python environment/);
});

test('status exposes local app and board URLs', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });
  await manager.ensureEnvFile();
  await manager.applyEnvValues({ PORT: '8111' });
  const status = manager.getStatus();
  assert.equal(status.state, 'stopped');
  assert.equal(status.port, 8111);
  assert.equal(status.url, 'http://127.0.0.1:8111/');
  assert.equal(status.boardUrl, 'http://127.0.0.1:8111/opsboard.html');
  assert.ok(status.lanUrls.some((url) => url.endsWith(':8111')));
});

test('setup waits for pip upgrade to succeed before installing dependencies', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const venvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-venv-'));
  const pythonPath = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, '');
  const manager = new ServerManager({ backendDir, userDataDir, venvDir });
  manager.detectPython = async () => ({ path: 'python', version: '3.12.0' });
  const commands = [];
  manager.run = async (_command, args) => {
    commands.push(args);
    return { code: args.includes('--upgrade') ? 1 : 0, output: 'pip failure' };
  };

  await assert.rejects(manager.setupEnvironment(), /upgrade pip/i);
  assert.equal(commands.length, 1);
});

test('backup listing only exposes manager-created dump files and restore rejects unsafe requests', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });
  fs.mkdirSync(manager.backupDir, { recursive: true });
  fs.writeFileSync(path.join(manager.backupDir, 'realtimesuite-2026-10-24T12-00-00-000Z.dump'), 'backup');
  fs.writeFileSync(path.join(manager.backupDir, 'notes.txt'), 'not a backup');
  assert.equal((await manager.listBackups()).length, 1);
  await assert.rejects(manager.restoreBackup('../secrets.dump', true), /valid backup/);
  await assert.rejects(manager.restoreBackup('realtimesuite-2026-10-24T12-00-00-000Z.dump', false), /explicit confirmation/);
  manager.state = 'running';
  await assert.rejects(manager.restoreBackup('realtimesuite-2026-10-24T12-00-00-000Z.dump', true), /Stop the application server/);
});

test('PostgreSQL client configuration keeps credentials out of command-line arguments', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });
  await manager.ensureEnvFile();
  await manager.applyEnvValues({ DATABASE_URL: 'postgresql+psycopg://user%40name:p%40ss@db.example:5544/suite?sslmode=require' });
  const config = manager.postgresClientConfig();
  assert.equal(config.database, 'suite');
  assert.deepEqual(config.env, {
    PGHOST: 'db.example', PGPORT: '5544', PGDATABASE: 'suite',
    PGUSER: 'user@name', PGPASSWORD: 'p@ss', PGSSLMODE: 'require'
  });
});

test('local PostgreSQL auto-start only targets a local configured database', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const commands = [];
  const manager = new ServerManager({
    backendDir, userDataDir, platform: 'win32',
    systemCommand: async (command, args) => {
      commands.push([command, args]);
      if (args[0] === 'query') return { code: 0, output: 'SERVICE_NAME: postgresql-x64-16\n' };
      return { code: 0, output: '[SC] StartService SUCCESS' };
    }
  });
  await manager.ensureEnvFile();
  await manager.applyEnvValues({ DATABASE_URL: 'postgresql+psycopg://postgres@127.0.0.1:55432/suite' });
  const result = await manager.startLocalPostgres();
  assert.equal(result.started, true);
  assert.deepEqual(commands[1], ['sc.exe', ['start', 'postgresql-x64-16']]);
  commands.length = 0;
  await manager.applyEnvValues({ DATABASE_URL: 'postgresql+psycopg://postgres@db.example:5432/suite' });
  const remote = await manager.startLocalPostgres();
  assert.equal(remote.attempted, false);
  assert.equal(commands.length, 0);
});

test('embedded PostgreSQL configuration defaults to a persistent isolated data directory', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir, resourcesDir: '/app/resources' });
  await manager.ensureEnvFile();
  const config = manager.embeddedPostgresRuntimeConfig();
  assert.deepEqual(config, { host: '127.0.0.1', port: 5432, database: 'suite' });
  assert.equal(manager.embeddedPostgresDataDir(), path.join(userDataDir, 'postgres-data'));
  assert.equal(manager.embeddedPostgresModulesPath(), path.join('/app/resources', 'postgres', 'node_modules'));
  await manager.applyEnvValues({ DATABASE_URL: 'postgresql+psycopg://postgres@db.example:5432/suite' });
  assert.throws(() => manager.embeddedPostgresRuntimeConfig(), /remote/);
  await manager.applyEnvValues({ DATABASE_URL: 'postgresql+psycopg://admin@127.0.0.1:5432/suite' });
  assert.throws(() => manager.embeddedPostgresRuntimeConfig(), /postgres user/);
});

test('running from source reads the bundled PostgreSQL runtime from the project', () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const original = process.resourcesPath;
  // Electron sets this path even when the app is not packaged; it must not win.
  Object.defineProperty(process, 'resourcesPath', {
    value: path.join('/electron', 'dist', 'resources'),
    configurable: true
  });
  try {
    const manager = new ServerManager({ backendDir, userDataDir, resourcesDir: '' });
    assert.equal(manager.embeddedPostgresModulesPath(), path.resolve(__dirname, '..', 'node_modules'));
  } finally {
    Object.defineProperty(process, 'resourcesPath', { value: original, configurable: true });
  }
});

test('embedded PostgreSQL initializes only a new data directory and preserves it on shutdown', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const dataDir = path.join(userDataDir, 'postgres-data');
  const calls = [];
  const manager = new ServerManager({
    backendDir, userDataDir,
    embeddedPostgresFactory: class FakePostgres {
      constructor(options) { calls.push(['construct', options]); }
      async initialise() { calls.push(['initialise']); fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, 'PG_VERSION'), '16'); }
      async start() { calls.push(['start']); }
      async createDatabase(name) { calls.push(['createDatabase', name]); }
      getPgClient() { return { connect: async () => {}, query: async () => ({ rowCount: 1 }), end: async () => {} }; }
      async stop() { calls.push(['stop']); }
    }
  });
  await manager.ensureEnvFile();
  manager.embeddedDatabaseExists = async () => true;
  const started = await manager.startEmbeddedPostgres();
  assert.equal(started.started, true);
  assert.ok(calls.some(([call]) => call === 'initialise'));
  assert.ok(calls.some(([call]) => call === 'start'));
  await manager.stopEmbeddedPostgres();
  assert.ok(fs.existsSync(path.join(dataDir, 'PG_VERSION')));
  calls.length = 0;
  await manager.startEmbeddedPostgres();
  assert.ok(!calls.some(([call]) => call === 'initialise'));
});

test('local PostgreSQL auto-start reports when no Windows service is installed', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir, platform: 'win32', systemCommand: async () => ({ code: 0, output: 'No services' }) });
  await manager.ensureEnvFile();
  const result = await manager.startLocalPostgres();
  assert.equal(result.attempted, false);
  assert.match(result.detail, /No installed PostgreSQL Windows service/);
});

test('database probe sends a real multiline Python script to the venv', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const venvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-venv-'));
  const pythonPath = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
  fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
  fs.writeFileSync(pythonPath, '');
  const manager = new ServerManager({ backendDir, userDataDir, venvDir });
  await manager.ensureEnvFile();
  await manager.applyEnvValues({ DATABASE_URL: 'postgresql+psycopg://postgres@127.0.0.1:5432/suite' });
  manager.run = async (_command, args) => {
    assert.ok(args[1].includes('\ntry:\n'));
    assert.ok(!args[1].includes('\\ntry:'));
    return { code: 0, output: 'CONNECTED:suite' };
  };
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await manager.applyEnvValues({ DATABASE_URL: `postgresql+psycopg://postgres@127.0.0.1:${server.address().port}/suite` });
  try {
    const result = await manager.probeDatabase();
    assert.equal(result.ok, true);
    assert.match(result.detail, /Connected to database suite/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('database probe reports unreachable Postgres with actionable host and port', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });
  await manager.ensureEnvFile();
  await manager.applyEnvValues({ DATABASE_URL: 'postgresql+psycopg://postgres@127.0.0.1:1/suite' });
  const result = await manager.probeDatabase();
  assert.equal(result.ok, false);
  assert.match(result.detail, /127\.0\.0\.1:1/);
  assert.match(result.detail, /Start the PostgreSQL service/);
});

test('backup creation requires a valid PostgreSQL URL and database name', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });
  await manager.ensureEnvFile();
  await manager.applyEnvValues({ DATABASE_URL: 'not-a-url' });
  await assert.rejects(manager.createBackup(), /valid PostgreSQL URL/);
  await manager.applyEnvValues({ DATABASE_URL: 'postgresql://localhost/' });
  await assert.rejects(manager.createBackup(), /include a database name/);
});

test('check reports backend, env and frontend readiness', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });
  await manager.ensureEnvFile();
  const check = await manager.check();
  assert.equal(check.backendExists, true);
  assert.equal(check.envExists, true);
  assert.equal(check.requirementsExists, true);
  assert.equal(check.config.port, 8000);
});

test('parseTrailingJson reads the last JSON line from CLI output', () => {
  const text = 'warning: pip\n[{"email":"a@b.c"}]\n';
  assert.deepEqual(parseTrailingJson(text), [{ email: 'a@b.c' }]);
  assert.deepEqual(parseTrailingJson('{"a":1}\ntrailing chatter\n'), { a: 1 });
  assert.equal(parseTrailingJson('nothing here'), null);
});

test('cliFailureMessage prefers the CLI error line', () => {
  const output = 'Traceback...\nSystemExit: Cannot delete the last administrator account.\n';
  assert.equal(
    cliFailureMessage(output, 'fallback'),
    'Cannot delete the last administrator account.'
  );
  assert.equal(cliFailureMessage('', 'fallback'), 'fallback');
});

test('user creation validates input before touching the environment', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });

  await assert.rejects(manager.createUser({ email: 'nope', name: 'A', password: 'longenough' }), /valid email/i);
  await assert.rejects(manager.createUser({ email: 'a@b.c', name: '', password: 'longenough' }), /name/i);
  await assert.rejects(manager.createUser({ email: 'a@b.c', name: 'A', password: 'short' }), /8 characters/i);
  await assert.rejects(manager.deleteUser({ email: '' }), /account/i);
  await assert.rejects(manager.setFeatures({}), /at least one/i);
});

test('custom env file keeps packaged installs out of the read-only app bundle', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const envFile = path.join(userDataDir, '.env');
  const manager = new ServerManager({ backendDir, userDataDir, envFile });

  await manager.ensureEnvFile();
  assert.equal(manager.envPath(), envFile);
  await manager.applyEnvValues({ PORT: '8022', ORGANIZATION_NAME: 'Packaged' });
  assert.equal(manager.readEnv().PORT, '8022');
  assert.equal(manager.readEnv().ORGANIZATION_NAME, 'Packaged');
  assert.equal(fs.existsSync(path.join(backendDir, '.env')), false);
});

test('database identifiers are quoted and values are normalised for PostgreSQL', () => {
  assert.equal(quoteIdent('shifts'), '"shifts"');
  assert.equal(quoteIdent('odd"name'), '"odd""name"');
  assert.equal(normalizeDatabaseValue('NULL'), null);
  assert.equal(normalizeDatabaseValue(null), null);
  assert.equal(normalizeDatabaseValue('null'), 'null');
  assert.equal(normalizeDatabaseValue('2026-10-24T08:30:00Z'), '2026-10-24T08:30:00Z');
  assert.equal(formatDatabaseValue(null), null);
  assert.equal(formatDatabaseValue({ a: 1 }), '{"a":1}');
  assert.equal(formatDatabaseValue(12), '12');
});

test('database reset requires confirmation and a stopped server', async () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const manager = new ServerManager({ backendDir, userDataDir });

  await assert.rejects(manager.resetDatabase({}), /explicit confirmation/);
  manager.state = 'running';
  await assert.rejects(manager.resetDatabase({ confirmed: true }), /Stop the application server/);
  manager.state = 'stopped';
  await assert.rejects(manager.resetDatabase({ confirmed: true }), /Python environment/);
});

test('packaged installs can place the virtual environment outside the app bundle', () => {
  const backendDir = tempBackend();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-user-'));
  const venvDir = path.join(userDataDir, 'python-venv');
  const manager = new ServerManager({ backendDir, userDataDir, venvDir });
  const expected = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
  assert.equal(manager.venvPythonPath(), expected);
});
