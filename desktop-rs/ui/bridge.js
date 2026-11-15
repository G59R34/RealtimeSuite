// Adapts the control panel's original `window.manager` API (Electron preload)
// onto Tauri's invoke/event bridge, so the renderer runs unmodified.
(function () {
  'use strict';

  const tauri = window.__TAURI__;
  if (!tauri) {
    console.error('Tauri bridge unavailable: window.__TAURI__ is missing.');
    return;
  }

  const invoke = tauri.core.invoke;
  const listen = tauri.event.listen;

  function subscribe(event, callback) {
    let unlisten = null;
    let disposed = false;
    listen(event, (message) => callback(message.payload)).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }

  const call = (command, args) => invoke(command, args || {});

  // WKWebView and WebView2 do not implement window.confirm on their own, and a
  // silently-false confirmation would turn every destructive button into a
  // no-op, so answer it in the page instead.
  window.managerConfirm = function managerConfirm(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px;';
      const card = document.createElement('div');
      card.style.cssText =
        'background:#fff;color:#0f172a;border-radius:14px;max-width:460px;width:100%;padding:22px 24px;box-shadow:0 24px 64px rgba(15,23,42,.32);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;';
      const text = document.createElement('p');
      text.textContent = message;
      text.style.cssText = 'margin:0 0 18px;white-space:pre-wrap;';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.style.cssText =
        'padding:9px 16px;border-radius:9px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;cursor:pointer;font:inherit;';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.textContent = 'Continue';
      ok.style.cssText =
        'padding:9px 16px;border-radius:9px;border:1px solid #b91c1c;background:#b91c1c;color:#fff;cursor:pointer;font:inherit;';
      const finish = (value) => {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(value);
      };
      const onKey = (event) => {
        if (event.key === 'Escape') finish(false);
        if (event.key === 'Enter') finish(true);
      };
      cancel.addEventListener('click', () => finish(false));
      ok.addEventListener('click', () => finish(true));
      document.addEventListener('keydown', onKey);
      row.append(cancel, ok);
      card.append(text, row);
      overlay.append(card);
      document.body.append(overlay);
      ok.focus();
    });
  };

  window.manager = {
    getState: () => call('manager_state'),
    saveSettings: (patch) => call('manager_save_settings', { patch }),
    saveEnv: (values) => call('manager_save_env', { values }),
    getRtlink: () => call('manager_rtlink'),
    saveRtlink: (payload) => call('manager_rtlink_save', { payload }),
    setup: () => call('manager_setup'),
    initDatabase: () => call('manager_init_db'),
    testDatabase: () => call('manager_test_db'),
    listBackups: () => call('manager_list_backups'),
    createBackup: () => call('manager_create_backup'),
    restoreBackup: (payload) => call('manager_restore_backup', { payload }),
    listDatabaseTables: () => call('manager_db_tables'),
    readDatabaseRows: (payload) => call('manager_db_rows', { payload }),
    updateDatabaseRow: (payload) => call('manager_db_update_row', { payload }),
    deleteDatabaseRow: (payload) => call('manager_db_delete_row', { payload }),
    resetDatabase: (payload) => call('manager_db_reset', { payload }),
    createAdmin: (payload) => call('manager_create_admin', { payload }),
    resetPassword: (payload) => call('manager_reset_password', { payload }),
    setOrganizationName: (name) => call('manager_set_org_name', { name }),
    listUsers: () => call('manager_list_users'),
    createUser: (payload) => call('manager_create_user', { payload }),
    deleteUser: (payload) => call('manager_delete_user', { payload }),
    getFeatures: () => call('manager_features'),
    setFeatures: () => call('manager_set_features'),
    start: () => call('manager_start'),
    stop: () => call('manager_stop'),
    restart: () => call('manager_restart'),
    clearLogs: () => call('manager_clear_logs'),
    open: (target) => call('manager_open', { target }),
    showItem: (target) => call('manager_show_item', { target }),
    onLog: (callback) => subscribe('manager:log', callback),
    onStatus: (callback) => subscribe('manager:status', callback),
    onLogsCleared: (callback) => subscribe('manager:logs-cleared', callback)
  };
})();
