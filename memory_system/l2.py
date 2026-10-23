"""L2 — episodic memory.

What this layer is *for*: "what happened", with a recency gate. The decay model
is an **attention** mechanism, not a truth mechanism — a faded episode is still
there, still retrievable on demand, still citable as evidence for L3.

Scoring (design document §4.2):

    S = S0 * importance * (1 + beta * ln(1 + access_count))
    R = exp(-dt_hours / S)
    score = similarity * (retention_floor + (1 - retention_floor) * R)

``similarity`` is a blend of vector cosine and FTS5 lexical rank, because pure
vector recall under-performs on exact identifiers (error codes, file paths) and
pure lexical recall under-performs on paraphrase.

State machine — three states, monotone in the sense that a memory may be
revived but never deleted:

    active   R >= 0.30
    dormant  0.05 <= R < 0.30
    archived R < 0.05
"""

from __future__ import annotations

import hashlib
import math
import sqlite3
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from .config import L2Config, MemoryConfig
from .embedding import EmbeddingProvider
from .errors import NotFoundError
from .storage import Store, json_dumps, json_loads, parse_iso, to_iso, utcnow
from .text import estimate_tokens, fts_index_text, fts_match_expression

STATE_ACTIVE = "active"
STATE_DORMANT = "dormant"
STATE_ARCHIVED = "archived"
STATES = (STATE_ACTIVE, STATE_DORMANT, STATE_ARCHIVED)


def new_memory_id() -> str:
    # Time-sortable prefix keeps SQLite locality good and makes ids debuggable.
    return "ep_" + uuid.uuid4().hex[:16]


@dataclass(slots=True)
class Episode:
    memory_id: str
    project_id: str
    summary: str
    importance: float
    created_at: str
    last_access: str
    access_count: int = 0
    state: str = STATE_ACTIVE
    event_type: str | None = None
    participants: list[str] = field(default_factory=list)
    outcome: str | None = None
    session_key: str | None = None
    anchor_id: str | None = None
    content_key: str | None = None
    superseded_by: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    ordinal: int = 0

    def to_row(self) -> dict[str, Any]:
        return {
            "ord": self.ordinal,
            "memory_id": self.memory_id,
            "project_id": self.project_id,
            "summary": self.summary,
            "importance": self.importance,
            "created_at": self.created_at,
            "last_access": self.last_access,
            "access_count": self.access_count,
            "state": self.state,
            "event_type": self.event_type,
            "participants": self.participants,
            "outcome": self.outcome,
            "session_key": self.session_key,
            "anchor_id": self.anchor_id,
            "content_key": self.content_key,
            "superseded_by": self.superseded_by,
            "meta": self.meta,
        }

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Episode":
        return cls(
            ordinal=int(row["ord"]),
            memory_id=row["memory_id"],
            project_id=row["project_id"],
            summary=row["summary"],
            importance=float(row["importance"]),
            created_at=row["created_at"],
            last_access=row["last_access"],
            access_count=int(row["access_count"]),
            state=row["state"],
            event_type=row["event_type"],
            participants=json_loads(row["participants"], []) or [],
            outcome=row["outcome"],
            session_key=row["session_key"],
            anchor_id=row["anchor_id"],
            content_key=row["content_key"],
            superseded_by=row["superseded_by"],
            meta=json_loads(row["meta"], {}) or {},
        )


@dataclass(slots=True)
class Retention:
    """Computed decay state of one episode at a given instant."""

    stability_hours: float
    retention: float
    elapsed_hours: float
    state: str

    @property
    def weight(self) -> float:
        return self.retention


@dataclass(slots=True)
class EpisodeHit:
    episode: Episode
    similarity: float
    retention: float
    score: float
    stability_hours: float = 0.0
    matched_terms: list[str] = field(default_factory=list)
    rank: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "memory_id": self.episode.memory_id,
            "project_id": self.episode.project_id,
            "summary": self.episode.summary,
            "importance": round(self.episode.importance, 4),
            "state": self.episode.state,
            "retention": round(self.retention, 4),
            "similarity": round(self.similarity, 4),
            "score": round(self.score, 4),
            "event_type": self.episode.event_type,
            "outcome": self.episode.outcome,
            "participants": self.episode.participants,
            "created_at": self.episode.created_at,
            "last_access": self.episode.last_access,
            "access_count": self.episode.access_count,
            "anchor_id": self.episode.anchor_id,
        }


def summary_hash(text: str) -> str:
    return hashlib.sha1(" ".join(text.split()).lower().encode("utf-8")).hexdigest()


def _descending_time(raw: str) -> float:
    """Sort helper: later timestamps first.

    ``created_at`` is an ISO string, and mixing a negated float into the same
    sort key as ``-score`` keeps one comparison instead of two passes.
    """
    ts = parse_iso(raw)
    return -ts.timestamp() if ts is not None else float("inf")


class EpisodicMemory:
    """L2 store. All methods are synchronous and cheap; callers own scheduling."""

    def __init__(
        self,
        store: Store,
        config: MemoryConfig,
        embeddings: EmbeddingProvider,
        *,
        embedding_cache: Any | None = None,
    ) -> None:
        self.store = store
        self.config = config
        self.cfg: L2Config = config.l2
        self.embeddings = embeddings
        self._cache = embedding_cache
        self._tokenizer = config.lexical.tokenizer

    # ── decay math ──────────────────────────────────────────────────────
    def stability_hours(self, importance: float, access_count: int) -> float:
        return (
            self.cfg.base_stability_hours
            * max(importance, 1e-6)
            * (1.0 + self.cfg.beta * math.log1p(max(access_count, 0)))
        )

    def state_for_retention(self, retention: float) -> str:
        if retention >= self.cfg.active_threshold:
            return STATE_ACTIVE
        if retention >= self.cfg.dormant_threshold:
            return STATE_DORMANT
        return STATE_ARCHIVED

    def compute(self, episode: Episode, now: Any | None = None) -> Retention:
        now = now or utcnow()
        last = parse_iso(episode.last_access) or parse_iso(episode.created_at) or now
        elapsed = max(0.0, (now - last).total_seconds() / 3600.0)
        stability = self.stability_hours(episode.importance, episode.access_count)
        retention = math.exp(-elapsed / stability) if stability > 0 else 0.0
        return Retention(stability, retention, elapsed, self.state_for_retention(retention))

    # ── writes ──────────────────────────────────────────────────────────
    def add(
        self,
        *,
        project_id: str,
        summary: str,
        importance: float | None = None,
        event_type: str | None = None,
        participants: Sequence[str] | None = None,
        outcome: str | None = None,
        session_key: str | None = None,
        anchor_id: str | None = None,
        content_key: str | None = None,
        meta: dict[str, Any] | None = None,
        dedup: bool = True,
    ) -> Episode:
        summary = (summary or "").strip()
        if not summary:
            raise ValueError("summary must be non-empty")
        importance = self._coerce_importance(importance)
        h = summary_hash(summary)
        if dedup:
            existing = self._find_duplicate(project_id, summary, h, content_key)
            if existing is not None:
                return existing
        memory_id = new_memory_id()
        now = to_iso(utcnow())
        vec = self._embed(summary)
        with self.store.transaction():
            cur = self.store.execute(
                """INSERT INTO l2_episodes
                   (memory_id, project_id, session_key, summary, summary_hash, event_type,
                    participants, outcome, importance, access_count, last_access, state,
                    anchor_id, content_key, superseded_by, meta, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,0,?,'active',?,?,NULL,?,?,?)""",
                (
                    memory_id,
                    project_id,
                    session_key,
                    summary,
                    h,
                    event_type,
                    json_dumps(list(participants or [])),
                    outcome,
                    importance,
                    now,
                    anchor_id,
                    content_key,
                    json_dumps(meta or {}),
                    now,
                    now,
                ),
            )
            ordinal = int(cur.lastrowid)
            self.store.execute(
                "INSERT INTO l2_fts(memory_id, body) VALUES (?, ?)",
                (memory_id, self._fts_body(summary, event_type, participants)),
            )
            self.store.vectors.upsert("l2", ordinal, vec)
        episode = self.get(memory_id)
        episode.ordinal = ordinal
        return episode

    def reinforce(self, memory_ids: Sequence[str], *, amount: int = 1) -> int:
        """Spacing effect: retrieval strengthens the memory's stability."""
        if not memory_ids:
            return 0
        now = utcnow()
        now_iso = to_iso(now)
        with self.store.transaction():
            count = 0
            for memory_id in memory_ids:
                row = self.store.query_one(
                    "SELECT * FROM l2_episodes WHERE memory_id = ?", (memory_id,)
                )
                if row is None:
                    continue
                episode = Episode.from_row(row)
                bumped = Episode.from_row(row)
                bumped.access_count = episode.access_count + amount
                bumped.last_access = now_iso
                # An access may revive an archived memory, but the state it
                # revives *into* follows the usual retention thresholds: a run
                # of retrievals on a stale memory should not oscillate between
                # archived and active on every refresh_states pass.
                state = (
                    self.compute(bumped, now).state
                    if episode.state == STATE_ARCHIVED
                    else episode.state
                )
                cur = self.store.execute(
                    """UPDATE l2_episodes
                          SET access_count = access_count + ?,
                              last_access  = ?,
                              state        = ?,
                              updated_at   = ?
                        WHERE memory_id = ?""",
                    (amount, now_iso, state, now_iso, memory_id),
                )
                count += cur.rowcount or 0
        return count

    def supersede(self, memory_id: str, by_memory_id: str) -> None:
        """Mark an episode as factually replaced by a newer one (never deleted)."""
        with self.store.transaction():
            self.store.execute(
                "UPDATE l2_episodes SET superseded_by = ?, updated_at = ? WHERE memory_id = ?",
                (by_memory_id, to_iso(utcnow()), memory_id),
            )

    # ── decay batch ─────────────────────────────────────────────────────
    def refresh_states(self, *, limit: int = 5000, now: Any | None = None) -> dict[str, int]:
        """Recompute ``state`` for every episode whose state can have changed.

        Runs as one transaction over a bounded batch: episodes in ``archived``
        are skipped (only an access can revive them, and that path updates the
        state directly).
        """
        now = now or utcnow()
        rows = self.store.query(
            "SELECT * FROM l2_episodes WHERE state != 'archived' "
            "ORDER BY last_access DESC LIMIT ?",
            (limit,),
        )
        transitions = {STATE_ACTIVE: 0, STATE_DORMANT: 0, STATE_ARCHIVED: 0}
        changed = 0
        with self.store.transaction():
            for row in rows:
                episode = Episode.from_row(row)
                new_state = self.compute(episode, now).state
                if new_state != episode.state:
                    transitions[new_state] += 1
                    changed += 1
                    self.store.execute(
                        "UPDATE l2_episodes SET state = ?, updated_at = ? WHERE memory_id = ?",
                        (new_state, to_iso(now), episode.memory_id),
                    )
        return {"examined": len(rows), "changed": changed, **transitions}

    # ── reads ───────────────────────────────────────────────────────────
    def get(self, memory_id: str) -> Episode:
        row = self.store.query_one("SELECT * FROM l2_episodes WHERE memory_id = ?", (memory_id,))
        if row is None:
            raise NotFoundError(f"episode {memory_id} not found")
        return Episode.from_row(row)

    def by_ids(self, memory_ids: Iterable[str]) -> dict[str, Episode]:
        ids = [m for m in memory_ids if m]
        if not ids:
            return {}
        out: dict[str, Episode] = {}
        chunk_size = 400
        for start in range(0, len(ids), chunk_size):
            chunk = ids[start : start + chunk_size]
            marks = ",".join("?" * len(chunk))
            for row in self.store.query(
                f"SELECT * FROM l2_episodes WHERE memory_id IN ({marks})", chunk
            ):
                ep = Episode.from_row(row)
                out[ep.memory_id] = ep
        return out

    def search(
        self,
        query: str,
        *,
        project_ids: Sequence[str],
        k: int = 8,
        include_dormant: bool | None = None,
        include_archived: bool = False,
        include_superseded: bool = False,
        event_types: Sequence[str] | None = None,
        since: str | None = None,
        until: str | None = None,
        reinforce: bool | None = None,
        now: Any | None = None,
    ) -> list[EpisodeHit]:
        """Hybrid recall (vector + lexical) re-ranked by retention."""
        query = (query or "").strip()
        if not query or not project_ids:
            return []
        project_ids = list(project_ids)
        include_dormant = (
            self.cfg.default_include_dormant if include_dormant is None else include_dormant
        )
        now = now or utcnow()

        allowed = self._allowed_ids(project_ids)
        if not allowed:
            return []
        qvec = self._embed(query)
        vec_hits = self.store.vectors.knn("l2", qvec, k=max(k * 4, 24), allowed_rowids=allowed)
        lex_hits = dict(self._lexical_hits(query, project_ids, limit=max(k * 4, 24)))

        ord_to_id = self._ids_by_ordinal([rowid for rowid, _ in vec_hits])
        candidates: dict[str, float] = {}
        for rowid, distance in vec_hits:
            memory_id = ord_to_id.get(int(rowid))
            if memory_id:
                candidates[memory_id] = max(candidates.get(memory_id, 0.0), 1.0 - distance)
        for memory_id, sim in lex_hits.items():
            candidates[memory_id] = max(candidates.get(memory_id, 0.0), sim)

        # A candidate whose blended similarity is negligible is noise from a
        # k-NN over-fetch, not a recollection. Dropping it early prevents
        # retention from *inflating* an irrelevant row into the answer list.
        # Lexical hits carry a normalised bm25 score (>= 0.45 by construction),
        # so the floor is only meaningful for the vector half.
        floor = self._similarity_floor()
        candidates = {
            mid: sim
            for mid, sim in candidates.items()
            if sim >= floor or mid in lex_hits
        }
        if not candidates:
            return []

        episodes = self.by_ids(candidates.keys())
        hits: list[EpisodeHit] = []
        states = {STATE_ACTIVE}
        if include_dormant:
            states.add(STATE_DORMANT)
        if include_archived:
            states.add(STATE_ARCHIVED)
        forgotten = set(self._forgotten_ids(candidates.keys()))
        for memory_id, similarity in candidates.items():
            ep = episodes.get(memory_id)
            if ep is None or ep.project_id not in project_ids:
                continue
            if ep.superseded_by and not include_superseded:
                continue
            # A user who said "forget this" must not get the item back from the
            # next recall. Decay-archived rows may opt in through
            # ``include_archived``; a user-archived row never does, because the
            # request was explicit and is reversible only via ``restore``.
            if memory_id in forgotten:
                continue
            if event_types and ep.event_type not in event_types:
                continue
            if since and ep.created_at < since:
                continue
            if until and ep.created_at > until:
                continue
            # Retention is computed live. The ``state`` column is a cache
            # maintained by refresh_states() and may lag by hours; filtering on
            # it would let decayed memories resurface until the next batch.
            ret = self.compute(ep, now)
            if ret.state not in states:
                continue
            score = similarity * (
                self.cfg.retention_floor + (1.0 - self.cfg.retention_floor) * ret.retention
            )
            hits.append(
                EpisodeHit(
                    episode=ep,
                    similarity=similarity,
                    retention=ret.retention,
                    score=score,
                    stability_hours=ret.stability_hours,
                )
            )
        # Score descending; ties go to the newest memory, so a fresh fact
        # outranks an equally relevant old one.
        hits.sort(key=lambda h: (-h.score, _descending_time(h.episode.created_at)))
        hits = hits[:k]
        for i, hit in enumerate(hits):
            hit.rank = i + 1
        if reinforce is None:
            reinforce = self.cfg.reinforce_on_retrieve
        if reinforce and hits:
            self.reinforce([h.episode.memory_id for h in hits])
            touched = {h.episode.memory_id for h in hits}
            # Reflect the reinforcement in the returned projection.
            for hit in hits:
                if hit.episode.memory_id in touched:
                    hit.episode.access_count += 1
                    hit.episode.last_access = to_iso(now)
        return hits

    def recent(
        self,
        project_ids: Sequence[str],
        *,
        limit: int = 10,
        include_dormant: bool = True,
    ) -> list[Episode]:
        if not project_ids:
            return []
        marks = ",".join("?" * len(project_ids))
        states = ("active", "dormant") if include_dormant else ("active",)
        state_marks = ",".join("?" * len(states))
        rows = self.store.query(
            f"SELECT * FROM l2_episodes WHERE project_id IN ({marks}) "
            f"AND state IN ({state_marks}) AND superseded_by IS NULL "
            "ORDER BY created_at DESC LIMIT ?",
            (*project_ids, *states, limit),
        )
        return [Episode.from_row(r) for r in rows]

    def stats(self, project_id: str | None = None) -> dict[str, Any]:
        where = "WHERE project_id = ?" if project_id else ""
        params: tuple[Any, ...] = (project_id,) if project_id else ()
        rows = self.store.query(
            f"SELECT state, count(*) AS n FROM l2_episodes {where} GROUP BY state", params
        )
        by_state = {row["state"]: int(row["n"]) for row in rows}
        total = sum(by_state.values())
        return {
            "total": total,
            "by_state": by_state,
            "archive_rate": (by_state.get(STATE_ARCHIVED, 0) / total) if total else 0.0,
            "avg_importance": float(
                self.store.scalar(
                    f"SELECT avg(importance) FROM l2_episodes {where}", params, default=0.0
                )
                or 0.0
            ),
        }

    def evidence_strength(self, memory_ids: Sequence[str], *, now: Any | None = None) -> float:
        """Aggregate strength of the episodes backing some L3 claim.

        Used by the graph's ``evidence`` conflict policy: fresher, more
        reinforced, higher-importance episodes win. The aggregate is
        ``max``-like (sum of top-3), not a mean, so one strong recollection is
        not diluted by weak ones.
        """
        now = now or utcnow()
        episodes = self.by_ids(memory_ids)
        if not episodes:
            return 0.0
        strengths = []
        for ep in episodes.values():
            ret = self.compute(ep, now)
            strengths.append(ep.importance * (0.5 + 0.5 * ret.retention))
        strengths.sort(reverse=True)
        return sum(strengths[:3])

    # ── internals ───────────────────────────────────────────────────────
    def _coerce_importance(self, importance: float | None) -> float:
        if importance is None:
            return self.cfg.default_importance
        try:
            value = float(importance)
        except (TypeError, ValueError):
            return self.cfg.default_importance
        if value != value:  # NaN
            return self.cfg.default_importance
        return max(self.cfg.min_importance, min(1.0, value))

    def _embed(self, text: str) -> list[float]:
        if self._cache is not None:
            return self._cache.embed_one(text)
        return self.embeddings.embed_one(text)

    def _allowed_ids(self, project_ids: Sequence[str]) -> set[int]:
        marks = ",".join("?" * len(project_ids))
        rows = self.store.query(
            f"SELECT ord FROM l2_episodes WHERE project_id IN ({marks})", list(project_ids)
        )
        return {int(r["ord"]) for r in rows}

    def _similarity_floor(self) -> float:
        """Noise floor for cosine similarity, chosen for the active backend.

        The provider's own ``name`` is the authority, but L2 may hold an
        :class:`~memory_system.cache.EmbeddingCache` (which exposes no
        ``name``) and a fallback provider can override it, so walk to the
        innermost object that declares one before falling back to config.
        """
        name: Any = None
        provider: Any = self.embeddings
        for _ in range(4):
            name = getattr(provider, "name", None)
            if name is not None:
                break
            provider = getattr(provider, "provider", None)
            if provider is None:
                break
        if name is None:
            name = self.config.embedding.provider
        if name in ("hash", "degraded"):
            return self.cfg.min_similarity_lexical
        return self.cfg.min_similarity

    def _forgotten_ids(self, memory_ids: Iterable[str]) -> list[str]:
        """Rows the user archived explicitly, as opposed to decay-archived ones.

        ``forget()`` stamps ``meta.forgotten_at``; ``restore()`` clears it. The
        marker, not the ``state`` column, is what distinguishes an instruction
        ("never show me this again") from a consequence (decay).
        """
        ids = [m for m in memory_ids if m]
        if not ids:
            return []
        marks = ",".join("?" * len(ids))
        rows = self.store.query(
            f"SELECT memory_id FROM l2_episodes "
            f"WHERE memory_id IN ({marks}) AND json_extract(meta, '$.forgotten_at') IS NOT NULL",
            ids,
        )
        return [row["memory_id"] for row in rows]

    def _ids_by_ordinal(self, ordinals: Iterable[int]) -> dict[int, str]:
        ords = [int(o) for o in ordinals]
        if not ords:
            return {}
        marks = ",".join("?" * len(ords))
        rows = self.store.query(
            f"SELECT ord, memory_id FROM l2_episodes WHERE ord IN ({marks})", ords
        )
        return {int(r["ord"]): r["memory_id"] for r in rows}

    def _lexical_hits(self, query: str, project_ids: Sequence[str], *, limit: int) -> list[tuple[str, float]]:
        match = fts_match_expression(query, tokenizer=self._tokenizer)
        if not match:
            return []
        marks = ",".join("?" * len(project_ids))
        rows = self.store.query(
            f"""SELECT f.memory_id, bm25(l2_fts) AS rank
                  FROM l2_fts f
                  JOIN l2_episodes e ON e.memory_id = f.memory_id
                 WHERE l2_fts MATCH ? AND e.project_id IN ({marks})
                 ORDER BY rank LIMIT ?""",
            (match, *project_ids, limit),
        )
        if not rows:
            return []
        # bm25() is negative and unbounded; map the batch into (0, 1].
        ranks = [float(r["rank"]) for r in rows]
        best, worst = min(ranks), max(ranks)
        span = best - worst if worst < best else 0.0
        out: list[tuple[str, float]] = []
        for row in rows:
            r = float(row["rank"])
            # best rank -> ~0.9, worst -> ~0.45. Lexical hits are strong signals
            # for exact-term queries, so the floor is deliberately high.
            norm = 0.9 - (0.45 * ((r - best) / span) if span > 0 else 0.0)
            out.append((row["memory_id"], norm))
        return out

    def _fts_body(self, summary: str, event_type: str | None, participants: Sequence[str] | None) -> str:
        """The pre-segmented body stored in ``l2_fts``.

        Segmentation happens here, not in SQLite: the table's ``unicode61``
        tokenizer treats a whole Chinese sentence as one token, so a query term
        would never match. See :func:`~memory_system.text.fts_index_text`.
        """
        parts = [summary]
        if event_type:
            parts.append(event_type)
        if participants:
            parts.extend(participants)
        return fts_index_text(" ".join(parts), tokenizer=self._tokenizer)

    def find_duplicate(self, project_id: str, summary: str, content_key: str | None = None) -> Episode | None:
        """The row a write of ``summary`` would be merged into, or ``None``.

        Read-only twin of :meth:`_find_duplicate`: this one never reinforces
        the match, so a caller may ask "would this be a new row?" *before*
        writing without side effects.
        """
        summary = (summary or "").strip()
        if not summary:
            return None
        return self._find_duplicate(project_id, summary, summary_hash(summary), content_key)

    def _find_duplicate(
        self, project_id: str, summary: str, h: str, content_key: str | None
    ) -> Episode | None:
        if content_key:
            row = self.store.query_one(
                "SELECT * FROM l2_episodes WHERE project_id = ? AND content_key = ? LIMIT 1",
                (project_id, content_key),
            )
            if row is not None:
                return Episode.from_row(row)
        row = self.store.query_one(
            "SELECT * FROM l2_episodes WHERE project_id = ? AND summary_hash = ? LIMIT 1",
            (project_id, h),
        )
        if row is not None:
            return Episode.from_row(row)
        # Near-duplicate: only worth a vector probe when the text is long enough
        # for similarity to mean something.
        if estimate_tokens(summary) < 12:
            return None
        allowed = {
            int(r["ord"])
            for r in self.store.query(
                "SELECT ord FROM l2_episodes WHERE project_id = ? AND state != 'archived' LIMIT 2000",
                (project_id,),
            )
        }
        if not allowed:
            return None
        qvec = self._embed(summary)
        for rowid, distance in self.store.vectors.knn("l2", qvec, k=3, allowed_rowids=allowed):
            similarity = 1.0 - distance
            if similarity >= self.cfg.dedup_similarity:
                memory_id = self._ids_by_ordinal([rowid]).get(int(rowid))
                if memory_id:
                    self.reinforce([memory_id])
                    return self.get(memory_id)
        return None