const { ipcRenderer } = require('electron');

const SQLITE_KEYS = new Set(['notes', 'persons', 'tags']);
let sqliteEnabled = false;

const originalGetItem = localStorage.getItem.bind(localStorage);
const originalSetItem = localStorage.setItem.bind(localStorage);
const originalRemoveItem = localStorage.removeItem.bind(localStorage);

function detectBackend() {
  try {
    const backend = ipcRenderer.sendSync('storage-backend-sync');
    sqliteEnabled = !!(backend && backend.type === 'sqlite');
  } catch (err) {
    sqliteEnabled = false;
  }
}

function getItem(key) {
  if (sqliteEnabled && SQLITE_KEYS.has(key)) {
    const value = ipcRenderer.sendSync('storage-get-sync', key);
    return value == null ? null : value;
  }
  return originalGetItem(key);
}

function setItem(key, value) {
  if (sqliteEnabled && SQLITE_KEYS.has(key)) {
    const storedValue = typeof value === 'string' ? value : JSON.stringify(value);
    ipcRenderer.sendSync('storage-set-sync', { key, value: storedValue });
    return;
  }
  originalSetItem(key, value);
}

function removeItem(key) {
  if (sqliteEnabled && SQLITE_KEYS.has(key)) {
    ipcRenderer.sendSync('storage-remove-sync', key);
    return;
  }
  originalRemoveItem(key);
}

function installLocalStorageBridge() {
  detectBackend();
  localStorage.getItem = getItem;
  localStorage.setItem = setItem;
  localStorage.removeItem = removeItem;
}

installLocalStorageBridge();

module.exports = {
  installLocalStorageBridge,
  getItem,
  setItem,
  removeItem
};
