"""Migrating a database to a different embedding model.

Vectors from two models live in incomparable spaces, so a model change is a
*rebuild*, not a config edit: every stored vector must be recomputed in the new
space. This module performs that rebuild in place, and refuses when the new
dimension differs from the on-disk one unless the caller explicitly allows a
destructive re-dimension (vec0 tables are fixed-width).
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Callable

from .embedding import EmbeddingProvider
from .errors import MemoryError, ProviderError
from .storage import Store, VEC_TABLES, json_loads


@dataclass(slots=True)
class Reprogress:
    """Progress of a re-embedding run."""

    kind: str
    done: int = 0
    total: int = 0
    error: str | None = None


@dataclass(slots=True)
class ReembedReport:
    previous_fingerprint: str | None = None
    new_fingerprint: str = ""
    previous_dim: int | None = None
    new_dim: int = 0
    reembedded: dict[str, int] = field(default_factory=dict)
    dropped: dict[str, int] = field(default_factory=dict)
    redimensioned: bool = False
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "previous_fingerprint": self.previous_fingerprint,
            "new_fingerprint": self.new_fingerprint,
            "previous_dim": self.previous_dim,
            "new_dim": self.new_dim,
            "reembedded": self.reembedded,
            "dropped": self.dropped,
            "redimensioned": self.redimensioned,
            "errors": self.errors,
        }


def _l2_text(row: sqlite3.Row) -> str:
    return row["summary"]


def _l3_entity_text(row: sqlite3.Row) -> str:
    from .l3 import SemanticMemory

    aliases = json_loads(row["aliases"], []) or []
    return SemanticMemory._entity_text(row["name"], row["entity_type"], aliases)


def _l4_skill_text(row: sqlite3.Row) -> str:
    from .l4 import SkillDefinition

    definition = json_loads(row["definition"], None)
    if definition is None:  # corrupt slot — keep the raw dump rather than skip
        return _text_of(row["definition"])
    return SkillDefinition.from_dict(definition).search_text()


def _l4_archive_text(row: sqlite3.Row) -> str:
    text = row["search_text"]
    if text:
        return text
    # Legacy rows predating the search_text column: rebuild it from the
    # structured definition, exactly what snapshot() did at write time.
    from .l4 import SkillDefinition

    definition = json_loads(row["definition"], None)
    if definition is None:
        return ""
    return SkillDefinition.from_dict(definition).search_text()


# (kind, source table, text source columns, rowid column, text builder).
#
# The builders above must produce EXACTLY the text the layer's write path
# embeds, so a re-embedded vector is indistinguishable from a freshly
# written one — otherwise recall compares a query against a different text
# than the row actually represents. These were SQL expressions once, which
# could not honor the writers: l3's write path folds entity_type and the
# *parsed* alias list into the text (`SemanticMemory._entity_text`), not
# the raw JSON-dumped aliases column; l4_skill's is
# `SkillDefinition.search_text()` over the structured definition, not the
# dumped JSON; and l4_archive rows already carry the exact embedded text
# in their own `search_text` column.
#
# l3/l4 imports stay inside the builders to avoid an import cycle
# (system -> migrate lazily too).
_SOURCES = [
    ("l2", "l2_episodes", "summary", "ord", _l2_text),
    ("l3_entity", "l3_entities", "name, type AS entity_type, aliases", "ord", _l3_entity_text),
    ("l4_skill", "l4_skills", "definition", "ord", _l4_skill_text),
    ("l4_archive", "l4_archive", "search_text, definition", "ord", _l4_archive_text),
]


def needs_reembed(store: Store, provider: EmbeddingProvider) -> bool:
    """True when stored vectors were made by a different provider identity."""
    stored = store.get_meta("embedding_fingerprint")
    if not stored:
        return False
    return stored != provider.fingerprint


def reembed(
    store: Store,
    provider: EmbeddingProvider,
    *,
    allow_redimension: bool = False,
    batch: int = 256,
    progress: Callable[[Reprogress], None] | None = None,
) -> ReembedReport:
    """Recompute every stored vector with ``provider``.

    ``allow_redimension=True`` destroys the vector index and rebuilds it at the
    new width (rows are re-embedded, not lost). Without it, a dimension change
    raises: on-disk vec0 tables are fixed-width and silently mixing widths
    would corrupt similarity rather than fail loudly.
    """
    report = ReembedReport(
        previous_fingerprint=store.get_meta("embedding_fingerprint"),
        new_fingerprint=provider.fingerprint,
        previous_dim=store.vectors.dim,
        new_dim=provider.dim,
    )
    if provider.dim != store.vectors.dim:
        if not allow_redimension:
            raise MemoryError(
                f"database holds {store.vectors.dim}-dim vectors, new model produces "
                f"{provider.dim}; pass allow_redimension=True to rebuild the index"
            )
        _rebuild_vector_tables(store, provider.dim)
        report.redimensioned = True

    for kind, table, cols, rowid_col, build_text in _SOURCES:
        rows = store.query(
            f"SELECT {rowid_col} AS rid, {cols} FROM {table}"
        )
        done = 0
        for start in range(0, len(rows), batch):
            chunk = rows[start : start + batch]
            texts = [_text_of(build_text(r)) for r in chunk]
            try:
                vectors = provider.embed(texts)
            except ProviderError as exc:
                report.errors.append(f"{kind}: {exc}")
                break
            with store.transaction():
                for row, vector in zip(chunk, vectors):
                    store.vectors.upsert(kind, int(row["rid"]), vector)
            done += len(chunk)
            if progress is not None:
                progress(Reprogress(kind=kind, done=done, total=len(rows)))
        report.reembedded[kind] = done

    # The fingerprint is the *claim* that every stored vector lives in the new
    # model's space. After a partial failure that claim is false on disk, and
    # writing it would silence `needs_reembed()` forever — the exact silent
    # similarity distortion DESIGN §6.1 warns about. Leave it unclaimed so a
    # retry finishes the job; the dim stays claimed because the physical index
    # was rebuilt (or unchanged), which VectorIndex reflects one way or the other.
    if not report.errors:
        store.set_meta("embedding_fingerprint", provider.fingerprint)
    store.set_meta("embedding_dim", str(provider.dim))
    return report


def _text_of(value: object) -> str:
    return value if isinstance(value, str) else ("" if value is None else str(value))


def _rebuild_vector_tables(store: Store, dim: int) -> None:
    """Drop and recreate every vector table at a new width."""
    from .vectors import VectorIndex

    backend = store.vectors.backend
    with store.transaction():
        for table in VEC_TABLES.values():
            store.execute(f"DROP TABLE IF EXISTS {table}")
        store.execute("DELETE FROM meta WHERE key = 'embedding_dim'")
    store.vectors = VectorIndex(store.conn, dim, enabled=backend == "sqlite-vec")