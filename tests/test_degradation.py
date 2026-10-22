"""Degradation and first-call behaviour.

An embedded agent cannot afford a 400 ms surprise on the first recall of a
session, and the system must keep working when sqlite-vec is unavailable.
"""

from __future__ import annotations

import time

import pytest

from memory_system import FactInput, MemoryConfig, MemorySystem, SkillDefinition, Step
from memory_system.text import prewarm, tokenize


def test_prewarm_makes_first_tokenize_cheap():
    prewarm()
    started = time.perf_counter()
    tokens = tokenize("记忆系统 依赖 关系 svc-3")
    elapsed = (time.perf_counter() - started) * 1000
    assert tokens
    # Without prewarm the first call costs ~300 ms building jieba's dictionary.
    assert elapsed < 50


def test_facade_prewarms_on_open():
    system = MemorySystem(MemoryConfig())
    try:
        assert system.tokenizer_ready is True
        started = time.perf_counter()
        tokenize("记忆系统")
        assert (time.perf_counter() - started) * 1000 < 50
    finally:
        system.close()


def test_exact_scan_fallback(monkeypatch):
    from memory_system.vectors import VectorIndex

    monkeypatch.setattr(
        VectorIndex, "_try_sqlite_vec", lambda self: setattr(self, "_load_error", "simulated missing")
    )
    system = MemorySystem(MemoryConfig())
    try:
        assert system.store.vectors.backend == "exact"
        system.ensure_project("fb")
        system.remember(
            project_id="fb", summary="sqlite fallback recall test",
            facts=[{"head": "a", "relation": "uses", "tail": "b"}],
        )
        result = system.recall("sqlite fallback recall", project_id="fb")
        assert len(result.episodes) == 1
        assert len(result.facts) == 1
        definition = SkillDefinition(
            title="t", description="d", when_to_use="w", intent_labels=["x"], triggers=["x"],
            steps=[Step(action="a", tool="run_terminal"), Step(action="b", tool="run_terminal")],
            success_criteria="ok",
        )
        system.add_skill(project_id="fb", definition=definition, name="fb-skill")
        matches = system.skills.match(
            view=system.view("fb"), user_text="x", intent_labels=["x"]
        )
        assert [m.skill.name for m in matches] == ["fb-skill"]
        assert system.archive.search("d")
    finally:
        system.close()


def test_match_issues_one_vector_query(memory: MemorySystem, project: str):
    """Scoring must not scale its index queries with the number of skills."""
    for i in range(40):
        memory.add_skill(
            project_id=project,
            definition=SkillDefinition(
                title=f"技能 {i}", description=f"处理第 {i} 类任务", when_to_use="处理任务时",
                intent_labels=[f"task-{i}"], triggers=[f"任务{i}"],
                requires_tools=["run_terminal"],
                steps=[Step(action="一", tool="run_terminal"), Step(action="二", tool="run_terminal")],
                success_criteria="完成",
            ),
            name=f"skill-{i}",
        )
    calls = {"n": 0}
    original = memory.store.vectors.knn

    def counting(*args, **kwargs):
        calls["n"] += 1
        return original(*args, **kwargs)

    memory.store.vectors.knn = counting
    memory.skills.match(view=memory.view(project), user_text="帮我处理任务3 任务4",
                        context=_ctx(tools=("run_terminal",)))
    # One query for semantic scores; the count must not track the 40 candidates.
    assert calls["n"] <= 3


def _ctx(tools=(), entities=(), environment=None):
    from memory_system import SkillContext

    return SkillContext(
        tools=frozenset(tools), entities=frozenset(entities), environment=dict(environment or {})
    )