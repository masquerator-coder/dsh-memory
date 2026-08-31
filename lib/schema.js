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
-- R4 (review 2026-08-30): exact-content dedup (WHERE content = ?) was a full
-- table SCAN on every add; this index turns it into a lookup.
CREATE INDEX IF NOT EXISTS idx_mem_content ON memories(content);
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

-- P1-13: durable snapshots of every HARD-deleted memory (content + reason), so a
-- "删除" is recoverable/queryable even though the row is physically gone — DESIGN §5.2.
CREATE TABLE IF NOT EXISTS forget_deleted (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  memory_id  TEXT NOT NULL,
  content    TEXT NOT NULL,
  topic      TEXT,
  importance INTEGER,
  quality    INTEGER,
  heat       REAL,
  reason     TEXT
);

-- R7 (review 2026-08-30): durable snapshots of HARD-deleted episodes. DESIGN §5.2
-- promises "删了能查、误删能回滚" for BOTH forgetting faces — episodes used to be
-- physically deleted with no trace, so only half the promise held.
CREATE TABLE IF NOT EXISTS forget_deleted_episodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  episode_id TEXT NOT NULL,
  session_id TEXT,
  summary    TEXT NOT NULL,
  topic      TEXT,
  tools_used TEXT,
  reason     TEXT
);

CREATE TABLE IF NOT EXISTS refine_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  level      INTEGER NOT NULL,     -- 1=L1 抽取, 2=L2 抽象
  source_id  TEXT,                  -- episode id (L1) / 簇种子记忆 id (L2)
  prompt_sha TEXT,                  -- 输入 digest，离线可复现
  llm_route  TEXT,                  -- "provider/model"，降级时为 null
  decisions  TEXT NOT NULL,         -- L1 抽取事实 JSON / L2 合并裁决 JSON
  status     TEXT NOT NULL          -- ok | ok-noop (R2: 0 facts written) | degraded | error
);

-- M7 (2026-08-30): L2 incremental fingerprint — records the last time a topic
-- cluster was LLM-audited, so a stable cluster (no member updated since) is
-- skipped on later passes (zero LLM). See REFINE-REDESIGN.md §3.3.
CREATE TABLE IF NOT EXISTS l2_refined (
  topic      TEXT PRIMARY KEY,
  refined_at INTEGER NOT NULL
);

-- R3-i (2026-08-31): identity-file sync ledger — which semantic memory contents
-- have already been written into the auto-maintained soul.md/user.md identity
-- files (dedup key = contentId(content), so a content edit re-enters as new).
-- P3-4 (review 2026-08-31): composite PK (content_id, target) — the table
-- carries a target column, so a sole content_id PK would collide when the
-- same content syncs to two targets. Legacy single-PK installs are rebuilt
-- in place by migrateColumns.
CREATE TABLE IF NOT EXISTS identity_synced (
  content_id TEXT NOT NULL,
  target     TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (content_id, target)
);
CREATE TABLE IF NOT EXISTS identity_meta (
  key   TEXT PRIMARY KEY,
  value INTEGER
);
`;
/**
 * Idempotent column-migration extension point. v3.0.0 shipped a full DDL, so
 * until the first v3.x column lands the only migration is the identity_synced
 * PK rebuild (P3-4): legacy installs created the table with content_id as the
 * sole PRIMARY KEY while the design carries a `target` column — the same
 * content synced to two targets would collide. The table is rebuilt in place
 * (data preserved) whenever the legacy single-column PK is detected; new
 * installs get the composite PK straight from the DDL and take the no-op path.
 */
export function migrateColumns(db) {
    try {
        const cols = db.prepare('PRAGMA table_info(identity_synced)').all();
        if (cols.length === 0)
            return; // table absent — DDL above creates the right shape
        const pkCols = cols.filter(c => c.pk > 0).map(c => c.name).sort();
        if (pkCols.join(',') === 'content_id,target')
            return;
        db.exec(`
      CREATE TABLE identity_synced_new (
        content_id TEXT NOT NULL,
        target     TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        PRIMARY KEY (content_id, target)
      );
      INSERT INTO identity_synced_new(content_id, target, ts)
        SELECT content_id, target, ts FROM identity_synced;
      DROP TABLE identity_synced;
      ALTER TABLE identity_synced_new RENAME TO identity_synced;
    `);
    }
    catch {
        /* absent/corrupt table → DDL above creates the right shape */
    }
}
/**
 * Boot-time FTS integrity helper. NOTE (P2-36): on a regular (non-contentless,
 * non-external-content) FTS5 table, `rebuild` re-derives the index from the
 * FTS table's OWN shadow content — it does NOT re-align with the memories /
 * episodes tables. The store already keeps FTS rows in sync transactionally on
 * every write/delete, so drift should not occur; use this only to repair a
 * corrupted shadow table, not as a reconciliation step.
 */
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
