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
from .storage import Store, VEC_TABLES


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


# (kind, source table, text expression, rowid column)
_SOURCES = [
    ("l2", "l2_episodes", "summary", "ord"),
    ("l3_entity", "l3_entities", "name || ' ' || aliases", "ord"),
    ("l4_skill", "l4_skills", "definition", "ord"),
    ("l4_archive", "l4_archive", "definition", "ord"),
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

    for kind, table, text_expr, rowid_col in _SOURCES:
        rows = store.query(f"SELECT {rowid_col} AS rid, {text_expr} AS txt FROM {table}")
        done = 0
        for start in range(0, len(rows), batch):
            chunk = rows[start : start + batch]
            texts = [_text_of(r["txt"]) for r in chunk]
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