"""L0 — anchor registry.

Per the brief, L0 is **out of scope for design work**: this module fixes the
*interface* that L2/L3 consume, plus the smallest correct implementation so
provenance can be exercised end to end. The DSH event binding lives in
``memory_system.adapters.dsh`` and is intentionally thin.

The one design commitment made here matters to everything above it: an anchor
is an **opaque reference plus a monotonic ordering key**. Consumers may only

* store it,
* pass it through to a caller (who dereferences it in its own log),
* order events by ``(session_key, seq)``.

Nothing above L0 reads anchor contents, because no portable Agent runtime
exposes arbitrary log text to a plugin (DSH does not; see DESIGN.md §Anchor
boundary). That keeps the model of "provenance" honest: a pointer, not a copy.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .storage import Store, json_dumps, json_loads, to_iso, utcnow


@dataclass(slots=True)
class Anchor:
    """A pointer into some host session log. Field meanings are host-defined."""

    anchor_id: str
    session_id: str | None = None
    message_id: str | None = None
    turn: int | None = None
    step: int | None = None
    seq: int | None = None
    event_type: str = "unknown"
    timestamp: str = ""
    quote: str | None = None
    keywords: list[str] = field(default_factory=list)
    speaker: str | None = None
    # Opaque host identity (an agent id is a common case: two agents can
    # share one conversation log).
    agent: str | None = None
    # Namespaced session key so anchors from different hosts never collide.
    session_key: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    captured_by: str = "hook"
    provided: list[str] = field(default_factory=list)
    feedback: dict[str, Any] | None = None

    def sort_key(self) -> tuple[str, int]:
        return (self.session_key or self.session_id or "", self.seq or -1)

    def to_dict(self) -> dict[str, Any]:
        return {
            "anchor_id": self.anchor_id,
            "session_id": self.session_id,
            "message_id": self.message_id,
            "turn": self.turn,
            "step": self.step,
            "seq": self.seq,
            "event_type": self.event_type,
            "timestamp": self.timestamp,
            "quote": self.quote,
            "keywords": list(self.keywords),
            "speaker": self.speaker,
            "agent": self.agent,
            "session_key": self.session_key,
            "extra": dict(self.extra),
            "captured_by": self.captured_by,
            "provided": list(self.provided),
            "feedback": self.feedback,
        }

    @classmethod
    def from_row(cls, row: Any) -> "Anchor":
        return cls(
            anchor_id=row["anchor_id"],
            session_id=row["session_id"],
            message_id=row["message_id"],
            turn=row["turn"],
            step=row["step"],
            seq=row["seq"],
            event_type=row["event_type"],
            timestamp=row["timestamp"],
            quote=row["quote"],
            keywords=json_loads(row["keywords"], []) or [],
            speaker=row["speaker"],
            agent=row["agent"],
            session_key=row["session_key"],
            extra=json_loads(row["extra"], {}) or {},
            captured_by=row["captured_by"],
            provided=json_loads(row["provided"], []) or [],
            feedback=json_loads(row["feedback"], None),
        )


def new_anchor_id() -> str:
    return "an_" + secrets.token_hex(6)


@runtime_checkable
class AnchorSource(Protocol):
    """What an embedding agent (or its adapter) must supply.

    A host that cannot capture hooks simply passes ``None`` for anchors; L2 and
    L3 then record ``anchor_id=None`` and remain fully functional. Anchors are
    a provenance enrichment, never a write precondition.
    """

    def current(self) -> Anchor | None:
        """Most recent anchor for the calling execution, if known."""

    def near(self, limit: int = 20) -> list[Anchor]:
        """The recent anchor window, newest last."""

    def capture(self, **fields: Any) -> Anchor:
        """Persist a host event as an anchor."""


class AnchorRegistry:
    """Concrete registry over the shared SQLite store."""

    def __init__(self, store: Store) -> None:
        self.store = store

    # ── writes ──────────────────────────────────────────────────────────
    def capture(
        self,
        *,
        session_id: str | None = None,
        session_key: str | None = None,
        message_id: str | None = None,
        turn: int | None = None,
        step: int | None = None,
        seq: int | None = None,
        event_type: str = "unknown",
        timestamp: str | None = None,
        quote: str | None = None,
        keywords: list[str] | None = None,
        speaker: str | None = None,
        agent: str | None = None,
        extra: dict[str, Any] | None = None,
        captured_by: str = "hook",
        provided: list[str] | None = None,
        anchor_id: str | None = None,
    ) -> Anchor:
        anchor = Anchor(
            anchor_id=anchor_id or new_anchor_id(),
            session_id=session_id,
            session_key=session_key
            or (f"{agent}:{session_id}" if (session_id and agent) else session_id),
            message_id=message_id,
            turn=turn,
            step=step,
            seq=seq,
            event_type=event_type,
            timestamp=timestamp or to_iso(utcnow()),
            quote=(quote or None) and quote[:400],
            keywords=list(keywords or []),
            speaker=speaker,
            agent=agent,
            extra=dict(extra or {}),
            captured_by=captured_by,
            provided=list(
                provided
                or [
                    name
                    for name, value in (
                        ("session_id", session_id),
                        ("message_id", message_id),
                        ("turn", turn),
                        ("seq", seq),
                    )
                    if value is not None
                ]
            ),
        )
        with self.store.transaction():
            self.store.execute(
                """INSERT OR REPLACE INTO anchors
                   (anchor_id, session_id, message_id, turn, step, seq, event_type, timestamp,
                    quote, keywords, speaker, agent, session_key, extra, captured_by, provided,
                    feedback, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    anchor.anchor_id,
                    anchor.session_id,
                    anchor.message_id,
                    anchor.turn,
                    anchor.step,
                    anchor.seq,
                    anchor.event_type,
                    anchor.timestamp,
                    anchor.quote,
                    json_dumps(anchor.keywords),
                    anchor.speaker,
                    anchor.agent,
                    anchor.session_key,
                    json_dumps(anchor.extra),
                    anchor.captured_by,
                    json_dumps(anchor.provided),
                    None,
                    to_iso(utcnow()),
                ),
            )
        return anchor

    def feedback(self, anchor_id: str, status: str, note: str | None = None) -> Anchor:
        """Record a caller's claim about whether an anchor resolved.

        The system cannot verify this (see DESIGN.md §Anchor boundary); it is
        stored verbatim for display and for ranking downstream.
        """
        if status not in {"confirmed", "stale", "unresolvable"}:
            raise ValueError("status must be confirmed|stale|unresolvable")
        payload = {"status": status, "note": note, "at": to_iso(utcnow())}
        with self.store.transaction():
            self.store.execute(
                "UPDATE anchors SET feedback = ? WHERE anchor_id = ?",
                (json_dumps(payload), anchor_id),
            )
        anchor = self.get(anchor_id)
        if anchor is None:
            raise KeyError(anchor_id)
        return anchor

    # ── reads ───────────────────────────────────────────────────────────
    def get(self, anchor_id: str | None) -> Anchor | None:
        if not anchor_id:
            return None
        row = self.store.query_one("SELECT * FROM anchors WHERE anchor_id = ?", (anchor_id,))
        return Anchor.from_row(row) if row else None

    @staticmethod
    def _session_clause(session_key: str) -> tuple[str, tuple[Any, ...]]:
        """Match either the namespaced session key or the bare session id.

        Callers may know only one of the two: an adapter that has not resolved
        an agent id supplies ``session_key = session_id``.
        """
        return "(session_key = ? OR (session_key IS NULL AND session_id = ?))", (session_key, session_key)

    def latest(self, session_key: str | None = None, *, max_seq: int | None = None) -> Anchor | None:
        if session_key:
            clause, params = self._session_clause(session_key)
            if max_seq is None:
                row = self.store.query_one(
                    f"SELECT * FROM anchors WHERE {clause} AND seq IS NOT NULL "
                    "ORDER BY seq DESC LIMIT 1",
                    params,
                )
            else:
                row = self.store.query_one(
                    f"SELECT * FROM anchors WHERE {clause} AND seq IS NOT NULL AND seq <= ? "
                    "ORDER BY seq DESC LIMIT 1",
                    (*params, max_seq),
                )
        else:
            row = self.store.query_one(
                "SELECT * FROM anchors ORDER BY timestamp DESC, created_at DESC LIMIT 1"
            )
        return Anchor.from_row(row) if row else None

    def window(self, session_key: str, *, before_seq: int | None = None, limit: int = 20) -> list[Anchor]:
        """Anchors immediately preceding ``before_seq`` (or the newest)."""
        clause, params = self._session_clause(session_key)
        if before_seq is None:
            rows = self.store.query(
                f"SELECT * FROM anchors WHERE {clause} ORDER BY seq DESC LIMIT ?",
                (*params, limit),
            )
        else:
            rows = self.store.query(
                f"SELECT * FROM anchors WHERE {clause} AND seq < ? ORDER BY seq DESC LIMIT ?",
                (*params, before_seq, limit),
            )
        return [Anchor.from_row(r) for r in reversed(rows)]

    def count(self) -> int:
        return int(self.store.scalar("SELECT count(*) FROM anchors", default=0))