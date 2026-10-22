"""Embedding providers.

The memory system treats embeddings as an *injected capability*: L2 scores
retention with ``cosine_similarity``, L3 seeds graph traversal from the vector
nearest-neighbours, and L4 ranks skills semantically. Any backend that can
return fixed-length vectors satisfies the contract; the system never assumes
vectors are semantically perfect, it only assumes they are consistent.

Contract:

* ``dim`` is fixed for the lifetime of a database. Changing it is a migration,
  not a config tweak. The actual dimension is stored in ``meta`` and a mismatch
  raises on open.
* ``embed`` is deterministic for the same text and provider identity. Cache
  keys include ``fingerprint`` so switching providers invalidates vectors
  instead of silently comparing incomparable spaces.
* ``embed`` is called with batches; a batch failure must raise rather than
  return partial results.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import socket
import urllib.error
import urllib.request
import zlib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from time import perf_counter
from typing import Callable, Iterable, Sequence

from .config import EmbeddingConfig
from .errors import ProviderError
from .text import is_han, tokenize

Vector = list[float]


def _l2_normalize(vec: Vector) -> Vector:
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0.0:
        return vec
    inv = 1.0 / norm
    return [x * inv for x in vec]


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity clamped to [-1, 1]; 0.0 for a zero vector."""
    if len(a) != len(b):
        raise ProviderError(f"dimension mismatch: {len(a)} vs {len(b)}")
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return max(-1.0, min(1.0, dot / math.sqrt(na * nb)))


class EmbeddingProvider(ABC):
    """Base class; subclasses implement ``_embed_batch``."""

    name: str = "base"

    def __init__(self, dim: int, normalize: bool = True) -> None:
        if dim <= 0:
            raise ValueError("dim must be positive")
        self.dim = dim
        self.normalize = normalize

    @property
    def fingerprint(self) -> str:
        """Identity of the vector space; changing it invalidates stored vectors."""
        return f"{self.name}:{self.dim}:{self.normalize}"

    def embed(self, texts: Sequence[str]) -> list[Vector]:
        if not texts:
            return []
        vectors = self._embed_batch(list(texts))
        if len(vectors) != len(texts):
            raise ProviderError(
                f"{self.name} returned {len(vectors)} vectors for {len(texts)} texts"
            )
        out: list[Vector] = []
        for vec in vectors:
            if len(vec) != self.dim:
                raise ProviderError(f"{self.name} returned dim {len(vec)}, expected {self.dim}")
            out.append(_l2_normalize(vec) if self.normalize else vec)
        return out

    def embed_one(self, text: str) -> Vector:
        return self.embed([text])[0]

    @abstractmethod
    def _embed_batch(self, texts: list[str]) -> list[Vector]: ...


class HashEmbedding(EmbeddingProvider):
    """Dependency-free feature hashing over character n-grams and words.

    Properties that matter for a memory system under test:

    * deterministic across processes (``zlib.crc32``, not ``hash()``);
    * zero cost to start, no model download;
    * captures lexical overlap — which is *not* the same as semantic
      similarity. Two paraphrases with no shared terms score ~0.

    Choose a real model via :class:`HttpEmbedding` for production.
    """

    name = "hash"

    _LATIN_RE = re.compile(r"[a-z0-9_]+")

    def __init__(self, dim: int = 256, ngram: Iterable[int] = (1, 2, 3), normalize: bool = True):
        super().__init__(dim, normalize)
        self.ngram = tuple(int(n) for n in ngram if int(n) > 0) or (1, 2, 3)

    def _features(self, text: str) -> list[tuple[str, float]]:
        features: list[tuple[str, float]] = []
        words = self._LATIN_RE.findall(text.lower())
        for w in words:
            features.append((f"w:{w}", 1.0))
            for n in self.ngram:
                if len(w) > n:
                    for i in range(len(w) - n + 1):
                        features.append((f"c:{w[i:i + n]}", 0.35))
        for term in tokenize(text, tokenizer="unicode"):
            if any(is_han(c) for c in term):
                features.append((f"h:{term}", 0.8))
        # CJK character n-grams over the raw text, so an unsegmented run still
        # yields a gradient when terms do not align.
        han_run = "".join(c for c in text if is_han(c))
        for n in (2, 3):
            if len(han_run) >= n:
                step = 1 if n == 2 else 2
                for i in range(0, len(han_run) - n + 1, step):
                    features.append((f"n{n}:{han_run[i:i + n]}", 0.3))
        return features

    def _embed_batch(self, texts: list[str]) -> list[Vector]:
        out: list[Vector] = []
        for text in texts:
            vec = [0.0] * self.dim
            for feature, weight in self._features(text):
                h = zlib.crc32(feature.encode("utf-8"))
                idx = h % self.dim
                sign = 1.0 if (h >> 16) & 1 else -1.0
                vec[idx] += sign * weight
            out.append(vec)
        return out


class CallableEmbedding(EmbeddingProvider):
    """Adapter for an in-process embedding function (e.g. a local model)."""

    name = "callable"

    def __init__(self, fn: Callable[[list[str]], Sequence[Sequence[float]]], dim: int,
                 identity: str = "callable", normalize: bool = True):
        super().__init__(dim, normalize)
        self._fn = fn
        self._identity = identity

    @property
    def fingerprint(self) -> str:
        return f"callable:{self._identity}:{self.dim}:{self.normalize}"

    def _embed_batch(self, texts: list[str]) -> list[Vector]:
        try:
            return [list(map(float, v)) for v in self._fn(texts)]
        except Exception as exc:  # noqa: BLE001 - re-raised as ProviderError
            raise ProviderError(f"callable embedding failed: {exc}") from exc


class HttpEmbedding(EmbeddingProvider):
    """OpenAI-compatible ``POST /v1/embeddings`` client (stdlib only).

    Works with any server that accepts ``{"model": ..., "input": [...]}`` and
    returns ``{"data": [{"embedding": [...], "index": 0}, ...]}``.
    """

    name = "http"

    def __init__(self, url: str, model: str, dim: int, api_key: str | None = None,
                 timeout_s: float = 20.0, batch: int = 64, normalize: bool = True):
        super().__init__(dim, normalize)
        self.url = url
        self.model = model
        self.api_key = api_key
        self.timeout_s = timeout_s
        self.batch = max(1, batch)

    @property
    def fingerprint(self) -> str:
        return f"http:{self.model}:{self.dim}:{self.normalize}"

    def _embed_batch(self, texts: list[str]) -> list[Vector]:
        out: list[Vector] = []
        for start in range(0, len(texts), self.batch):
            chunk = texts[start : start + self.batch]
            payload = json.dumps({"model": self.model, "input": chunk}).encode("utf-8")
            headers = {"Content-Type": "application/json"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
            req = urllib.request.Request(self.url, data=payload, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:  # pragma: no cover - network
                detail = exc.read().decode("utf-8", "replace")[:400]
                raise ProviderError(f"embedding HTTP {exc.code}: {detail}") from exc
            except Exception as exc:  # pragma: no cover - network
                raise ProviderError(f"embedding request failed: {exc}") from exc
            data = body.get("data") or []
            data.sort(key=lambda item: item.get("index", 0))
            if len(data) != len(chunk):
                raise ProviderError(f"embedding server returned {len(data)} of {len(chunk)}")
            out.extend([float(x) for x in item["embedding"]] for item in data)
        return out


def _short(exc: object, limit: int = 240) -> str:
    text = str(exc)
    return text if len(text) <= limit else text[:limit] + "…"


@dataclass(slots=True)
class ProbeResult:
    """Outcome of a startup connectivity/dimension check."""

    ok: bool
    provider: str
    dim: int | None = None
    latency_ms: float = 0.0
    error: str | None = None
    degraded: bool = False

    def describe(self) -> str:
        if self.ok:
            return f"{self.provider} dim={self.dim} ({self.latency_ms:.0f} ms)"
        if self.degraded:
            return f"{self.provider} unavailable ({self.error}); degraded to hash embeddings"
        return f"{self.provider} unavailable: {self.error}"


_PROBE_CONNECT_TIMEOUT_S = 0.75


def _reachable(url: str, timeout_s: float) -> str | None:
    """Fast TCP reachability check. Returns an error string when unreachable.

    ``urllib`` is unusable on the open path: it tries every resolved address
    family in turn and its ``timeout`` applies per attempt, so a refused or
    firewalled host costs seconds before the real request is even attempted.

    This does one bounded connect per resolved address under a single shared
    deadline, so the total cost is capped regardless of how many families the
    name resolves to. A host that cannot accept a TCP connection in this budget
    is treated as unavailable — on the open path, "maybe it would work" is not
    a useful answer.
    """
    from time import monotonic
    from urllib.parse import urlparse

    parsed = urlparse(url)
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if not host:
        return f"invalid embedding url: {url!r}"
    budget = min(timeout_s, _PROBE_CONNECT_TIMEOUT_S)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        return f"cannot resolve {host} — {exc}"
    deadline = monotonic() + budget
    last: OSError | None = None
    for family, socktype, proto, _canon, addr in infos:
        remaining = deadline - monotonic()
        if remaining <= 0:
            break
        sock = socket.socket(family, socktype, proto)
        try:
            sock.settimeout(remaining)
            sock.connect(addr)
            return None
        except OSError as exc:
            last = exc
        finally:
            sock.close()
    return f"cannot reach {host}:{port} within {budget:.2f}s ({last})"


def probe_provider(provider: EmbeddingProvider, *, timeout_s: float = 2.0) -> ProbeResult:
    """Embed one short string to prove the endpoint works and the dim agrees.

    A misconfigured endpoint that only fails on the first real memory write is
    the worst failure mode for a memory system: the agent silently loses
    memories. This makes that failure explicit and early.

    Runs on the open path, so it is bounded twice: a hard TCP reachability
    check first, then one real request with a clamped timeout. A slow endpoint
    that misses the budget is reported unavailable — the honest answer, since
    the system cannot know it would have worked.
    """
    started = perf_counter()
    url = getattr(provider, "url", None)
    if isinstance(url, str):
        unreachable = _reachable(url, timeout_s)
        if unreachable is not None:
            return ProbeResult(ok=False, provider=provider.name, error=_short(unreachable))
    original_timeout = getattr(provider, "timeout_s", None)
    if original_timeout is not None:
        provider.timeout_s = min(original_timeout, timeout_s)
    try:
        vector = provider.embed_one("probe")
    except ProviderError as exc:
        return ProbeResult(ok=False, provider=provider.name, error=_short(exc))
    except Exception as exc:  # noqa: BLE001 - surface anything as a probe failure
        return ProbeResult(ok=False, provider=provider.name, error=_short(f"{type(exc).__name__}: {exc}"))
    finally:
        if original_timeout is not None:
            provider.timeout_s = original_timeout
    elapsed = (perf_counter() - started) * 1000
    if len(vector) != provider.dim:
        return ProbeResult(
            ok=False,
            provider=provider.name,
            dim=len(vector),
            error=f"server returned dim {len(vector)}, configured {provider.dim}",
        )
    if not any(vector):
        return ProbeResult(ok=False, provider=provider.name, dim=len(vector),
                           error="server returned an all-zero vector")
    return ProbeResult(ok=True, provider=provider.name, dim=len(vector), latency_ms=elapsed)


def build_provider(config: EmbeddingConfig) -> EmbeddingProvider:
    """Construct the provider described by ``config``."""
    config = config.with_preset()
    if config.provider == "hash":
        return HashEmbedding(config.dim, config.hash_ngram, config.normalize)
    if config.provider == "http":
        if not config.http_url or not config.http_model:
            raise ProviderError("embedding.provider='http' requires http_url and http_model")
        return HttpEmbedding(
            url=config.http_url,
            model=config.http_model,
            dim=config.dim,
            api_key=config.http_api_key,
            timeout_s=config.http_timeout_s,
            batch=config.http_batch,
            normalize=config.normalize,
        )
    if config.provider == "callable":
        raise ProviderError("provider='callable' requires MemoryStore(embedding=<provider>)")
    raise ProviderError(f"unknown embedding provider: {config.provider}")


class DegradedProvider(EmbeddingProvider):
    """A provider whose endpoint failed its startup probe.

    Every call raises :class:`ProviderError` with an actionable message rather
    than a socket traceback. This exists so the *warn* policy is honest: the
    system opened, but it cannot write memories, and the user must be told why
    instead of discovering it when a memory silently fails to persist.
    """

    name = "degraded"

    def __init__(self, dim: int, *, reason: str, normalize: bool = True) -> None:
        super().__init__(dim, normalize)
        self.reason = reason

    @property
    def fingerprint(self) -> str:
        return f"degraded:{self.dim}"

    def _embed_batch(self, texts: list[str]) -> list[Vector]:
        raise ProviderError(
            "embedding endpoint is unavailable, so memory writes cannot be "
            f"embedded and are NOT being stored. Fix the endpoint or set "
            f"embedding.on_unavailable='fallback' on a fresh database. Cause: {self.reason}"
        )


def build_checked_provider(config: EmbeddingConfig) -> tuple[EmbeddingProvider, ProbeResult]:
    """Build the provider and verify it, honouring ``on_unavailable``."""
    config = config.with_preset()
    provider = build_provider(config)
    if provider.name == "hash":
        return provider, ProbeResult(ok=True, provider=provider.name, dim=provider.dim)
    result = probe_provider(provider, timeout_s=min(config.http_timeout_s, 10.0))
    if result.ok:
        return provider, result
    if config.on_unavailable == "raise":
        raise ProviderError(f"embedding endpoint unavailable: {result.error}")
    if config.on_unavailable == "fallback":
        result.degraded = True
        # 256-dim hash vectors are a distinct space. `MemorySystem` refuses this
        # degradation on a database that already has vectors, so the width here
        # only ever applies to a fresh store that will be written in this space.
        return HashEmbedding(256, (1, 2, 3), config.normalize), result
    return DegradedProvider(provider.dim, reason=result.error or "probe failed",
                            normalize=config.normalize), result


def text_hash(text: str) -> str:
    """Stable cache key for an input text."""
    return hashlib.sha1(text.encode("utf-8")).hexdigest()