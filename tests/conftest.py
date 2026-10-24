"""Shared fixtures."""

from __future__ import annotations

from pathlib import Path

import pytest

from memory_system import MemoryConfig, MemorySystem


@pytest.fixture()
def memory() -> MemorySystem:
    """An in-memory system with a small, fast embedding space."""
    config = MemoryConfig()
    config.embedding.dim = 128
    system = MemorySystem(config)
    yield system
    system.close()


@pytest.fixture()
def project(memory: MemorySystem) -> str:
    memory.ensure_project("proj-a", display_name="Project A", org_id="acme")
    return "proj-a"


@pytest.fixture(autouse=True)
def isolate_default_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep tests out of the developer's real ``~/.dsh/memory``.

    Any test that forgets to pass an explicit ``home`` falls back to
    ``bridge.default_home()``, which then creates a live database under the
    user's home directory. The env overrides it reads run through
    ``monkeypatch`` here, so the worst a forgotten ``home`` can do is use a
    unique per-test scratch directory. Tests that pass an explicit ``home``
    are unaffected.
    """
    monkeypatch.setenv("DSH_MEMORY_HOME", str(tmp_path / "dsh-home"))
    monkeypatch.delenv("DSH_HOME", raising=False)
