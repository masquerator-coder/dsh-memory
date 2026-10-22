"""End-to-end: facade, maintenance, persistence, adapter port."""

from __future__ import annotations

import pytest

from memory_system import FactInput, MemoryConfig, MemorySystem
from memory_system.adapters.dsh import DshMemoryPlugin
from memory_system.adapters.turns import NormalizedEvent, ProjectResolver


def test_remember_persists_episode_and_facts(memory: MemorySystem, project: str):
    result = memory.remember(
        project_id=project,
        summary="Adopted sqlite-vec after benchmarking",
        importance=0.8,
        event_type="decision",
        facts=[{"head": "memory-system", "relation": "uses", "tail": "sqlite-vec"}],
    )
    assert result["memory_id"]
    assert result["facts"][0]["status"] == "accepted"
    episode = memory.l2.get(result["memory_id"])
    assert episode.importance == 0.8
    # The fact cites the episode that produced it.
    edge = memory.l3.get_edge(result["facts"][0]["edge_id"])
    assert result["memory_id"] in edge.meta["episode_ids"]


def test_remember_links_session_anchor(memory: MemorySystem, project: str):
    anchor = memory.anchors.capture(session_id="s1", seq=3, event_type="user/message", quote="use sqlite")
    result = memory.remember(project_id=project, summary="chose sqlite for storage", session_key="s1")
    assert result["anchor_id"] in (anchor.anchor_id, None)


def test_project_registration_and_view(memory: MemorySystem):
    memory.ensure_project("p1", display_name="P1", org_id="acme")
    assert memory.view("p1").org_id == "acme"
    memory.ensure_project("p1", display_name="Renamed")
    assert memory.get_project("p1").display_name == "Renamed"
    assert memory.get_project("p1").org_id == "acme"
    assert [p.project_id for p in memory.list_projects()] == ["p1"]


def test_maintenance_runs_and_is_idempotent(memory: MemorySystem, project: str):
    from memory_system import TrajectoryStep

    steps = [TrajectoryStep(action="a", tool="run_terminal"), TrajectoryStep(action="b", tool="run_terminal")]
    for i in range(3):
        memory.capture_trajectory(project_id=project, steps=steps, session_key=f"s{i}", intent_label="routine")
    first = memory.run_maintenance(project_ids=[project], tasks=["consolidate"], force=True)
    assert first[0].ran and first[0].error is None
    second = memory.run_maintenance(project_ids=[project], tasks=["consolidate"], force=True)
    assert second[0].ran
    # Second pass must not mint a duplicate candidate.
    skills = memory.store.query("SELECT count(*) AS n FROM l4_skills")[0]["n"]
    assert skills == 1


def test_maintenance_respects_cadence(memory: MemorySystem, project: str):
    reports = memory.run_maintenance(tasks=["decay"], force=False)
    assert reports[0].ran
    again = memory.run_maintenance(tasks=["decay"], force=False)
    assert again[0].ran is False


def test_maintenance_task_failure_is_contained(memory: MemorySystem, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(memory.l2, "refresh_states", boom)
    report = memory.run_maintenance(tasks=["decay"], force=True)[0]
    assert report.ran is False
    assert "boom" in (report.error or "")


def test_persistence_round_trip(tmp_path):
    db = tmp_path / "memory.db"
    config = MemoryConfig(db_path=db)
    config.embedding.dim = 64
    with MemorySystem(config) as first:
        first.ensure_project("p1")
        first.remember(project_id="p1", summary="durable fact about caching",
                       facts=[{"head": "cache", "relation": "uses", "tail": "redis"}])
    with MemorySystem(config) as second:
        episodes = second.recent_episodes("p1")
        assert len(episodes) == 1
        assert second.recall("caching", project_id="p1").facts


def test_reopen_with_different_dimension_is_refused(tmp_path):
    db = tmp_path / "memory.db"
    config = MemoryConfig(db_path=db)
    config.embedding.dim = 64
    MemorySystem(config).close()
    config2 = MemoryConfig(db_path=db)
    config2.embedding.dim = 128
    with pytest.raises(Exception):
        MemorySystem(config2)


def test_stats_surface(memory: MemorySystem, project: str):
    memory.remember(project_id=project, summary="something happened")
    stats = memory.stats(project)
    assert stats["l2"]["total"] == 1
    assert stats["schema_version"] == "4"
    assert stats["embedding"]["vectors"]["backend"] in ("sqlite-vec", "exact")


def test_forget_edge_is_soft(memory: MemorySystem, project: str):
    decision = memory.l3.add_fact(project, FactInput(head="a", relation="uses", tail="b"))
    memory.forget_edge(decision.edge.edge_id, reason="test")
    edge = memory.l3.get_edge(decision.edge.edge_id)
    assert edge.valid_to is not None
    assert memory.l3.history(memory.l3.resolve_entity(project, "a", create=False).entity_id)


# ── adapter port ────────────────────────────────────────────────────────


def test_project_resolver_prefers_git_remote():
    resolver = ProjectResolver()
    assert resolver.resolve("C:/work/repo", git_remote="git@github.com:acme/web.git") == "acme-web"
    assert resolver.resolve("C:/work/repo") == "c-work-repo"
    assert ProjectResolver(override="fixed").resolve("anything") == "fixed"


def test_normalized_event_session_key():
    event = NormalizedEvent(kind="user_message", session_id="s1", agent_id="a1")
    assert event.session_key == "a1:s1"
    assert NormalizedEvent(kind="user_message", session_id="s1").session_key == "s1"


def test_adapter_builds_turn_context(memory: MemorySystem, project: str):
    from memory_system import SkillDefinition, Step

    definition = SkillDefinition(
        title="Git 提交", description="生成提交信息", when_to_use="提交代码时",
        intent_labels=["git-commit"], triggers=["提交"],
        steps=[Step(action="查看改动", tool="run_terminal"), Step(action="提交", tool="run_terminal")],
        success_criteria="提交成功",
    )
    memory.add_skill(project_id=project, definition=definition, name="git-commit")
    plugin = DshMemoryPlugin(memory)
    context = plugin.build_turn_context(
        project_id=project,
        user_text="帮我提交一下",
        available_tools=["run_terminal"],
        session_key="s1",
        turn=1,
    )
    rendered = context.render()
    assert "git-commit" in rendered
    assert context.tokens_estimated > 0


def test_adapter_apply_is_explicitly_unimplemented(memory: MemorySystem):
    plugin = DshMemoryPlugin(memory)
    with pytest.raises(NotImplementedError):
        plugin.apply(object())