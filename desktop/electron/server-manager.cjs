'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const LOG_LIMIT = 800;
const HEALTH_INTERVAL_MS = 2000;
const START_TIMEOUT_MS = 90000;

function isWindows() {
  return process.platform === 'win32';
}

function nowIso() {
  return new Date().toISOString();
}

function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function upsertEnv(text, updates) {
  const lines = text.length ? text.split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const out = [];
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && pending.has(match[1])) {
      out.push(`${match[1]}=${pending.get(match[1])}`);
      pending.delete(match[1]);
    } else {
      out.push(line);
    }
  }
  if (pending.size) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    for (const [key, value] of pending) out.push(`${key}=${value}`);
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

function pythonCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const found = [];
    if (env.LOCALAPPDATA) {
      found.push(path.join(env.LOCALAPPDATA, 'Programs', 'Python', 'Python312', 'python.exe'));
      found.push(path.join(env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe'));
      found.push(path.join(env.LOCALAPPDATA, 'Programs', 'Python', 'Python310', 'python.exe'));
    }
    if (env.ProgramFiles) {
      found.push(path.join(env.ProgramFiles, 'Python312', 'python.exe'));
      found.push(path.join(env.ProgramFiles, 'Python311', 'python.exe'));
    }
    return [...found, 'py', 'python', 'python3'];
  }
  const versioned = ['python3.13', 'python3.12', 'python3.11', 'python3.10'];
  if (platform === 'darwin') {
    return ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3', ...versioned];
  }
  return ['/usr/bin/python3', '/usr/local/bin/python3', 'python3', ...versioned];
}

function versionTuple(value) {
  return String(value)
    .trim()
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(value, major, minor) {
  const [a = 0, b = 0] = versionTuple(value);
  return a > major || (a === major && b >= minor);
}

function parseTrailingJson(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep scanning upwards */
    }
  }
  return null;
}

function cliFailureMessage(output, fallback) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || '';
  return last.replace(/^SystemExit:\s*/, '') || fallback;
}

class ServerManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.backendDir = options.backendDir || path.resolve(__dirname, '..', '..', 'backend');
    this.userDataDir = options.userDataDir || path.join(os.homedir(), '.realtimesuite-manager');
    this.envFile = options.envFile || path.join(this.backendDir, '.env');
    this.venvDir = options.venvDir || path.join(this.backendDir, '.venv');
    this.settingsFile = path.join(this.userDataDir, 'settings.json');
    this.logFile = path.join(this.userDataDir, 'logs', 'server.log');
    this.settings = this.readSettings();
    this.logs = [];
    this.child = null;
    this.state = 'stopped';
    this.desiredRunning = false;
    this.startedAt = null;
    this.pid = null;
    this.healthTimer = null;
    this.restartTimer = null;
    this.lastError = null;
    this._logBuffer = '';
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
  }

  // ---------------------------------------------------------------- settings

  readSettings() {
    const defaults = {
      pythonPath: '',
      port: 8000,
      host: '0.0.0.0',
      autoStart: false,
      autoRestart: true,
      openOnStart: true
    };
    try {
      const raw = fs.readFileSync(this.settingsFile, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  }

  async saveSettings(patch) {
    if (patch && patch.port !== undefined) {
      const port = Number(patch.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Port must be between 1 and 65535.');
      }
      if (port < 1024 && process.platform !== 'win32') {
        throw new Error(`Port ${port} is privileged on this system. Use a port above 1024.`);
      }
    }
    this.settings = { ...this.settings, ...patch };
    await fsp.mkdir(this.userDataDir, { recursive: true });
    await fsp.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf8');
    if (this.settings.port) {
      // Await the write so a saved port is on disk before the server restarts.
      await this.applyEnvValues({ PORT: String(this.settings.port) }).catch(() => undefined);
    }
    this.emitStatus();
    return this.settings;
  }

  // -------------------------------------------------------------------- logs

  log(stream, text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter((line) => line.length > 0);
    for (const line of lines) {
      const entry = { stream, line, at: nowIso() };
      this.logs.push(entry);
      if (this.logs.length > LOG_LIMIT) this.logs.shift();
      this.emit('log', entry);
      fs.appendFile(this.logFile, `[${entry.at}] [${stream}] ${line}\n`, () => undefined);
    }
  }

  clearLogs() {
    this.logs = [];
    this.emit('logs-cleared');
  }

  getLogs() {
    return this.logs.slice();
  }

  // ------------------------------------------------------------------- paths

  venvPythonPath() {
    return isWindows()
      ? path.join(this.venvDir, 'Scripts', 'python.exe')
      : path.join(this.venvDir, 'bin', 'python');
  }

  envPath() {
    return this.envFile;
  }

  requirementsPath() {
    return path.join(this.backendDir, 'requirements.txt');
  }

  readEnvText() {
    try {
      return fs.readFileSync(this.envPath(), 'utf8');
    } catch {
      return '';
    }
  }

  readEnv() {
    return parseEnv(this.readEnvText());
  }

  async ensureEnvFile() {
    await fsp.mkdir(path.dirname(this.envPath()), { recursive: true });
    try {
      await fsp.access(this.envPath());
    } catch {
      const example = path.join(this.backendDir, '.env.example');
      let text = '';
      try {
        text = await fsp.readFile(example, 'utf8');
      } catch {
        text = [
          'DATABASE_URL=postgresql+psycopg://postgres@127.0.0.1:5432/suite',
          'JWT_SECRET=change-me-before-deploying',
          'HOST=0.0.0.0',
          'PORT=8000',
          'ORGANIZATION_NAME=RealtimeSuite'
        ].join('\n');
      }
      await fsp.writeFile(this.envPath(), `${text.replace(/\n+$/, '')}\n`, 'utf8');
    }
    return this.envPath();
  }

  async applyEnvValues(updates) {
    await this.ensureEnvFile();
    const current = this.readEnvText();
    await fsp.writeFile(this.envPath(), upsertEnv(current, updates), 'utf8');
    return this.readEnv();
  }

  // ------------------------------------------------------------------ python

  async detectPython() {
    if (this.settings.pythonPath) {
      const version = await this.pythonVersion(this.settings.pythonPath);
      if (version) return { path: this.settings.pythonPath, version };
    }
    const candidates = [...pythonCandidates()];
    if (process.platform === 'win32') {
      for (const base of [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Python') : '',
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Python') : ''
      ]) {
        if (!base) continue;
        try {
          for (const entry of fs.readdirSync(base)) {
            if (/^Python3\d+$/.test(entry)) candidates.push(path.join(base, entry, 'python.exe'));
          }
        } catch {
          /* folder not present */
        }
      }
    }
    for (const candidate of candidates) {
      const version = await this.pythonVersion(candidate);
      if (version && versionAtLeast(version, 3, 10)) return { path: candidate, version };
    }
    return null;
  }

  pythonVersion(command) {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      const child = spawn(command, ['-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, 8000);
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return finish(null);
        const match = output.match(/\d+\.\d+\.\d+/);
        finish(match ? match[0] : null);
      });
    });
  }

  async run(command, args, options = {}) {
    return new Promise((resolve) => {
      const output = [];
      const child = spawn(command, args, {
        cwd: options.cwd || this.backendDir,
        env: {
          ...process.env,
          // Packaged installs keep .env outside the app bundle; commands such as
          // app.cli must receive the same configuration as the server process.
          ...this.readEnv(),
          PYTHONUNBUFFERED: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          ...(options.env || {})
        },
        windowsHide: true
      });
      const onChunk = (stream) => (chunk) => {
        const text = chunk.toString();
        output.push(text);
        for (const line of text.split(/\r?\n/)) {
          if (line) this.log(stream, line);
        }
      };
      if (typeof options.input === 'string' && child.stdin) {
        child.stdin.end(options.input);
      }
      child.stdout.on('data', onChunk('stdout'));
      child.stderr.on('data', onChunk('stderr'));
      child.on('error', (error) => {
        this.log('stderr', error.message);
        resolve({ code: -1, output: output.join('') });
      });
      child.on('close', (code) => resolve({ code: code ?? -1, output: output.join('') }));
    });
  }

  // ------------------------------------------------------------------- check

  async check() {
    const envExists = fs.existsSync(this.envPath());
    const venvExists = fs.existsSync(this.venvPythonPath());
    const python = await this.detectPython();
    const env = this.readEnv();
    return {
      backendDir: this.backendDir,
      lowPortsAllowed: process.platform === 'win32',
      backendExists: fs.existsSync(path.join(this.backendDir, 'app', 'main.py')),
      frontendBuilt: fs.existsSync(path.join(this.backendDir, '..', 'frontend', 'dist', 'index.html')),
      envExists,
      venvExists,
      requirementsExists: fs.existsSync(this.requirementsPath()),
      python,
      config: {
        databaseUrl: env.DATABASE_URL || '',
        port: Number(env.PORT || this.settings.port || 8000),
        host: env.HOST || this.settings.host || '0.0.0.0',
        organizationName: env.ORGANIZATION_NAME || 'RealtimeSuite',
        adminEmail: env.BOOTSTRAP_ADMIN_EMAIL || 'admin@realtimesuite.local',
        opsboardTokenSet: Boolean(env.OPSBOARD_TOKEN),
        jwtSecretSet: Boolean(env.JWT_SECRET && env.JWT_SECRET !== 'change-me-before-deploying'),
        githubTokenSet: Boolean(env.GITHUB_TOKEN),
        githubRepos: env.GITHUB_REPOS || '',
        githubPollMinutes: Number(env.GITHUB_POLL_MINUTES || 5)
      }
    };
  }

  // ------------------------------------------------------------------ actions

  async setupEnvironment() {
    await this.ensureEnvFile();
    const python = await this.detectPython();
    if (!python) {
      throw new Error('Python 3.10+ was not found. Install Python from https://python.org and try again.');
    }
    this.log('system', `Using Python ${python.version} at ${python.path}`);
    if (!fs.existsSync(this.venvPythonPath())) {
      this.log('system', `Creating virtual environment at ${this.venvDir}...`);
      await fsp.mkdir(path.dirname(this.venvDir), { recursive: true });
      const created = await this.run(python.path, ['-m', 'venv', this.venvDir]);
      if (created.code !== 0) throw new Error('Could not create the virtual environment. Check that venv support is installed.');
    } else {
      this.log('system', 'Virtual environment already exists.');
    }
    this.log('system', 'Upgrading pip...');
    const pipUpgrade = await this.run(this.venvPythonPath(), ['-m', 'pip', 'install', '--upgrade', 'pip'], { env: { PIP_DISABLE_PIP_VERSION_CHECK: '1' } });
    if (pipUpgrade.code !== 0) throw new Error('Could not upgrade pip. Check the log and your network connection.');
    this.log('system', 'Installing backend dependencies...');
    const installed = await this.run(this.venvPythonPath(), ['-m', 'pip', 'install', '-r', 'requirements.txt'], {
      env: { PIP_DISABLE_PIP_VERSION_CHECK: '1' }
    });
    if (installed.code !== 0) throw new Error('Dependency installation failed. See the log for details.');
    this.log('system', 'Python environment ready.');
    this.log('system', 'Preparing database and initializing schema...');
    await this.initDatabase();
    this.log('system', 'Environment and database setup complete.');
    return this.check();
  }

  async ensureDatabaseExists() {
    const env = this.readEnv();
    const databaseUrl = env.DATABASE_URL || '';
    let target;
    try {
      target = new URL(databaseUrl.replace(/^postgresql\+psycopg:/, 'postgresql:'));
    } catch {
      throw new Error('DATABASE_URL is invalid. Enter a PostgreSQL URL before initializing the database.');
    }
    const database = decodeURIComponent(target.pathname.replace(/^\//, ''));
    if (!database) throw new Error('DATABASE_URL must include a database name.');
    target.pathname = '/postgres';
    target.searchParams.set('connect_timeout', '5');
    const script = [
      'import psycopg, sys',
      'from psycopg import sql',
      'database = sys.argv[2]',
      'with psycopg.connect(sys.argv[1], autocommit=True) as conn:',
      '    found = conn.execute("select 1 from pg_database where datname = %s", (database,)).fetchone()',
      '    if not found:',
      '        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))',
      '        print("Created database " + database)',
      '    else:',
      '        print("Database " + database + " already exists")'
    ].join('\n');
    const result = await this.run(this.venvPythonPath(), ['-c', script, target.toString(), database]);
    if (result.code !== 0) {
      const detail = cliFailureMessage(result.output, '');
      throw new Error(`Could not prepare PostgreSQL database "${database}". Verify PostgreSQL is running, DATABASE_URL credentials are correct, and the user can create databases.${detail ? ` ${detail}` : ''}`);
    }
  }

  async initDatabase() {
    if (!fs.existsSync(this.venvPythonPath())) throw new Error('Set up the Python environment first.');
    this.log('system', 'Preparing PostgreSQL database...');
    await this.ensureDatabaseExists();
    this.log('system', 'Initializing database schema...');
    const result = await this.run(this.venvPythonPath(), ['-m', 'app.cli', 'init']);
    if (result.code !== 0) throw new Error(`Database initialization failed. Check DATABASE_URL and the setup log. ${cliFailureMessage(result.output, '')}`.trim());
    this.log('system', 'Database initialized.');
    return result.output;
  }

  async createAdmin({ email, password, name }) {
    if (!email || !password) throw new Error('Email and password are required.');
    if (String(password).length < 8) throw new Error('Password must be at least 8 characters.');
    const result = await this.run(this.venvPythonPath(), [
      '-m', 'app.cli', 'create-admin',
      '--email', String(email),
      '--password', String(password),
      '--name', String(name || 'Administrator')
    ]);
    if (result.code !== 0) throw new Error('Could not create the administrator. The account may already exist.');
    return result.output;
  }

  async resetPassword({ email, password }) {
    if (!email || !password) throw new Error('Email and password are required.');
    const result = await this.run(this.venvPythonPath(), [
      '-m', 'app.cli', 'reset-password',
      '--email', String(email),
      '--password', String(password)
    ]);
    if (result.code !== 0) throw new Error('Password reset failed. Check that the account exists.');
    return result.output;
  }

  // -------------------------------------------------------------- admin CLI

  async cli(args, input) {
    if (!fs.existsSync(this.venvPythonPath())) {
      throw new Error('Set up the Python environment on the Setup tab first.');
    }
    const result = await this.run(
      this.venvPythonPath(),
      ['-m', 'app.cli', ...args],
      typeof input === 'string' ? { input } : {}
    );
    if (result.code !== 0) {
      throw new Error(cliFailureMessage(result.output, `${args[0]} failed. Check the log for details.`));
    }
    return result.output;
  }

  async setOrganizationName(raw) {
    const name = String(raw || '').trim();
    if (!name) throw new Error('Enter an organization name.');
    if (name.length > 120) throw new Error('Organization name must be 120 characters or fewer.');
    const output = await this.cli(['set-org-name', '--name', name]);
    const result = parseTrailingJson(output);
    return result && typeof result.name === 'string' ? result.name : name;
  }

  async listUsers() {
    const output = await this.cli(['list-users', '--json']);
    const users = parseTrailingJson(output);
    if (!Array.isArray(users)) throw new Error('Could not read the account list.');
    return users;
  }

  async createUser({ email, name, password, role }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanName = String(name || '').trim();
    const cleanRole = role === 'admin' ? 'admin' : 'employee';
    const cleanPassword = String(password || '');
    if (!cleanEmail.includes('@')) throw new Error('Enter a valid email address.');
    if (!cleanName) throw new Error('Enter the person\'s name.');
    if (cleanPassword.length < 8) throw new Error('Password must be at least 8 characters.');
    if (/[\r\n]/.test(cleanPassword)) throw new Error('Password cannot contain line breaks.');
    await this.cli(
      ['create-user', '--email', cleanEmail, '--name', cleanName, '--role', cleanRole, '--password-stdin'],
      `${cleanPassword}\n`
    );
    return this.listUsers();
  }

  async deleteUser({ email }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) throw new Error('Choose an account to delete.');
    await this.cli(['delete-user', '--email', cleanEmail]);
    return this.listUsers();
  }

  async featureSchema() {
    const output = await this.cli(['feature-schema']);
    const schema = parseTrailingJson(output);
    if (!schema || typeof schema !== 'object') throw new Error('Could not read the feature schema.');
    return schema;
  }

  async getFeatures() {
    const output = await this.cli(['get-features', '--json']);
    const flags = parseTrailingJson(output);
    if (!flags || typeof flags !== 'object') throw new Error('Could not read feature flags.');
    return flags;
  }

  async setFeatures(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Feature changes must be an object.');
    }
    const entries = Object.entries(patch);
    if (entries.length === 0) throw new Error('Toggle at least one feature first.');
    const output = await this.cli(['set-features'], `${JSON.stringify(patch)}\n`);
    const flags = parseTrailingJson(output);
    if (!flags || typeof flags !== 'object') throw new Error('Feature update did not return flags.');
    return flags;
  }

  async testDatabase() {
    if (!fs.existsSync(this.venvPythonPath())) throw new Error('Set up the Python environment first.');
    const env = this.readEnv();
    const dsn = (env.DATABASE_URL || '').replace('+psycopg', '');
    if (!dsn) throw new Error('DATABASE_URL is not configured.');
    const script = [
      'import psycopg, sys',
      'conn = psycopg.connect(sys.argv[1], connect_timeout=5)',
      'row = conn.execute("select current_database(), version()").fetchone()',
      'print(row[0])',
      'print(row[1].split(",")[0])',
      'conn.close()'
    ].join('\n');
    const result = await this.run(this.venvPythonPath(), ['-c', script, dsn]);
    if (result.code !== 0) throw new Error('Could not connect to Postgres. Check DATABASE_URL and that the server is running.');
    return result.output.trim();
  }

  // ------------------------------------------------------------------ server

  async start() {
    if (this.child) return this.getStatus();
    await this.ensureEnvFile();
    if (!fs.existsSync(this.venvPythonPath())) throw new Error('Set up the Python environment first.');
    const env = this.readEnv();
    const port = Number(env.PORT || this.settings.port || 8000);
    const host = env.HOST || this.settings.host || '0.0.0.0';
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('The configured port must be between 1 and 65535.');
    }
    if (port < 1024 && process.platform !== 'win32') {
      throw new Error(`Port ${port} is privileged on this system. Use a port above 1024 or run the manager with administrator rights.`);
    }
    if (!(await this.portFree(port))) {
      throw new Error(`Port ${port} is already in use. Change the port in Settings or stop the other process.`);
    }

    this.desiredRunning = true;
    this.state = 'starting';
    this.lastError = null;
    this.emitStatus();
    this.log('system', `Starting RealtimeSuite on ${host}:${port}...`);

    const child = spawn(
      this.venvPythonPath(),
      ['-m', 'uvicorn', 'app.main:app', '--host', host, '--port', String(port)],
      {
        cwd: this.backendDir,
        env: {
          ...process.env,
          ...this.readEnv(),
          PYTHONUNBUFFERED: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          UPLOAD_DIR: path.join(this.userDataDir, 'uploads'),
          FRONTEND_DIST: path.join(this.backendDir, '..', 'frontend', 'dist')
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
    this.child = child;
    this.pid = child.pid || null;
    this.startedAt = nowIso();
    child.stdout.on('data', (chunk) => this.log('stdout', chunk.toString()));
    child.stderr.on('data', (chunk) => this.log('stderr', chunk.toString()));
    child.on('error', (error) => {
      this.lastError = error.message;
      this.log('stderr', `Server failed to start: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      const expected = !this.desiredRunning;
      this.log('system', `Server exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`);
      this.child = null;
      this.pid = null;
      this.startedAt = null;
      this.stopHealthPolling();
      this.state = 'stopped';
      if (!expected) {
        this.state = 'error';
        this.lastError = `Server stopped unexpectedly (code ${code ?? 'unknown'}).`;
        if (this.settings.autoRestart) {
          this.log('system', 'Auto-restart is enabled. Restarting in 3 seconds...');
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.desiredRunning) this.start().catch((error) => this.log('stderr', error.message));
          }, 3000);
        }
      }
      this.emitStatus();
    });

    this.startHealthPolling();
    return this.getStatus();
  }

  async stop() {
    this.desiredRunning = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child || child.pid == null) {
      this.state = 'stopped';
      this.stopHealthPolling();
      this.emitStatus();
      return this.getStatus();
    }
    this.state = 'stopping';
    this.emitStatus();
    this.log('system', 'Stopping server...');

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once('exit', finish);
      if (isWindows()) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('exit', finish);
      } else {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        if (!done && this.child) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          finish();
        }
      }, 6000);
    });

    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.stopHealthPolling();
    this.state = 'stopped';
    this.emitStatus();
    return this.getStatus();
  }

  async restart() {
    await this.stop();
    await this.start();
    return this.getStatus();
  }

  async portFree(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '0.0.0.0');
    });
  }

  healthUrl() {
    const env = this.readEnv();
    const port = Number(env.PORT || this.settings.port || 8000);
    return `http://127.0.0.1:${port}/api/health`;
  }

  async checkHealth() {
    try {
      const response = await fetch(this.healthUrl(), { signal: AbortSignal.timeout(2500) });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  startHealthPolling() {
    this.stopHealthPolling();
    const started = Date.now();
    const tick = async () => {
      const health = await this.checkHealth();
      if (health && health.ok) {
        if (this.state !== 'running') {
          this.state = 'running';
          this.lastError = null;
          this.emitStatus();
          this.log('system', `Server is online (${health.service || 'RealtimeSuite'} ${health.version || ''}).`);
        }
      } else if (this.state === 'starting' && Date.now() - started > START_TIMEOUT_MS) {
        this.state = 'error';
        this.lastError = 'The server did not respond within 90 seconds. Check the log.';
        this.emitStatus();
      }
      if (this.child) this.healthTimer = setTimeout(tick, HEALTH_INTERVAL_MS);
    };
    this.healthTimer = setTimeout(tick, 600);
  }

  stopHealthPolling() {
    if (this.healthTimer) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }

  lanUrls() {
    const env = this.readEnv();
    const port = Number(env.PORT || this.settings.port || 8000);
    const urls = [];
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if (entry.family !== 'IPv4' || entry.internal) continue;
        urls.push(`http://${entry.address}:${port}`);
      }
    }
    urls.push(`http://127.0.0.1:${port}`);
    return Array.from(new Set(urls));
  }

  getStatus() {
    const env = this.readEnv();
    const port = Number(env.PORT || this.settings.port || 8000);
    return {
      state: this.state,
      pid: this.pid,
      port,
      startedAt: this.startedAt,
      lastError: this.lastError,
      url: `http://127.0.0.1:${port}/`,
      boardUrl: `http://127.0.0.1:${port}/opsboard.html`,
      lanUrls: this.lanUrls(),
      autoRestart: Boolean(this.settings.autoRestart)
    };
  }

  emitStatus() {
    this.emit('status', this.getStatus());
  }

  async shutdown() {
    this.desiredRunning = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    await this.stop();
  }
}

module.exports = {
  ServerManager,
  parseEnv,
  upsertEnv,
  pythonCandidates,
  versionAtLeast,
  parseTrailingJson,
  cliFailureMessage
};
