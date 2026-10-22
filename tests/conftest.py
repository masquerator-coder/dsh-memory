"""Shared fixtures."""

from __future__ import annotations

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