'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  const entry = { channel, handler };
  listeners.add(entry);
  return () => {
    ipcRenderer.removeListener(channel, handler);
    listeners.delete(entry);
  };
}

contextBridge.exposeInMainWorld('manager', {
  getState: () => ipcRenderer.invoke('manager:state'),
  saveSettings: (patch) => ipcRenderer.invoke('manager:save-settings', patch),
  saveEnv: (values) => ipcRenderer.invoke('manager:save-env', values),
  setup: () => ipcRenderer.invoke('manager:setup'),
  initDatabase: () => ipcRenderer.invoke('manager:init-db'),
  testDatabase: () => ipcRenderer.invoke('manager:test-db'),
  createAdmin: (payload) => ipcRenderer.invoke('manager:create-admin', payload),
  resetPassword: (payload) => ipcRenderer.invoke('manager:reset-password', payload),
  listUsers: () => ipcRenderer.invoke('manager:list-users'),
  createUser: (payload) => ipcRenderer.invoke('manager:create-user', payload),
  deleteUser: (payload) => ipcRenderer.invoke('manager:delete-user', payload),
  getFeatures: () => ipcRenderer.invoke('manager:features'),
  setFeatures: (patch) => ipcRenderer.invoke('manager:set-features', patch),
  start: () => ipcRenderer.invoke('manager:start'),
  stop: () => ipcRenderer.invoke('manager:stop'),
  restart: () => ipcRenderer.invoke('manager:restart'),
  clearLogs: () => ipcRenderer.invoke('manager:clear-logs'),
  open: (target) => ipcRenderer.invoke('manager:open', target),
  showItem: (target) => ipcRenderer.invoke('manager:show-item', target),
  onLog: (callback) => subscribe('manager:log', callback),
  onStatus: (callback) => subscribe('manager:status', callback),
  onLogsCleared: (callback) => subscribe('manager:logs-cleared', callback)
});
