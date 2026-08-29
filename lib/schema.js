export const DDL = `
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  layer         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  tier          INTEGER NOT NULL,
  topic         TEXT NOT NULL,
  content       TEXT NOT NULL,
  importance    INTEGER NOT NULL,
  quality       INTEGER NOT NULL,
  epistemic     TEXT NOT NULL,
  heat          REAL NOT NULL,
  created       INTEGER NOT NULL,
  updated       INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  archived      INTEGER NOT NULL DEFAULT 0,
  low_quality   INTEGER NOT NULL DEFAULT 0,
  window_freq   INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER,
  archived_at   INTEGER,
  session_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_tier   ON memories(tier, archived);
CREATE INDEX IF NOT EXISTS idx_mem_layer  ON memories(layer, tier);
CREATE INDEX IF NOT EXISTS idx_mem_access ON memories(last_accessed);
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(content, topic);

CREATE TABLE IF NOT EXISTS episodes (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  summary     TEXT NOT NULL,
  tools_used  TEXT,
  topic       TEXT NOT NULL DEFAULT 'general',
  extracted   INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_episodes_arch    ON episodes(archived, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS ep_fts USING fts5(summary, topic);

CREATE TABLE IF NOT EXISTS failure_memories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id    TEXT NOT NULL,
  old_content  TEXT,
  new_content  TEXT,
  corrected_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS forget_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  candidate_sha TEXT,
  decisions     TEXT,
  applied       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL
);
`;
/**
 * Idempotent column migration: PRAGMA table_info probe + ADD COLUMN, swallowing
 * the concurrent duplicate-column error (mneme v0.4.7 lesson — schema evolution
 * must be idempotent). v3.0.0 ships a full DDL, so this is the extension point
 * for future v3.x columns.
 */
export function migrateColumns(db) {
    const cols = new Set();
    for (const r of db.prepare('PRAGMA table_info(memories)').all()) {
        cols.add(String(r.name));
    }
    const add = (name, ddl) => {
        if (cols.has(name))
            return;
        try {
            db.exec(`ALTER TABLE memories ADD COLUMN ${ddl}`);
        }
        catch (err) {
            // Concurrent duplicate-column error → already added elsewhere, harmless.
            if (!String(err).includes('duplicate column name'))
                throw err;
        }
    };
    // Future columns go here, e.g.:
    // add('window_freq', 'window_freq INTEGER NOT NULL DEFAULT 0')
}
/** Rebuild the FTS index from the content table (boot-time alignment). */
export function rebuildFts(db) {
    try {
        db.exec("INSERT INTO mem_fts(mem_fts) VALUES('rebuild')");
    }
    catch {
        // mem_fts empty or already building — harmless.
    }
    try {
        db.exec("INSERT INTO ep_fts(ep_fts) VALUES('rebuild')");
    }
    catch {
        // ep_fts empty or already building — harmless.
    }
}
