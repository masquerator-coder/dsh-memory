"""Embedding cache: bounded LRU over the provider.

Every L2 write, every L3 entity create, and every search embeds text. The same
short strings recur constantly (entity names, skill descriptions, repeated
queries), so a small in-process LRU removes most provider calls without any
correctness risk: embeddings are deterministic per provider fingerprint.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Sequence

from .embedding import EmbeddingProvider, Vector


class EmbeddingCache:
    """LRU cache in front of an :class:`EmbeddingProvider`."""

    def __init__(self, provider: EmbeddingProvider, *, max_entries: int = 4096) -> None:
        self.provider = provider
        self.max_entries = max_entries
        self._data: OrderedDict[str, Vector] = OrderedDict()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    @property
    def dim(self) -> int:
        return self.provider.dim

    @property
    def fingerprint(self) -> str:
        return self.provider.fingerprint

    def embed_one(self, text: str) -> Vector:
        key = text or ""
        with self._lock:
            cached = self._data.get(key)
            if cached is not None:
                self._data.move_to_end(key)
                self.hits += 1
                return list(cached)
            self.misses += 1
        vector = self.provider.embed_one(text)
        with self._lock:
            self._store(key, vector)
        return vector

    def embed(self, texts: Sequence[str]) -> list[Vector]:
        keys = [t or "" for t in texts]
        out: list[Vector | None] = [None] * len(keys)
        missing: list[str] = []
        missing_positions: list[int] = []
        with self._lock:
            for i, key in enumerate(keys):
                cached = self._data.get(key)
                if cached is not None:
                    self._data.move_to_end(key)
                    self.hits += 1
                    out[i] = list(cached)
                else:
                    missing.append(key)
                    missing_positions.append(i)
        if missing:
            self.misses += len(missing)
            vectors = self.provider.embed(missing)
            with self._lock:
                for pos, key, vector in zip(missing_positions, missing, vectors):
                    out[pos] = vector
                    self._store(key, vector)
        return [v if v is not None else [] for v in out]

    def _store(self, key: str, vector: Sequence[float]) -> None:
        self._data[key] = list(vector)
        self._data.move_to_end(key)
        while len(self._data) > self.max_entries:
            self._data.popitem(last=False)

    def stats(self) -> dict[str, int]:
        return {"entries": len(self._data), "hits": self.hits, "misses": self.misses}