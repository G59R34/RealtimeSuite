'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
    this.backupDir = path.join(this.userDataDir, 'backups');
    this.pgDumpPath = options.pgDumpPath || '';
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.resourcesDir = options.resourcesDir || (process.resourcesPath || '');
    this.embeddedPostgresFactory = options.embeddedPostgresFactory || null;
    this.embeddedPostgres = null;
    this.systemCommand = options.systemCommand || this.runSystemCommand.bind(this);
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
    const databaseProbe = await this.probeDatabase();
    return {
      backendDir: this.backendDir,
      databaseProbe,
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
        githubPollMinutes: Number(env.GITHUB_POLL_MINUTES || 5),
        hostBinding: (env.HOST || this.settings.host || '0.0.0.0') === '0.0.0.0' ? 'all network interfaces' : 'this computer only',
        portValid: Number.isInteger(Number(env.PORT || this.settings.port || 8000)) && Number(env.PORT || this.settings.port || 8000) >= 1 && Number(env.PORT || this.settings.port || 8000) <= 65535
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

  async runSystemCommand(command, args) {
    return new Promise((resolve) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.once('error', (error) => resolve({ code: -1, output: error.message }));
      child.once('close', (code) => resolve({ code: code ?? -1, output }));
    });
  }

  embeddedPostgresDataDir() {
    return path.join(this.userDataDir, 'postgres-data');
  }

  embeddedPostgresModulesPath() {
    if (this.resourcesDir) return path.join(this.resourcesDir, 'postgres', 'node_modules');
    return path.resolve(__dirname, '..', 'node_modules');
  }

  async loadEmbeddedPostgres() {
    if (this.embeddedPostgresFactory) return this.embeddedPostgresFactory;
    const modulePath = path.join(this.embeddedPostgresModulesPath(), 'embedded-postgres', 'dist', 'index.js');
    if (!fs.existsSync(modulePath)) throw new Error(`Bundled PostgreSQL runtime is missing (${modulePath}). Reinstall or repair the Server Manager.`);
    const imported = await import(pathToFileURL(modulePath).href);
    return imported.default;
  }

  embeddedPostgresRuntimeConfig(databaseUrl = this.readEnv().DATABASE_URL) {
    let url;
    try {
      url = new URL(String(databaseUrl || '').replace(/^postgresql\+psycopg:/, 'postgresql:'));
    } catch {
      throw new Error('DATABASE_URL is invalid. Configure a PostgreSQL URL in Setup.');
    }
    const host = (url.hostname || '127.0.0.1').toLowerCase();
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
      throw new Error(`Database host ${host} is remote; embedded PostgreSQL only manages a local database.`);
    }
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!database) throw new Error('DATABASE_URL must include a database name.');
    if (url.username && decodeURIComponent(url.username) !== 'postgres') {
      throw new Error('The embedded PostgreSQL database uses the postgres user. Update DATABASE_URL to use postgres or configure an external database.');
    }
    if (url.password) throw new Error('The embedded PostgreSQL database manages its own local credentials. Remove the password from DATABASE_URL or configure an external database.');
    return { host, port: Number(url.port || 5432), database };
  }

  async startEmbeddedPostgres() {
    const config = this.embeddedPostgresRuntimeConfig();
    const reachable = await new Promise((resolve) => {
      const socket = net.createConnection({ host: config.host, port: config.port });
      const timer = setTimeout(() => socket.destroy(new Error('timeout')), 1200);
      socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve(true); });
      socket.once('error', () => { clearTimeout(timer); resolve(false); });
    });
    if (reachable) return { started: false, external: true, detail: 'A PostgreSQL server is already listening at the configured local address.' };

    const EmbeddedPostgres = await this.loadEmbeddedPostgres();
    const pg = new EmbeddedPostgres({
      databaseDir: this.embeddedPostgresDataDir(),
      user: 'postgres',
      password: '',
      port: config.port,
      authMethod: 'trust',
      persistent: true,
      postgresFlags: ['-h', config.host, '-c', 'listen_addresses=127.0.0.1,::1'],
      onLog: (message) => this.log('system', `[PostgreSQL] ${String(message).trim()}`),
      onError: (error) => this.log('stderr', `[PostgreSQL] ${String(error)}`)
    });
    await fsp.mkdir(this.userDataDir, { recursive: true });
    if (!fs.existsSync(path.join(this.embeddedPostgresDataDir(), 'PG_VERSION'))) {
      this.log('system', 'Initializing the bundled PostgreSQL database (first launch only)...');
      await pg.initialise();
    }
    await pg.start();
    this.embeddedPostgres = pg;
    if (!(await this.embeddedDatabaseExists(config.database))) {
      await pg.createDatabase(config.database);
      this.log('system', `Created local database ${config.database}.`);
    }
    this.log('system', `Bundled PostgreSQL is ready on ${config.host}:${config.port}.`);
    return { started: true, detail: `Started bundled PostgreSQL on ${config.host}:${config.port}.` };
  }

  async embeddedDatabaseExists(database) {
    const client = this.embeddedPostgres.getPgClient('postgres', this.embeddedPostgresRuntimeConfig().host);
    await client.connect();
    try {
      const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
      return result.rowCount > 0;
    } finally {
      await client.end();
    }
  }

  async startLocalPostgres() {
    const rawUrl = this.readEnv().DATABASE_URL || '';
    let target;
    try {
      target = new URL(rawUrl.replace(/^postgresql\\+psycopg:/, 'postgresql:'));
    } catch {
      return { attempted: false, detail: 'DATABASE_URL is missing or invalid; no PostgreSQL service was started.' };
    }
    const host = target.hostname.toLowerCase();
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
      return { attempted: false, detail: `Database host ${target.hostname} is remote. The manager will not start services on another machine.` };
    }

    if (this.platform === 'win32') {
      const query = await this.systemCommand('sc.exe', ['query', 'state=', 'all']);
      if (query.code !== 0) return { attempted: true, detail: `Could not inspect Windows services: ${cliFailureMessage(query.output, 'service query failed')}` };
      const services = [...query.output.matchAll(/SERVICE_NAME:\s*(postgresql[^\r\n\s]*)/gi)].map((match) => match[1]);
      if (!services.length) return { attempted: false, detail: 'No installed PostgreSQL Windows service was found. Install PostgreSQL (including its service) or configure a remote database.' };
      const preferred = services.sort((a, b) => {
        const aVersion = Number((a.match(/-(\d+)$/) || [])[1] || 0);
        const bVersion = Number((b.match(/-(\d+)$/) || [])[1] || 0);
        return bVersion - aVersion;
      });
      for (const service of preferred) {
        const started = await this.systemCommand('sc.exe', ['start', service]);
        if (started.code === 0 || /already running|service has already been started/i.test(started.output)) {
          this.log('system', `Started PostgreSQL Windows service ${service}.`);
          return { attempted: true, started: true, detail: `Started PostgreSQL service ${service}.` };
        }
      }
      return { attempted: true, detail: `Found PostgreSQL service ${preferred[0]}, but Windows could not start it. Check the service status and permissions.` };
    }

    if (this.platform === 'darwin') {
      const listed = await this.systemCommand('brew', ['services', 'list']);
      if (listed.code !== 0) return { attempted: false, detail: 'PostgreSQL was not started automatically: Homebrew services are unavailable. Start the installed PostgreSQL service manually.' };
      const formula = listed.output.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]).find((name) => /^postgresql(?:@.*)?$/.test(name));
      if (!formula) return { attempted: false, detail: 'No Homebrew PostgreSQL service was found. Start the installed PostgreSQL service manually.' };
      const started = await this.systemCommand('brew', ['services', 'start', formula]);
      if (started.code === 0) {
        this.log('system', `Started PostgreSQL with Homebrew (${formula}).`);
        return { attempted: true, started: true, detail: `Started PostgreSQL service ${formula}.` };
      }
      return { attempted: true, detail: `Homebrew found ${formula} but could not start it: ${cliFailureMessage(started.output, 'service start failed')}` };
    }

    const active = await this.systemCommand('systemctl', ['is-active', 'postgresql']);
    if (active.code === 0 && active.output.trim() === 'active') return { attempted: false, started: true, detail: 'PostgreSQL service is already active.' };
    const started = await this.systemCommand('systemctl', ['start', 'postgresql']);
    if (started.code === 0) {
      this.log('system', 'Started PostgreSQL systemd service.');
      return { attempted: true, started: true, detail: 'Started PostgreSQL system service.' };
    }
    return { attempted: true, detail: `Could not start PostgreSQL with systemd: ${cliFailureMessage(started.output, 'service is unavailable or requires operator permissions')}` };
  }

  async probeDatabase() {
    if (!this.readEnv().DATABASE_URL) return { ok: false, detail: 'DATABASE_URL is not configured. Enter a PostgreSQL URL in Setup.' };
    const env = this.readEnv();
    let target;
    try {
      target = new URL((env.DATABASE_URL || '').replace(/^postgresql\\+psycopg:/, 'postgresql:'));
    } catch {
      return { ok: false, detail: 'DATABASE_URL is missing or invalid. Enter a PostgreSQL URL in Setup.' };
    }
    const host = target.hostname || '127.0.0.1';
    const port = Number(target.port || 5432);
    const database = decodeURIComponent(target.pathname.replace(/^\//, ''));
    if (!database) return { ok: false, detail: 'DATABASE_URL must include a database name.' };
    const reachable = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => socket.destroy(new Error('timeout')), 2500);
      socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve(true); });
      socket.once('error', (error) => { clearTimeout(timer); resolve({ error }); });
    });
    if (reachable !== true) {
      const error = reachable.error;
      const unavailable = error && ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code);
      return {
        ok: false,
        detail: unavailable
          ? `Cannot reach PostgreSQL at ${host}:${port}. Start the PostgreSQL service and confirm that it listens on this address and port.`
          : `Could not reach PostgreSQL at ${host}:${port}: ${error ? error.message : 'connection failed'}`
      };
    }
    if (!fs.existsSync(this.venvPythonPath())) return { ok: false, detail: `PostgreSQL is reachable at ${host}:${port}, but the Python environment is not installed. Run Create / Repair Environment.` };
    const dsn = (env.DATABASE_URL || '').replace('+psycopg', '');
    const script = [
      'import psycopg, sys',
      'try:',
      '    conn = psycopg.connect(sys.argv[1], connect_timeout=5)',
      '    row = conn.execute("select current_database(), version()").fetchone()',
      '    print("CONNECTED:" + row[0])',
      '    conn.close()',
      'except Exception as exc:',
      '    print("DATABASE_ERROR:" + str(exc))',
      '    raise SystemExit(2)'
    ].join('\n');
    const result = await this.run(this.venvPythonPath(), ['-c', script, dsn]);
    if (result.code !== 0) {
      const detail = (result.output.match(/DATABASE_ERROR:(.*)/) || [])[1];
      return { ok: false, detail: detail ? `PostgreSQL is reachable at ${host}:${port}, but authentication/database selection failed: ${detail}` : `PostgreSQL is reachable at ${host}:${port}, but the connection check failed: ${cliFailureMessage(result.output, 'check DATABASE_URL credentials and database permissions')}` };
    }
    const match = result.output.match(/CONNECTED:(.*)/);
    return { ok: true, detail: `Connected to database ${match ? match[1].trim() : database} at ${host}:${port}.` };
  }

  async testDatabase() {
    const result = await this.probeDatabase();
    if (!result.ok) throw new Error(result.detail);
    return result.detail;
  }

  // -------------------------------------------------------------- DB backups

  async resolvePgDump() {
    const candidates = this.pgDumpPath ? [this.pgDumpPath] : (process.platform === 'win32'
      ? ['pg_dump.exe', 'pg_dump']
      : ['pg_dump']);
    for (const candidate of candidates) {
      if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
      if (!path.isAbsolute(candidate)) {
        const result = await new Promise((resolve) => {
          const child = spawn(candidate, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
          let output = '';
          child.stdout.on('data', (chunk) => { output += chunk.toString(); });
          child.once('error', () => resolve(null));
          child.once('close', (code) => resolve(code === 0 && /pg_dump/i.test(output) ? candidate : null));
        });
        if (result) return result;
      }
    }
    throw new Error('PostgreSQL pg_dump/pg_restore tools are not installed or not on PATH. Install PostgreSQL client tools, then retry.');
  }

  async listBackups() {
    await fsp.mkdir(this.backupDir, { recursive: true });
    const entries = await fsp.readdir(this.backupDir, { withFileTypes: true });
    const files = await Promise.all(entries.filter((entry) => entry.isFile() && /^realtimesuite-.*\.dump$/.test(entry.name)).map(async (entry) => {
      const fullPath = path.join(this.backupDir, entry.name);
      const stat = await fsp.stat(fullPath);
      return { name: entry.name, size: stat.size, createdAt: stat.mtime.toISOString() };
    }));
    return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  postgresClientConfig() {
    let dsn;
    try {
      dsn = new URL((this.readEnv().DATABASE_URL || '').replace(/^postgresql\+psycopg:/, 'postgresql:'));
    } catch {
      throw new Error('DATABASE_URL is not configured with a valid PostgreSQL URL.');
    }
    const database = decodeURIComponent(dsn.pathname.replace(/^\//, ''));
    if (!database) throw new Error('DATABASE_URL must include a database name.');
    const env = {
      PGHOST: dsn.hostname,
      PGPORT: dsn.port || '5432',
      ...(dsn.hostname.includes(':') ? { PGHOSTADDR: dsn.hostname } : {}),
      PGDATABASE: database,
      ...(dsn.username ? { PGUSER: decodeURIComponent(dsn.username) } : {}),
      ...(dsn.password ? { PGPASSWORD: decodeURIComponent(dsn.password) } : {})
    };
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) {
      if (dsn.searchParams.has(key)) env[`PG${key.toUpperCase()}`] = dsn.searchParams.get(key);
    }
    return { env, database };
  }

  async createBackup() {
    const { env: postgresEnv, database } = this.postgresClientConfig();
    const pgDump = await this.resolvePgDump();
    await fsp.mkdir(this.backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `realtimesuite-${timestamp}.dump`;
    const output = path.join(this.backupDir, name);
    this.log('system', `Creating database backup ${name}...`);
    const result = await this.run(pgDump, ['--format=custom', '--no-owner', '--no-acl', '--file', output, '--dbname', database], { env: postgresEnv });
    if (result.code !== 0) {
      await fsp.rm(output, { force: true });
      throw new Error(`Database backup failed. Verify the database is reachable and pg_dump is compatible. ${cliFailureMessage(result.output, '')}`.trim());
    }
    const stat = await fsp.stat(output);
    if (stat.size === 0) {
      await fsp.rm(output, { force: true });
      throw new Error('pg_dump produced an empty backup file.');
    }
    this.log('system', `Database backup created (${name}, ${stat.size} bytes).`);
    return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
  }

  async restoreBackup(name, confirmed) {
    if (confirmed !== true) throw new Error('Restore requires explicit confirmation.');
    if (this.state === 'running' || this.child) throw new Error('Stop the application server before restoring a database backup.');
    if (typeof name !== 'string' || !/^realtimesuite-[A-Za-z0-9T_.-]+\.dump$/.test(name) || path.basename(name) !== name) {
      throw new Error('Choose a valid backup from the backup list.');
    }
    const backupPath = path.join(this.backupDir, name);
    const stat = await fsp.stat(backupPath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size === 0) throw new Error('That backup does not exist or is empty.');
    const listedBackups = await this.listBackups();
    if (!listedBackups.some((backup) => backup.name === name)) throw new Error('Choose a valid backup from the backup list.');
    const { env: postgresEnv, database } = this.postgresClientConfig();
    const pgRestore = this.pgDumpPath
      ? this.pgDumpPath.replace(/pg_dump(?:\.exe)?$/i, process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore')
      : (process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore');
    const executable = await this.resolvePgRestore(pgRestore);
    this.log('system', `Restoring database from ${name}; current database contents will be replaced...`);
    const result = await this.run(executable, ['--clean', '--if-exists', '--no-owner', '--no-acl', '--dbname', database, backupPath], { env: postgresEnv });
    if (result.code !== 0) throw new Error(`Database restore failed. Existing data may be partially changed; review logs and restore from a verified backup if needed. ${cliFailureMessage(result.output, '')}`.trim());
    this.log('system', `Database restored from ${name}.`);
    return true;
  }

  async resolvePgRestore(candidate) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
      throw new Error('pg_restore was not found beside pg_dump. Install PostgreSQL client tools.');
    }
    const result = await new Promise((resolve) => {
      const child = spawn(candidate, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.once('error', () => resolve(false));
      child.once('close', (code) => resolve(code === 0 && /pg_restore/i.test(output)));
    });
    if (!result) throw new Error('PostgreSQL pg_restore is not installed or not on PATH.');
    return candidate;
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
    let databaseProbe = await this.probeDatabase();
    if (!databaseProbe.ok && /ECONNREFUSED|ETIMEDOUT|Cannot reach PostgreSQL/i.test(databaseProbe.detail)) {
      let service;
      try {
        service = await this.startEmbeddedPostgres();
      } catch (error) {
        databaseProbe.detail = `${databaseProbe.detail} Bundled PostgreSQL could not start: ${error.message}`;
      }
      if (service && service.started) {
        databaseProbe = await this.probeDatabase();
      }
    }
    if (!databaseProbe.ok) {
      this.state = 'error';
      this.lastError = databaseProbe.detail;
      this.desiredRunning = false;
      await this.stopEmbeddedPostgres();
      this.emitStatus();
      this.log('stderr', `Startup blocked: ${databaseProbe.detail}`);
      throw new Error(databaseProbe.detail);
    }

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
      await this.stopEmbeddedPostgres();
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
    await this.stopEmbeddedPostgres();
    this.emitStatus();
    return this.getStatus();
  }

  async stopEmbeddedPostgres() {
    const pg = this.embeddedPostgres;
    this.embeddedPostgres = null;
    if (!pg) return;
    try {
      await pg.stop();
      this.log('system', 'Bundled PostgreSQL stopped cleanly.');
    } catch (error) {
      this.log('stderr', `Bundled PostgreSQL shutdown failed: ${error.message}`);
    }
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
