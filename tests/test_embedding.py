"""Embedding provider selection, probing, and the degradation policy.

The failure mode that matters: a memory system that silently writes memories
into a vector space nobody else shares. Every path here is designed to fail
loudly or degrade explicitly instead.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from memory_system import (
    EMBEDDING_PRESETS,
    EmbeddingConfig,
    HashEmbedding,
    HttpEmbedding,
    MemoryConfig,
    MemorySystem,
    probe_provider,
)
from memory_system.errors import MemoryError, ProviderError


def _server(dim: int = 1024, behaviour: str = "ok"):
    """A minimal OpenAI-compatible embeddings endpoint."""

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            if behaviour == "500":
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b'{"error":"model not loaded"}')
                return
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            data = []
            for i, text in enumerate(body["input"]):
                vec = [((ord(c) % 17) + 1) * 0.01 for c in text.ljust(dim, "x")[:dim]]
                data.append({"embedding": vec, "index": i})
            payload = json.dumps({"data": data}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}/v1/embeddings"


@pytest.fixture()
def live():
    server, url = _server(1024)
    yield url
    server.shutdown()


@pytest.fixture()
def dead():
    server, url = _server(behaviour="500")
    yield url
    server.shutdown()


def _config(url: str, dim: int = 1024, mode: str = "warn", **kwargs) -> MemoryConfig:
    config = MemoryConfig(db_path=":memory:", **kwargs)
    config.embedding = EmbeddingConfig(
        provider="http", http_url=url, http_model="qwen3-embedding:0.6b",
        dim=dim, on_unavailable=mode,
    )
    return config


# ── presets ─────────────────────────────────────────────────────────────


def test_qwen3_preset_is_the_recommended_default():
    spec = EMBEDDING_PRESETS["qwen3"]
    assert spec["dim"] == 1024
    assert "qwen3-embedding" in spec["model"]
    assert spec["url"].endswith("/v1/embeddings")


def test_preset_expands_config(tmp_path):
    config = MemoryConfig.for_home(tmp_path, embedding_preset="qwen3")
    assert config.embedding.provider == "http"
    assert config.embedding.dim == 1024
    assert config.embedding.http_model == EMBEDDING_PRESETS["qwen3"]["model"]


def test_explicit_values_win_over_preset(tmp_path):
    config = MemoryConfig.for_home(tmp_path, embedding_preset="qwen3")
    config.embedding.http_model = "custom-model"
    assert config.embedding.with_preset().http_model == "custom-model"


def test_unknown_preset_rejected():
    config = EmbeddingConfig(preset="does-not-exist")
    with pytest.raises(ValueError):
        config.with_preset()


# ── probing ─────────────────────────────────────────────────────────────


def test_probe_success(live):
    result = probe_provider(HttpEmbedding(url=live, model="m", dim=1024))
    assert result.ok and result.dim == 1024
    assert "dim=1024" in result.describe()


def test_probe_catches_dimension_mismatch(live):
    result = probe_provider(HttpEmbedding(url=live, model="m", dim=768))
    assert not result.ok
    assert "dim 1024" in (result.error or "")


def test_probe_catches_server_error(dead):
    result = probe_provider(HttpEmbedding(url=dead, model="m", dim=1024))
    assert not result.ok
    assert "HTTP 500" in (result.error or "")


def test_probe_catches_unreachable_endpoint():
    result = probe_provider(HttpEmbedding(url="http://127.0.0.1:1/v1/embeddings", model="m", dim=8,
                                          timeout_s=1.0))
    assert not result.ok and result.error


# ── degradation policy ──────────────────────────────────────────────────


def test_warn_mode_opens_and_reports(live):
    system = MemorySystem(_config(live, dim=768, mode="warn"))
    try:
        assert system.probe.ok is False
        assert system.probe.degraded is False
    finally:
        system.close()


def test_warn_mode_fails_writes_loudly_and_persists_nothing(dead):
    """Opening is not the same as working: writes must say why they failed."""
    system = MemorySystem(_config(dead, mode="warn"))
    try:
        system.ensure_project("p")
        with pytest.raises(ProviderError, match="endpoint is unavailable"):
            system.remember(project_id="p", summary="this must not be half-written")
        assert system.recent_episodes("p") == []
    finally:
        system.close()


def test_raise_mode_refuses(dead):
    with pytest.raises(MemoryError):
        MemorySystem(_config(dead, mode="raise"))


def test_fallback_mode_degrades_on_fresh_db(dead):
    system = MemorySystem(_config(dead, mode="fallback"))
    try:
        assert system.probe.degraded is True
        assert system.embeddings.provider.name == "hash"
        # The vector index must be re-dimensioned to match the hash backend,
        # otherwise every write would fail on a width mismatch.
        assert system.embeddings.dim == system.store.vectors.dim == 256
        system.ensure_project("p")
        system.remember(project_id="p", summary="billing uses postgres",
                        facts=[{"head": "billing", "relation": "uses", "tail": "postgres"}])
        assert system.recall("billing postgres", project_id="p").facts
    finally:
        system.close()


def test_fallback_refused_when_database_has_vectors(tmp_path, dead):
    """Mixng two vector spaces silently is the one unacceptable outcome."""
    first = MemorySystem(MemoryConfig.for_home(tmp_path))
    first.ensure_project("p")
    first.remember(project_id="p", summary="billing uses postgres")
    first.close()

    config = MemoryConfig.for_home(tmp_path)
    config.embedding = EmbeddingConfig(
        provider="http", http_url=dead, http_model="qwen3-embedding:0.6b",
        dim=1024, on_unavailable="fallback",
    )
    with pytest.raises(MemoryError, match="already contains vectors"):
        MemorySystem(config)


# ── migration ───────────────────────────────────────────────────────────


def test_change_embedding_reembeds_in_place(live):
    system = MemorySystem(MemoryConfig(db_path=":memory:"))
    try:
        system.ensure_project("p")
        system.remember(project_id="p", summary="billing uses postgres",
                        facts=[{"head": "billing", "relation": "uses", "tail": "postgres"}])
        old = system.store.get_meta("embedding_fingerprint")

        report = system.change_embedding(
            HttpEmbedding(url=live, model="qwen3-embedding:0.6b", dim=1024),
            allow_redimension=True,
        )
        assert report["redimensioned"] is True
        assert report["errors"] == []
        assert report["reembedded"]["l2"] == 1
        new = system.store.get_meta("embedding_fingerprint")
        assert new != old
        # Content survives the migration.
        assert system.recall("billing postgres", project_id="p").facts
    finally:
        system.close()


class _TripWireEmbedding(HttpEmbedding):
    """Delegate to a working provider but fail the first N embed calls."""

    def __init__(self, failures: int = 1, **kwargs):
        super().__init__(**kwargs)
        self.remaining_failures = failures

    def embed(self, texts):
        if self.remaining_failures > 0:
            self.remaining_failures -= 1
            raise ProviderError("forced outage")
        return super().embed(texts)


def test_partial_reembed_does_not_claim_the_new_fingerprint(live):
    """A failed reembed must not rewrite `embedding_fingerprint`: that meta is
    the claim "every vector now lives in the new space". Claiming it after a
    partial write would keep `needs_reembed()` False forever and leave a
    permanently mixed vector space (DESIGN §6.1)."""
    from memory_system.migrate import needs_reembed

    config = MemoryConfig(db_path=":memory:")
    system = MemorySystem(config)
    try:
        system.ensure_project("p")
        system.remember(project_id="p", summary="something durable")
        old = system.store.get_meta("embedding_fingerprint")

        broken = _TripWireEmbedding(url=live, model="m", dim=1024)
        report = system.change_embedding(broken, allow_redimension=True)
        assert report["errors"] == ["l2: forced outage"]
        # The old fingerprint survives: the space on disk is still NOT fully
        # the new one, and the claim must stay re-embeddable.
        assert system.store.get_meta("embedding_fingerprint") == old
        assert needs_reembed(system.store, broken) is True
        assert "run again" in report["warning"]

        healthy = _TripWireEmbedding(url=live, model="m", dim=1024, failures=0)
        rerun = system.change_embedding(healthy, allow_redimension=True)
        assert rerun["errors"] == []
        assert system.store.get_meta("embedding_fingerprint") == healthy.fingerprint
        assert needs_reembed(system.store, healthy) is False
    finally:
        system.close()


def test_redimension_requires_explicit_consent(live):
    system = MemorySystem(MemoryConfig(db_path=":memory:"))
    try:
        system.ensure_project("p")
        with pytest.raises(MemoryError, match="allow_redimension"):
            system.change_embedding(HttpEmbedding(url=live, model="m", dim=1024))
    finally:
        system.close()


def test_same_dimension_change_needs_no_redimension(live):
    system = MemorySystem(MemoryConfig(db_path=":memory:"))
    try:
        system.ensure_project("p")
        system.remember(project_id="p", summary="something durable")
        report = system.change_embedding(HashEmbedding(256), allow_redimension=False)
        assert report["redimensioned"] is False
        assert report["errors"] == []
    finally:
        system.close()


def test_hash_provider_never_probes():
    """The dependency-free backend cannot fail to connect, so it is never probed."""
    config = MemoryConfig(db_path=":memory:")
    system = MemorySystem(config)
    try:
        assert system.probe.ok is True
        assert system.probe.provider == "hash"
    finally:
        system.close()


def test_provider_error_on_bad_payload():
    provider = HttpEmbedding(url="http://127.0.0.1:1/v1/embeddings", model="m", dim=4, timeout_s=1.0)
    with pytest.raises(ProviderError):
        provider.embed_one("hello")


def test_nonfinite_vectors_rejected_on_write_and_neutral_on_read():
    """A NaN vector from a broken endpoint must fail the write path loudly and
    never rank as a perfect match: NaN clamps to 1.0 similarity (the worst
    lie a memory system can tell)."""
    import math

    from memory_system.embedding import EmbeddingProvider, cosine_similarity
    from memory_system.errors import ProviderError

    class _NanProvider(EmbeddingProvider):
        name = "nan"

        def _embed_batch(self, texts):
            return [[float("nan")] * self.dim for _ in texts]

    # Write path: the provider contract stays "fail loudly".
    provider = _NanProvider(8)
    with pytest.raises(ProviderError, match="non-finite"):
        provider.embed("anything")
    probe = probe_provider(provider)
    assert probe.ok is False
    assert "non-finite" in (probe.error or "")

    # Read-path defence: garbage components can no longer score 1.0.
    assert cosine_similarity([float("nan")] * 8, [float("nan")] * 8) == 0.0
    assert cosine_similarity([1.0, 0.0], [1.0, 0.0]) == 1.0  # real data unchanged


# ── open-path latency ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:1/v1/embeddings",       # nothing listening
        "http://10.255.255.1:11434/v1/embeddings",  # blackholed
        "http://localhost:11434/v1/embeddings",     # resolves to v4 + v6
    ],
)
def test_unreachable_endpoint_does_not_stall_startup(url):
    """A dead endpoint must cost ~1 s, not the urllib default of 5-20 s.

    Regression guard: urllib retries every resolved address family and applies
    its timeout per attempt, which made `MemorySystem()` block for 5-10 s when
    Ollama simply was not running.
    """
    import time

    from memory_system import MemoryConfig

    config = MemoryConfig(db_path=":memory:")
    config.embedding = EmbeddingConfig(
        provider="http", http_url=url, http_model="m", dim=1024, on_unavailable="warn"
    )
    started = time.perf_counter()
    system = MemorySystem(config)
    elapsed = time.perf_counter() - started
    try:
        assert system.probe.ok is False
        assert elapsed < 2.5, f"opening took {elapsed:.1f}s with an unreachable endpoint"
    finally:
        system.close()


def test_reachable_endpoint_still_probes_successfully(live):
    import time

    started = time.perf_counter()
    system = MemorySystem(_config(live))
    elapsed = time.perf_counter() - started
    try:
        assert system.probe.ok is True
        assert elapsed < 2.5
    finally:
        system.close()