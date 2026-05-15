function runMigrations(db) {
  // Metadatos de esquema
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  const currentVersion = versionRow ? Number(versionRow.value) || 0 : 0;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const upsertMeta = db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    upsertMeta.run('schema_version', '1');
  }
}

module.exports = {
  runMigrations
};
