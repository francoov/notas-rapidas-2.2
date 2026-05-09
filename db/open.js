const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrate');

const SQLITE_KEYS = new Set(['notes', 'persons', 'tags']);

function getDefaultValueForKey(key) {
  if (SQLITE_KEYS.has(key)) return '[]';
  return null;
}

function openStore(userDataPath) {
  const dbPath = path.join(userDataPath, 'notas-rapidas.db');
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  runMigrations(db);

  const getStmt = db.prepare('SELECT value FROM kv_store WHERE key = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO kv_store (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);
  const removeStmt = db.prepare('DELETE FROM kv_store WHERE key = ?');

  function getValue(key) {
    const row = getStmt.get(key);
    if (row) return row.value;
    return getDefaultValueForKey(key);
  }

  function setValue(key, value) {
    const safeValue = typeof value === 'string' ? value : JSON.stringify(value);
    upsertStmt.run(key, safeValue, new Date().toISOString());
    return true;
  }

  function removeValue(key) {
    removeStmt.run(key);
    return true;
  }

  return {
    dbPath,
    isSqliteKey: (key) => SQLITE_KEYS.has(key),
    getValue,
    setValue,
    removeValue,
    close: () => db.close()
  };
}

module.exports = {
  openStore,
  SQLITE_KEYS
};
