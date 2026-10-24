'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ServerManager } = require('./server-manager.cjs');

const isDev = process.argv.includes('--dev');
const smokeTest = process.argv.includes('--smoke');
const backendDir = app.isPackaged
  ? path.join(process.resourcesPath, 'backend')
  : path.resolve(__dirname, '..', '..', 'backend');

const manager = new ServerManager({
  backendDir,
  userDataDir: path.join(app.getPath('userData')),
  resourcesDir: app.isPackaged ? process.resourcesPath : '',
  envFile: app.isPackaged
    ? path.join(app.getPath('userData'), '.env')
    : undefined,
  venvDir: app.isPackaged
    ? path.join(app.getPath('userData'), 'python-venv')
    : undefined
});

let mainWindow = null;
let openedOnStart = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: 'RealtimeSuite Server Manager',
    backgroundColor: '#f4f7fb',
    autoHideMenuBar: false,
    show: !smokeTest,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  if (smokeTest) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const result = await mainWindow.webContents.executeJavaScript(
            `JSON.stringify({
              status: document.getElementById('status-text').textContent,
              tabs: document.querySelectorAll('.nav button').length,
              addresses: document.querySelectorAll('#address-list .address-row').length,
              checks: document.querySelectorAll('#checklist li').length,
              bridge: typeof window.manager,
              logLines: document.querySelectorAll('#log-view .log-line').length
            })`
          );
          console.log('SMOKE_RESULT ' + result);
          app.exit(0);
        } catch (error) {
          console.error('SMOKE_ERROR ' + error.message);
          app.exit(1);
        }
      }, 1500);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

manager.on('log', (entry) => send('manager:log', entry));
manager.on('status', (status) => {
  send('manager:status', status);
  if (status.state === 'running' && manager.settings.openOnStart && !openedOnStart) {
    openedOnStart = true;
    void shell.openExternal(status.url).catch(() => undefined);
  }
});
manager.on('logs-cleared', () => send('manager:logs-cleared'));

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open RealtimeSuite',
          click: () => void shell.openExternal(manager.getStatus().url)
        },
        {
          label: 'Open Live Board',
          click: () => void shell.openExternal(manager.getStatus().boardUrl)
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Server',
      submenu: [
        { label: 'Start', click: () => manager.start().catch((error) => dialog.showErrorBox('Start failed', error.message)) },
        { label: 'Stop', click: () => void manager.stop() },
        { label: 'Restart', click: () => manager.restart().catch((error) => dialog.showErrorBox('Restart failed', error.message)) },
        { type: 'separator' },
        { label: 'Open Logs Folder', click: () => void shell.openPath(path.join(app.getPath('userData'), 'logs')) },
        { label: 'Open Backend Folder', click: () => void shell.openPath(backendDir) }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open RealtimeSuite',
          click: () => void shell.openExternal(manager.getStatus().url)
        },
        {
          label: 'About',
          click: () => {
            void dialog.showMessageBox({
              title: 'RealtimeSuite Server Manager',
              message: 'RealtimeSuite Server Manager',
              detail: `Version ${app.getVersion()}\nBackend: ${backendDir}\nElectron ${process.versions.electron}\nNode ${process.versions.node}`,
              buttons: ['Close']
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function statePayload() {
  return {
    status: manager.getStatus(),
    settings: manager.settings,
    check: await manager.check(),
    logs: manager.getLogs(),
    version: app.getVersion()
  };
}

function registerIpc() {
  ipcMain.handle('manager:state', () => statePayload());
  ipcMain.handle('manager:save-settings', async (_event, patch) => {
    await manager.saveSettings(patch || {});
    return statePayload();
  });
  ipcMain.handle('manager:save-env', async (_event, values) => {
    await manager.applyEnvValues(values || {});
    return statePayload();
  });
  ipcMain.handle('manager:setup', async () => {
    await manager.setupEnvironment();
    return statePayload();
  });
  ipcMain.handle('manager:init-db', async () => {
    await manager.initDatabase();
    return statePayload();
  });
  ipcMain.handle('manager:test-db', async () => {
    const result = await manager.probeDatabase();
    return { ok: result.ok, detail: result.detail };
  });
  ipcMain.handle('manager:list-backups', async () => ({ backups: await manager.listBackups() }));
  ipcMain.handle('manager:create-backup', async () => manager.createBackup());
  ipcMain.handle('manager:restore-backup', async (_event, payload) => manager.restoreBackup(payload && payload.name, Boolean(payload && payload.confirmed)));
  ipcMain.handle('manager:create-admin', async (_event, payload) => {
    const detail = await manager.createAdmin(payload || {});
    return { detail };
  });
  ipcMain.handle('manager:reset-password', async (_event, payload) => {
    const detail = await manager.resetPassword(payload || {});
    return { detail };
  });
  ipcMain.handle('manager:set-org-name', async (_event, name) => {
    try {
      return { ok: true, name: await manager.setOrganizationName(name) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('manager:list-users', async () => {
    try {
      return { ok: true, users: await manager.listUsers() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('manager:create-user', async (_event, payload) => {
    try {
      return { ok: true, users: await manager.createUser(payload || {}) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('manager:delete-user', async (_event, payload) => {
    try {
      return { ok: true, users: await manager.deleteUser(payload || {}) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('manager:features', async () => {
    try {
      // Run the CLI commands one after another: both touch the schema on first use.
      const schema = await manager.featureSchema();
      const flags = await manager.getFeatures();
      return { ok: true, schema, flags };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('manager:set-features', async (_event, patch) => {
    try {
      return { ok: true, flags: await manager.setFeatures(patch || {}) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('manager:start', async () => {
    try {
      await manager.start();
      return { ok: true, status: manager.getStatus() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('manager:stop', async () => {
    await manager.stop();
    return statePayload();
  });
  ipcMain.handle('manager:restart', async () => {
    try {
      await manager.restart();
      return { ok: true, status: manager.getStatus() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('manager:clear-logs', () => {
    manager.clearLogs();
    return true;
  });
  ipcMain.handle('manager:open', async (_event, target) => {
    const status = manager.getStatus();
    if (target === 'logs') {
      const dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      return shell.openPath(dir);
    }
    if (target === 'backend') return shell.openPath(backendDir);
    if (target === 'board') return shell.openExternal(status.boardUrl);
    if (target === 'app') return shell.openExternal(status.url);
    if (typeof target === 'string' && /^https?:\/\//.test(target)) return shell.openExternal(target);
    return shell.openExternal(status.url);
  });
  ipcMain.handle('manager:show-item', (_event, target) => {
    const file = target === 'env' ? path.join(backendDir, '.env') : path.join(app.getPath('userData'), 'logs', 'server.log');
    shell.showItemInFolder(file);
    return true;
  });
}

app.whenReady().then(async () => {
  registerIpc();
  buildMenu();
  createWindow();
  try {
    await manager.ensureEnvFile();
  } catch (error) {
    manager.log('system', `Could not prepare .env: ${error.message}`);
  }
  if (manager.settings.autoStart && !smokeTest) {
    manager.start().catch((error) => manager.log('stderr', error.message));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void manager.shutdown().finally(() => app.exit(0));
});
