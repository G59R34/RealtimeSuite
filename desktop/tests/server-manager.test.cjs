'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ServerManager,
  parseEnv,
  upsertEnv,
  pythonCandidates,
  versionAtLeast,
  parseTrailingJson,
  cliFailureMessage
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
