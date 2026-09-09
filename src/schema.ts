/** dsh-memory — SQLite schema (DDL + idempotent migration + FTS rebuild). */
import type { DatabaseSync } from 'node:sqlite'

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

-- Lesson pipeline (DESIGN docs/lesson-pipeline.md §2.2): staged corrections
-- awaiting a background/instant LLM judgement that promotes them into
-- "memories kind=lesson" or drops them. Written idempotently beside every
-- recordFailure (zero-LLM, immediate), promoted/dropped by refine.ts.
CREATE TABLE IF NOT EXISTS lesson_drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id    TEXT NOT NULL,               -- 被纠正的源记忆
  topic        TEXT NOT NULL DEFAULT 'general',
  old_content  TEXT,
  new_content  TEXT,
  lesson       TEXT,                         -- 预拼装的教训草案 / LLM 重写自然语言
  source       TEXT NOT NULL DEFAULT 'replace',  -- replace | merge-conflict | l1
  status       TEXT NOT NULL DEFAULT 'draft',    -- draft | promoted | dropped
  draft_count  INTEGER NOT NULL DEFAULT 1,       -- 同 memory_id 被纠正次数（聚合防堆叠）
  drafted_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lesson_drafts_status ON lesson_drafts(status, drafted_at);

-- MEMORY-TRIGGER (2026-09-08): 事件驱动沉淀兜底——turn-end 用纯规则(零 LLM)
-- 探测到的"待沉淀候选草稿"表。与 episodes(会话摘要)/memories(语义事实) 语义正交：
-- 这句"该不该记的技术经验"在 LLM 忙而被忽略时也被自动留存,由主会话经
-- memory_drafts 工具在闲时裁决(查重后 memory add=promoted / 丢弃=discarded)。
-- 捕获走纯规则零 LLM,不违背设计文档"不每轮 spawn LLM 旁路"；写入语义层仍有闸门。
CREATE TABLE IF NOT EXISTS memory_drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,               -- 捕获所在会话
  turn        INTEGER,                     -- 触发所在 turn（溯源）
  ts          INTEGER NOT NULL,            -- 捕获时间(ms)
  signal      TEXT NOT NULL,               -- 触发信号: user_confirm|find_rootcause|decision_made|strong_hint
  source_text TEXT NOT NULL,               -- 触发证据原文片段(该 turn user/agent 文本)
  draft       TEXT NOT NULL,               -- 拟稿候选陈述句(待主会话确认真/改写)
  reason      TEXT,                        -- 触发依据短说明
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|promoted|discarded
  created     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_drafts_status ON memory_drafts(status, ts);
`

/**
 * Boot-time FTS integrity helper. NOTE (P2-36): on a regular (non-contentless,
 * non-external-content) FTS5 table, `rebuild` re-derives the index from the
 * FTS table's OWN shadow content — it does NOT re-align with the memories /
 * episodes tables. The store already keeps FTS rows in sync transactionally on
 * every write/delete, so drift should not occur; use this only to repair a
 * corrupted shadow table, not as a reconciliation step.
 */
export function rebuildFts(db: DatabaseSync): void {
  try {
    db.exec("INSERT INTO mem_fts(mem_fts) VALUES('rebuild')")
  } catch {
    // mem_fts empty or already building — harmless.
  }
  try {
    db.exec("INSERT INTO ep_fts(ep_fts) VALUES('rebuild')")
  } catch {
    // ep_fts empty or already building — harmless.
  }
}
