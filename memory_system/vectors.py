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

import math
import sqlite3
import struct
from typing import Iterable, Sequence

from .storage import VEC_TABLES

_KIND_FALLBACK_TABLE = "_fallback_vectors"

# sqlite-vec refuses a knn request larger than this
# ("k value in knn query too large, provided N and the limit is 4096"), so the
# over-fetch window in :meth:`VectorIndex.knn` must never ask for more.
MAX_KNN_K = 4096


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
        # A degenerate query is rejected here, for both backends, rather than
        # per backend: the fallback path skips a zero vector (cosine is
        # undefined) while vec0 happily scored it, and vec0's Euclidean content
        # for a zero query is the *stored* norm, which came back as 0.5
        # cosine-distance -- a "half match" against every row. A non-finite
        # component is treated the same way: it would poison the ranking
        # instead of merely being useless, which is what the fallback path also
        # refuses to rank.
        if not all(math.isfinite(x) for x in query) or not any(x != 0.0 for x in query):
            return []
        if self.backend == "sqlite-vec":
            table = VEC_TABLES[kind]
            payload = self._sqlite_vec.serialize_float32(list(query))
            if allowed_rowids is None:
                rows = self.conn.execute(
                    f"SELECT rowid, distance FROM {table} WHERE embedding MATCH ? AND k = ? ORDER BY distance",
                    (payload, k),
                ).fetchall()
                filtered = rows
            else:
                if not allowed_rowids:
                    return []
                # vec0 cannot constrain by an arbitrary rowid set; over-fetch
                # and filter. A starved window must not quietly return fewer
                # than k while allowed candidates still exist deeper in the
                # ranking (scope-restricted recall would otherwise depend on
                # how well-scoped rows rank globally), so widen the window
                # until the fetch is satisfied or the table is exhausted.
                #
                # The window is capped: sqlite-vec rejects ``k > 4096``
                # outright, and since the window only ever holds
                # ``min(fetch, total)`` rows, a request whose allowed set is
                # smaller than k can *never* satisfy ``len(filtered) >= k``.
                # Doubling without a cap then walked 64 -> 128 -> ... -> 5120 on
                # a table with more than 4096 vectors and raised
                # ``OperationalError`` instead of returning the rows it had --
                # a project with a couple of memories stopped being recallable
                # the moment the shared table outgrew 4096 rows. Capping means
                # such a caller gets the allowed rows that exist, which is the
                # honest answer: it asked for k and there are fewer.
                total = self.count(kind)
                if total <= 0:
                    return []
                # The window never needs to exceed the table: one pass over
                # every row already contains any allowed row that exists.
                fetch = min(max(k * 8, 64), total, MAX_KNN_K)
                while True:
                    rows = self.conn.execute(
                        f"SELECT rowid, distance FROM {table} WHERE embedding MATCH ? AND k = ? ORDER BY distance",
                        (payload, fetch),
                    ).fetchall()
                    filtered = [r for r in rows if r["rowid"] in allowed_rowids]
                    if len(filtered) >= k or len(rows) < fetch:
                        break
                    # `fetch >= total` is the termination case the backend
                    # limit guard missed: when the table is smaller than the
                    # backend cap and the scope holds fewer than k rows, the
                    # next window rounds down to `total` — the same value as
                    # this pass. The loop then asked the same question forever
                    # and the write (or recall) never answered. A scope smaller
                    # than k cannot be satisfied, so return what it has.
                    if fetch >= MAX_KNN_K or fetch >= total:
                        break
                    fetch = min(fetch * 2, MAX_KNN_K, total)
                filtered = filtered[:k]
            out: list[tuple[int, float]] = []
            for r in filtered:
                # vec0's default metric is Euclidean. For unit vectors the two
                # are the same ordering — ||a-b||² = 2 - 2·cos — so converting
                # here (cos_dist = ||a-b||²/2) honours the cosine-distance
                # contract every caller builds on (`1.0 - distance`), and the
                # over-fetch window above stays valid. Vectors are normalized
                # at write time by the provider (`normalize=True` default);
                # a provider that disables normalization breaks the geometry
                # on the exact backend too, so this is the shared assumption,
                # not a per-backend one.
                l2 = float(r["distance"])
                out.append((int(r["rowid"]), (l2 * l2) / 2.0))
            return out

        rows = self.conn.execute(
            f"SELECT rowid, embedding FROM {_KIND_FALLBACK_TABLE} WHERE kind = ?", (kind,)
        ).fetchall()
        scored: list[tuple[int, float]] = []
        q = list(query)
        qn = sum(x * x for x in q) ** 0.5
        # `qn == 0` cannot reach here: the entry guard rejects a degenerate
        # query for both backends. Kept as a cheap invariant so a future caller
        # of this branch cannot divide by zero.
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
            if vn == 0.0 or not (qn > 0.0):
                continue
            cos = dot / (qn * (vn**0.5))
            if not math.isfinite(cos):
                # NaN would clamp to 1.0 below — do not rank garbage first.
                continue
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