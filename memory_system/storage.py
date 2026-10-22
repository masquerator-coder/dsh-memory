"""SQLite storage core: connection, schema, vector index, clock.

One file holds every layer. Justification for a single store instead of the
design document's multi-store layout (Postgres + Neo4j + Redis + Git):

* the memory system is embedded in an agent process, not a fleet; a second
  service is a deployment tax with no query it can uniquely answer here;
* L2/L3/L4 all read each other inside the same request (L3 evidence walks L2,
  L4 maturity reads L2 outcomes, L3 epistemics reads L4 launch context), so
  cross-store transactions would be required anyway;
* SQLite has a real transaction, FTS5 for lexical retrieval, and sqlite-vec
  for ANN — the three access paths the design needs.

The trade-off is write concurrency: one writer at a time. Background work is
therefore explicitly batched (:mod:`memory_system.maintenance`), not high-rate.
"""

from __future__ import annotations

import datetime as _dt
import sqlite3
import threading
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

from .config import MemoryConfig
from .errors import ProviderError

SCHEMA_VERSION = 4

SCHEMA = """
-- ─── bookkeeping ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    project_id     TEXT PRIMARY KEY,
    display_name   TEXT,
    org_id         TEXT,
    root_path      TEXT,
    created_at     TEXT NOT NULL,
    last_seen_at   TEXT NOT NULL,
    stats          TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);

-- ─── L0 anchor registry (interface-level; see anchors.py) ───────────────────
CREATE TABLE IF NOT EXISTS anchors (
    anchor_id     TEXT PRIMARY KEY,
    session_id    TEXT,
    message_id    TEXT,
    turn          INTEGER,
    step          INTEGER,
    seq           INTEGER,
    event_type    TEXT NOT NULL,
    timestamp     TEXT NOT NULL,
    quote         TEXT,
    keywords      TEXT,
    speaker       TEXT,
    agent         TEXT,
    session_key   TEXT,
    extra         TEXT,
    captured_by   TEXT NOT NULL DEFAULT 'hook',
    provided      TEXT NOT NULL DEFAULT '[]',
    feedback      TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anchor_session ON anchors(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_anchor_time ON anchors(timestamp);

-- ─── L2 episodic memory ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS l2_episodes (
    ord            INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id      TEXT NOT NULL UNIQUE,
    project_id     TEXT NOT NULL,
    session_key    TEXT,
    summary        TEXT NOT NULL,
    summary_hash   TEXT NOT NULL,
    event_type     TEXT,
    participants   TEXT NOT NULL DEFAULT '[]',
    outcome        TEXT,
    importance     REAL NOT NULL,
    access_count   INTEGER NOT NULL DEFAULT 0,
    last_access    TEXT NOT NULL,
    state          TEXT NOT NULL DEFAULT 'active',
    anchor_id      TEXT,
    content_key    TEXT,
    superseded_by  TEXT,
    meta           TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l2_proj_state ON l2_episodes(project_id, state);
CREATE INDEX IF NOT EXISTS idx_l2_created ON l2_episodes(created_at);
CREATE INDEX IF NOT EXISTS idx_l2_hash ON l2_episodes(project_id, summary_hash);
CREATE INDEX IF NOT EXISTS idx_l2_content_key ON l2_episodes(content_key);

CREATE VIRTUAL TABLE IF NOT EXISTS l2_fts USING fts5(
    memory_id UNINDEXED,
    body,
    tokenize = 'unicode61'
);

-- ─── L3 semantic memory ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS l3_entities (
    ord         INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   TEXT NOT NULL UNIQUE,
    project_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    name_norm   TEXT NOT NULL,
    type        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '[]',
    attributes  TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_l3_entity_name ON l3_entities(project_id, name_norm, type);
CREATE INDEX IF NOT EXISTS idx_l3_entity_type ON l3_entities(project_id, type);

CREATE VIRTUAL TABLE IF NOT EXISTS l3_entities_fts USING fts5(
    entity_id UNINDEXED,
    body,
    tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS l3_edges (
    edge_id      TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    head_id      TEXT NOT NULL,
    relation     TEXT NOT NULL,
    tail_id      TEXT NOT NULL,
    confidence   REAL NOT NULL,
    valid_from   TEXT NOT NULL,
    valid_to     TEXT,
    recorded_at  TEXT NOT NULL,
    anchor_id    TEXT,
    meta         TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_l3_edge_triple ON l3_edges(head_id, relation, tail_id);
CREATE INDEX IF NOT EXISTS idx_l3_edge_head ON l3_edges(head_id, relation);
CREATE INDEX IF NOT EXISTS idx_l3_edge_tail ON l3_edges(tail_id, relation);
CREATE INDEX IF NOT EXISTS idx_l3_edge_project ON l3_edges(project_id, valid_to);

-- Append-only history: nothing in the graph is deleted, only closed/disputed.
CREATE TABLE IF NOT EXISTS l3_changes (
    change_id    TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    kind         TEXT NOT NULL,
    target_kind  TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    detail       TEXT NOT NULL,
    reason       TEXT,
    anchor_id    TEXT,
    recorded_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l3_changes_target ON l3_changes(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_l3_changes_time ON l3_changes(recorded_at);

CREATE TABLE IF NOT EXISTS l3_change_sources (
    change_id   TEXT NOT NULL,
    episode_id  TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'evidence',
    PRIMARY KEY (change_id, episode_id)
);
CREATE INDEX IF NOT EXISTS idx_l3_change_sources_ep ON l3_change_sources(episode_id);

CREATE TABLE IF NOT EXISTS l3_communities (
    project_id    TEXT NOT NULL,
    community_id  TEXT NOT NULL,
    label         TEXT,
    summary       TEXT,
    member_ids    TEXT NOT NULL,
    size          INTEGER NOT NULL,
    signature     TEXT NOT NULL,
    computed_at   TEXT NOT NULL,
    PRIMARY KEY (project_id, community_id)
);

-- ─── L4 procedural memory (runtime registry) ───────────────────────────────
CREATE TABLE IF NOT EXISTS l4_skills (
    ord                 INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id            TEXT NOT NULL UNIQUE,
    ns                  TEXT NOT NULL,
    qualified_name      TEXT NOT NULL,
    scope_kind          TEXT NOT NULL,
    scope_ref           TEXT,
    title               TEXT NOT NULL,
    description         TEXT NOT NULL,
    version             INTEGER NOT NULL DEFAULT 1,
    status              TEXT NOT NULL DEFAULT 'candidate',
    tier                TEXT NOT NULL DEFAULT 'warm',
    definition          TEXT NOT NULL,
    launch_contexts     TEXT NOT NULL DEFAULT '[]',
    search_text         TEXT NOT NULL DEFAULT '',
    search_hash         TEXT NOT NULL DEFAULT '',
    origin_project      TEXT,
    parent_skill_id     TEXT,
    merged_from         TEXT NOT NULL DEFAULT '[]',
    supersedes          TEXT NOT NULL DEFAULT '[]',
    promoted_to         TEXT,
    related_skill_ids   TEXT NOT NULL DEFAULT '[]',
    unaudited           INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    published_at        TEXT,
    archived_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_l4_qualified ON l4_skills(qualified_name);
CREATE INDEX IF NOT EXISTS idx_l4_scope ON l4_skills(scope_kind, scope_ref, status);
CREATE INDEX IF NOT EXISTS idx_l4_tier ON l4_skills(scope_kind, scope_ref, tier, status);

CREATE VIRTUAL TABLE IF NOT EXISTS l4_fts USING fts5(
    skill_id UNINDEXED,
    body,
    tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS l4_runs (
    run_id          TEXT PRIMARY KEY,
    skill_id        TEXT NOT NULL,
    project_id      TEXT,
    session_key     TEXT,
    outcome         TEXT NOT NULL,
    success         INTEGER NOT NULL,
    steps           TEXT NOT NULL DEFAULT '[]',
    tool_names      TEXT NOT NULL DEFAULT '[]',
    duration_ms     INTEGER,
    error           TEXT,
    launch_context  TEXT NOT NULL DEFAULT '{}',
    deviation       TEXT,
    anchor_id       TEXT,
    episode_id      TEXT,
    started_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l4_runs_skill ON l4_runs(skill_id, started_at);
CREATE INDEX IF NOT EXISTS idx_l4_runs_project ON l4_runs(project_id, started_at);

-- The raw trajectory log that the maturity/abstraction pipeline mines.
CREATE TABLE IF NOT EXISTS l4_trajectories (
    traj_id         TEXT PRIMARY KEY,
    steps_hash      TEXT NOT NULL,
    project_id      TEXT,
    signature       TEXT NOT NULL,
    variant         TEXT NOT NULL,
    intent_label    TEXT,
    steps           TEXT NOT NULL,
    tool_names      TEXT NOT NULL DEFAULT '[]',
    preconditions   TEXT NOT NULL DEFAULT '{}',
    launch_context  TEXT NOT NULL DEFAULT '{}',
    outcome         TEXT NOT NULL,
    success         INTEGER NOT NULL,
    sessions        TEXT NOT NULL DEFAULT '[]',
    episode_ids     TEXT NOT NULL DEFAULT '[]',
    anchor_id       TEXT,
    derived_skill   TEXT,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l4_traj_sig ON l4_trajectories(signature, variant);
CREATE INDEX IF NOT EXISTS idx_l4_traj_derived ON l4_trajectories(derived_skill);

CREATE TABLE IF NOT EXISTS l4_candidates (
    candidate_id    TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    signature       TEXT NOT NULL,
    variant         TEXT NOT NULL,
    intent_label    TEXT NOT NULL,
    evidence        TEXT NOT NULL,
    preconditions   TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending',
    skill_id        TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_reason     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_l4_cand_sig ON l4_candidates(project_id, signature, variant);

-- Skill archive: global backup pool, never matched at runtime.
CREATE TABLE IF NOT EXISTS l4_archive (
    ord              INTEGER PRIMARY KEY AUTOINCREMENT,
    archive_id       TEXT NOT NULL UNIQUE,
    origin_skill_id  TEXT,
    origin_project   TEXT,
    ns               TEXT NOT NULL,
    name             TEXT NOT NULL,
    description      TEXT NOT NULL,
    search_text      TEXT NOT NULL,
    search_hash      TEXT NOT NULL,
    definition       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'active',
    superseded_by    TEXT,
    similar_to       TEXT NOT NULL DEFAULT '[]',
    labels           TEXT NOT NULL DEFAULT '[]',
    snapshot_at      TEXT NOT NULL,
    last_used_at     TEXT,
    promoted_from    TEXT
);
CREATE INDEX IF NOT EXISTS idx_l4_archive_origin ON l4_archive(origin_skill_id);
CREATE INDEX IF NOT EXISTS idx_l4_archive_hash ON l4_archive(search_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS l4_archive_fts USING fts5(
    archive_id UNINDEXED,
    body,
    tokenize = 'unicode61'
);

-- Promotion recommendations: the system proposes, the user decides.
CREATE TABLE IF NOT EXISTS l4_promotions (
    promotion_id       TEXT PRIMARY KEY,
    cluster_key        TEXT NOT NULL,
    proposal_scope     TEXT NOT NULL DEFAULT 'org',
    suggestion         TEXT NOT NULL,
    rationale          TEXT NOT NULL,
    evidence           TEXT NOT NULL,
    copy_from          TEXT NOT NULL DEFAULT '[]',
    similarity         REAL NOT NULL,
    step_consistency   REAL NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending',
    decision_note      TEXT,
    decided_by         TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    decided_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_l4_promo_status ON l4_promotions(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_l4_promo_cluster
    ON l4_promotions(cluster_key, status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS l4_launches (
    launch_id         TEXT PRIMARY KEY,
    session_key       TEXT,
    turn              INTEGER,
    project_id        TEXT NOT NULL,
    user_text         TEXT,
    intent_labels     TEXT NOT NULL DEFAULT '[]',
    available_tools   TEXT NOT NULL DEFAULT '[]',
    available_skills  TEXT NOT NULL DEFAULT '[]',
    offered           TEXT NOT NULL DEFAULT '[]',
    capability_gaps   TEXT NOT NULL DEFAULT '[]',
    created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l4_launch_time ON l4_launches(created_at);
CREATE INDEX IF NOT EXISTS idx_l4_launch_session ON l4_launches(session_key, turn);

-- ─── operations log: every rejected/degraded thing, for observability ───────
CREATE TABLE IF NOT EXISTS events (
    event_id    TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    layer       TEXT NOT NULL,
    project_id  TEXT,
    detail      TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, created_at);
"""

# Vector tables are created by the VectorIndex because the dimension is config
# dependent and sqlite-vec may be unavailable.
VEC_TABLES = {
    "l2": "vec_l2",
    "l3_entity": "vec_l3_entity",
    "l4_skill": "vec_l4_skill",
    "l4_archive": "vec_l4_archive",
}


def utcnow(tz: _dt.timezone = _dt.timezone.utc) -> _dt.datetime:
    """Single clock entry point so tests can freeze time."""
    return _dt.datetime.now(tz)


def to_iso(ts: _dt.datetime) -> str:
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=_dt.timezone.utc)
    return ts.astimezone(_dt.timezone.utc).isoformat(timespec="microseconds")


def parse_iso(value: str | None) -> _dt.datetime | None:
    if not value:
        return None
    ts = _dt.datetime.fromisoformat(value)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=_dt.timezone.utc)
    return ts


def iso_ago(days: float = 0.0, hours: float = 0.0, *, now: _dt.datetime | None = None) -> str:
    now = now or utcnow()
    return to_iso(now - _dt.timedelta(days=days, hours=hours))


class Store:
    """Thread-safe wrapper over one SQLite connection.

    A single connection is shared and guarded by a lock: the memory system is
    called from one agent loop, and SQLite's internal locking plus a coarse
    Python lock is simpler and faster than a pool for this workload.
    """

    def __init__(self, config: MemoryConfig, *, load_vec: bool = True) -> None:
        self.config = config
        self.path = str(config.db_path)
        self._lock = threading.RLock()
        self._local_depth = 0
        memory_db = self.path == ":memory:"
        uri = f"file:dshmem-{id(self)}?mode=memory&cache=shared" if memory_db else None
        self.conn = sqlite3.connect(
            uri or self.path,
            check_same_thread=False,
            isolation_level=None,  # explicit transactions
            uri=bool(uri),
        )
        self.conn.row_factory = sqlite3.Row
        self._tune(memory_db)
        self._init_schema()
        from .vectors import VectorIndex

        self.vectors = VectorIndex(self.conn, config.embedding.dim, enabled=load_vec)

    # ── connection setup ────────────────────────────────────────────────
    def _tune(self, memory_db: bool) -> None:
        c = self.conn
        c.execute("PRAGMA foreign_keys = ON")
        c.execute("PRAGMA busy_timeout = 5000")
        if not memory_db:
            c.execute(f"PRAGMA journal_mode = {self.config.journal_mode}")
        c.execute("PRAGMA synchronous = NORMAL")
        c.execute("PRAGMA temp_store = MEMORY")

    def _init_schema(self) -> None:
        with self._lock:
            self.conn.executescript(SCHEMA)
            row = self.conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if row is None:
                self.conn.execute(
                    "INSERT INTO meta(key, value) VALUES ('schema_version', ?)",
                    (str(SCHEMA_VERSION),),
                )
            elif int(row["value"]) != SCHEMA_VERSION:
                raise ProviderError(
                    f"database schema v{row['value']} != code v{SCHEMA_VERSION}; "
                    "this build does not migrate older stores (no legacy compatibility is promised)"
                )

    def set_meta(self, key: str, value: str) -> None:
        with self._lock:
            self.conn.execute(
                "INSERT INTO meta(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    def get_meta(self, key: str) -> str | None:
        with self._lock:
            row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    # ── transactions ────────────────────────────────────────────────────
    def transaction(self) -> "_Txn":
        return _Txn(self)

    def execute(self, sql: str, params: Sequence[Any] | dict[str, Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self.conn.execute(sql, params)

    def executemany(self, sql: str, seq: Iterable[Sequence[Any]]) -> sqlite3.Cursor:
        with self._lock:
            return self.conn.executemany(sql, seq)

    def query(self, sql: str, params: Sequence[Any] | dict[str, Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self.conn.execute(sql, params).fetchall()

    def query_one(self, sql: str, params: Sequence[Any] | dict[str, Any] = ()) -> sqlite3.Row | None:
        with self._lock:
            return self.conn.execute(sql, params).fetchone()

    def scalar(self, sql: str, params: Sequence[Any] | dict[str, Any] = (), default: Any = None) -> Any:
        row = self.query_one(sql, params)
        if row is None:
            return default
        return row[0]

    def close(self) -> None:
        with self._lock:
            try:
                self.conn.close()
            except sqlite3.Error:
                pass

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class _Txn:
    """Re-entrant explicit transaction.

    Using a savepoint-per-nesting keeps nested helpers composable: an inner
    ``with store.transaction()`` folds into the outer one without committing.
    """

    def __init__(self, store: Store) -> None:
        self.store = store
        self._savepoint: str | None = None

    def __enter__(self) -> sqlite3.Connection:
        self.store._lock.acquire()
        try:
            if self.store._local_depth == 0:
                self.store.conn.execute("BEGIN IMMEDIATE")
            else:
                self._savepoint = f"sp_{self.store._local_depth}"
                self.store.conn.execute(f"SAVEPOINT {self._savepoint}")
            self.store._local_depth += 1
        except BaseException:
            self.store._lock.release()
            raise
        return self.store.conn

    def __exit__(self, exc_type, exc, tb) -> None:
        self.store._local_depth -= 1
        try:
            if self._savepoint is not None:
                if exc_type is None:
                    self.store.conn.execute(f"RELEASE {self._savepoint}")
                else:
                    self.store.conn.execute(f"ROLLBACK TO {self._savepoint}")
                    self.store.conn.execute(f"RELEASE {self._savepoint}")
            else:
                if exc_type is None:
                    self.store.conn.execute("COMMIT")
                else:
                    self.store.conn.execute("ROLLBACK")
        finally:
            self.store._lock.release()


def json_dumps(value: Any) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=False)


def json_loads(value: str | None, default: Any = None) -> Any:
    import json

    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


__all__ = [
    "Store",
    "SCHEMA",
    "SCHEMA_VERSION",
    "VEC_TABLES",
    "utcnow",
    "to_iso",
    "parse_iso",
    "iso_ago",
    "json_dumps",
    "json_loads",
    "Iterator",
    "Path",
]