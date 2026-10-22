"""Vector index over SQLite.

Two interchangeable backends with identical semantics:

* ``sqlite-vec`` (``vec0`` virtual tables) — ANN-capable, the intended
  production path;
* exact brute-force cosine scan over rows stored in a plain table — correct,
  and fast enough below ~50k rows. Used automatically when the extension
  cannot be loaded, so the system never hard-depends on a native module.

Both backends are driven through :meth:`VectorIndex.knn`, which returns
``(rowid, distance)`` with **cosine distance** (``1 - cosine_similarity``) so
callers do not branch on backend.
"""

from __future__ import annotations

import sqlite3
import struct
from typing import Iterable, Sequence

from .storage import VEC_TABLES

_KIND_FALLBACK_TABLE = "_fallback_vectors"


def pack_vector(vec: Sequence[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def unpack_vector(blob: bytes) -> list[float]:
    n = len(blob) // 4
    return list(struct.unpack(f"<{n}f", blob))


class VectorIndex:
    """Dimension-fixed vector store keyed by ``rowid`` of the owning layer."""

    def __init__(self, conn: sqlite3.Connection, dim: int, *, enabled: bool = True) -> None:
        self.conn = conn
        self.dim = dim
        self.backend = "none"
        self._load_error: str | None = None
        if enabled:
            self._try_sqlite_vec()
        if self.backend == "none":
            self._init_fallback()
        self._ensure_dim_matches()
        self.warm()

    def warm(self) -> None:
        """Force SQLite to parse the vec0 virtual tables now, not mid-turn.

        The first MATCH against a vec0 table costs ~100-400 ms while SQLite
        loads and registers the module; every later query is sub-millisecond.
        Paying it at open keeps the first recall of a session off the user's
        critical path.
        """
        if self.backend != "sqlite-vec":
            return
        probe = [0.0] * self.dim
        for table in VEC_TABLES.values():
            try:
                self.conn.execute(
                    f"SELECT rowid FROM {table} WHERE embedding MATCH ? AND k = 1",
                    (self._sqlite_vec.serialize_float32(probe),),
                ).fetchall()
            except sqlite3.Error:
                continue

    # ── setup ───────────────────────────────────────────────────────────
    def _try_sqlite_vec(self) -> None:
        try:
            import sqlite_vec  # type: ignore

            self.conn.enable_load_extension(True)
            try:
                sqlite_vec.load(self.conn)
            finally:
                self.conn.enable_load_extension(False)
            self.conn.execute("SELECT vec_version()").fetchone()
            for name in VEC_TABLES.values():
                self.conn.execute(
                    f"CREATE VIRTUAL TABLE IF NOT EXISTS {name} USING vec0(embedding float[{self.dim}])"
                )
            self.backend = "sqlite-vec"
            self._sqlite_vec = sqlite_vec
        except Exception as exc:  # noqa: BLE001 - any load failure degrades
            self._load_error = f"{type(exc).__name__}: {exc}"
            self.backend = "none"

    def _init_fallback(self) -> None:
        self.conn.execute(
            f"CREATE TABLE IF NOT EXISTS {_KIND_FALLBACK_TABLE} ("
            "kind TEXT NOT NULL, rowid INTEGER NOT NULL, embedding BLOB NOT NULL, "
            "PRIMARY KEY(kind, rowid))"
        )
        self.backend = "exact"

    def _ensure_dim_matches(self) -> None:
        row = self.conn.execute("SELECT value FROM meta WHERE key='embedding_dim'").fetchone()
        if row is None:
            self.conn.execute(
                "INSERT INTO meta(key, value) VALUES ('embedding_dim', ?)", (str(self.dim),)
            )
        elif int(row[0]) != self.dim:
            raise RuntimeError(
                f"embedding dimension changed ({row[0]} -> {self.dim}); "
                "re-embedding requires a new database or an explicit migration"
            )

    # ── writes ──────────────────────────────────────────────────────────
    def upsert(self, kind: str, rowid: int, vector: Sequence[float]) -> None:
        _check_dim(vector, self.dim)
        if len(vector) != self.dim:
            raise ValueError("dimension mismatch")
        if self.backend == "sqlite-vec":
            table = VEC_TABLES[kind]
            self.conn.execute(f"DELETE FROM {table} WHERE rowid = ?", (rowid,))
            self.conn.execute(
                f"INSERT INTO {table}(rowid, embedding) VALUES (?, ?)",
                (rowid, self._sqlite_vec.serialize_float32(list(vector))),
            )
        else:
            self.conn.execute(
                f"INSERT OR REPLACE INTO {_KIND_FALLBACK_TABLE}(kind, rowid, embedding) VALUES (?,?,?)",
                (kind, rowid, pack_vector(vector)),
            )

    def delete(self, kind: str, rowid: int) -> None:
        if self.backend == "sqlite-vec":
            self.conn.execute(f"DELETE FROM {VEC_TABLES[kind]} WHERE rowid = ?", (rowid,))
        else:
            self.conn.execute(
                f"DELETE FROM {_KIND_FALLBACK_TABLE} WHERE kind=? AND rowid=?", (kind, rowid)
            )

    def bulk_upsert(self, kind: str, items: Iterable[tuple[int, Sequence[float]]]) -> None:
        for rowid, vec in items:
            self.upsert(kind, rowid, vec)

    # ── reads ───────────────────────────────────────────────────────────
    def knn(
        self,
        kind: str,
        query: Sequence[float],
        k: int = 10,
        *,
        allowed_rowids: set[int] | None = None,
    ) -> list[tuple[int, float]]:
        """Return up to ``k`` ``(rowid, cosine_distance)`` pairs, nearest first.

        ``allowed_rowids`` filters *inside* the backend when it can (pre-filter
        by scope is what keeps cross-project recall from leaking), and is
        applied after scoring on the fallback path.
        """
        if len(query) != self.dim:
            raise ValueError(f"query dim {len(query)} != index dim {self.dim}")
        if k <= 0:
            return []
        if self.backend == "sqlite-vec":
            table = VEC_TABLES[kind]
            payload = self._sqlite_vec.serialize_float32(list(query))
            if allowed_rowids is None:
                rows = self.conn.execute(
                    f"SELECT rowid, distance FROM {table} WHERE embedding MATCH ? AND k = ? ORDER BY distance",
                    (payload, k),
                ).fetchall()
            else:
                if not allowed_rowids:
                    return []
                # vec0 cannot constrain by an arbitrary rowid set; over-fetch and filter.
                rows = self.conn.execute(
                    f"SELECT rowid, distance FROM {table} WHERE embedding MATCH ? AND k = ? ORDER BY distance",
                    (payload, max(k * 8, 64)),
                ).fetchall()
                rows = [r for r in rows if r["rowid"] in allowed_rowids][:k]
            return [(int(r["rowid"]), float(r["distance"])) for r in rows]

        rows = self.conn.execute(
            f"SELECT rowid, embedding FROM {_KIND_FALLBACK_TABLE} WHERE kind = ?", (kind,)
        ).fetchall()
        scored: list[tuple[int, float]] = []
        q = list(query)
        qn = sum(x * x for x in q) ** 0.5
        if qn == 0.0:
            return []
        for row in rows:
            rowid = int(row["rowid"])
            if allowed_rowids is not None and rowid not in allowed_rowids:
                continue
            vec = unpack_vector(row["embedding"])
            dot = 0.0
            vn = 0.0
            for x, y in zip(q, vec):
                dot += x * y
                vn += y * y
            if vn == 0.0:
                continue
            cos = dot / (qn * (vn**0.5))
            scored.append((rowid, 1.0 - max(-1.0, min(1.0, cos))))
        scored.sort(key=lambda pair: pair[1])
        return scored[:k]

    def count(self, kind: str) -> int:
        if self.backend == "sqlite-vec":
            row = self.conn.execute(f"SELECT count(*) FROM {VEC_TABLES[kind]}").fetchone()
        else:
            row = self.conn.execute(
                f"SELECT count(*) FROM {_KIND_FALLBACK_TABLE} WHERE kind = ?", (kind,)
            ).fetchone()
        return int(row[0])

    def health(self) -> dict[str, object]:
        return {
            "backend": self.backend,
            "dim": self.dim,
            "load_error": self._load_error,
            "counts": {kind: self.count(kind) for kind in VEC_TABLES},
        }


def _check_dim(vector: Sequence[float], dim: int) -> None:
    if len(vector) != dim:
        raise ValueError(f"vector dim {len(vector)} != index dim {dim}")