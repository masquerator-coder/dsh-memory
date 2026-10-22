"""L2 episodic memory: decay math, states, dedup, project isolation."""

from __future__ import annotations

import datetime as dt
import math

from memory_system import MemorySystem
from memory_system.storage import to_iso, utcnow


def test_ebbinghaus_curve_matches_formula(memory: MemorySystem, project: str):
    episode = memory.l2.add(project_id=project, summary="A moderately important event", importance=0.9)
    now = utcnow()
    retention = memory.l2.compute(episode, now + dt.timedelta(hours=24))
    # S = 24h * 0.9 * (1 + 0.5*ln 1) = 21.6h; R(24h) = exp(-24/21.6)
    assert retention.stability_hours == pytest_approx(21.6)
    assert retention.retention == pytest_approx(math.exp(-24 / 21.6))


def test_access_reinforcement_extends_stability(memory: MemorySystem, project: str):
    episode = memory.l2.add(project_id=project, summary="Reinforceable event", importance=0.6)
    before = memory.l2.compute(episode).stability_hours
    memory.l2.reinforce([episode.memory_id], amount=5)
    after = memory.l2.compute(memory.l2.get(episode.memory_id)).stability_hours
    assert after > before


def test_state_transitions_are_monotone_and_never_delete(memory: MemorySystem, project: str):
    episode = memory.l2.add(project_id=project, summary="Will fade away", importance=0.2)
    now = utcnow()
    states = [
        memory.l2.compute(episode, now + dt.timedelta(hours=h)).state
        for h in (0, 24, 200)
    ]
    assert states[0] == "active"
    assert states[-1] == "archived"
    # Archived memories still exist and are retrievable on request.
    assert memory.l2.get(episode.memory_id).memory_id == episode.memory_id


def test_refresh_states_updates_only_what_changed(memory: MemorySystem, project: str):
    fresh = memory.l2.add(project_id=project, summary="Fresh item", importance=0.9)
    stale = memory.l2.add(project_id=project, summary="Stale item", importance=0.3)
    old = to_iso(utcnow() - dt.timedelta(hours=2000))
    memory.store.execute("UPDATE l2_episodes SET last_access = ?, created_at = ? WHERE memory_id = ?",
                         (old, old, stale.memory_id))
    report = memory.l2.refresh_states()
    assert report["changed"] == 1
    assert memory.l2.get(stale.memory_id).state == "archived"
    assert memory.l2.get(fresh.memory_id).state == "active"


def test_search_ties_prefer_the_newer_memory(memory: MemorySystem, project: str):
    """Equal scores must not rank the oldest memory first."""
    older = memory.l2.add(project_id=project, summary="identical text", importance=0.5)
    newer = memory.l2.add(
        project_id=project, summary="identical text", importance=0.5, dedup=False
    )
    # Give both the same clock reading so only the tie-break decides.
    stamp = to_iso(utcnow())
    memory.store.execute(
        "UPDATE l2_episodes SET created_at = ?, last_access = ? WHERE memory_id IN (?, ?)",
        (stamp, stamp, older.memory_id, newer.memory_id),
    )
    hits = memory.l2.search("identical text", project_ids=[project], reinforce=False)
    ids = [h.episode.memory_id for h in hits]
    assert ids.index(newer.memory_id) < ids.index(older.memory_id)


def test_reinforce_revives_archived_by_retention_not_blindly(memory: MemorySystem, project: str):
    """An archived memory comes back, but into the state its age implies."""
    stale = memory.l2.add(project_id=project, summary="Long forgotten fact", importance=0.2)
    old = to_iso(utcnow() - dt.timedelta(days=400))
    memory.store.execute(
        "UPDATE l2_episodes SET last_access = ?, created_at = ?, state = 'archived' WHERE memory_id = ?",
        (old, old, stale.memory_id),
    )
    memory.l2.reinforce([stale.memory_id])
    revived = memory.l2.get(stale.memory_id)
    # It was accessed just now, so it is live again...
    assert revived.access_count == 1
    # ...and the state agrees with what retention now says.
    assert revived.state == memory.l2.compute(revived).state


def test_dedup_returns_same_memory(memory: MemorySystem, project: str):
    a = memory.l2.add(project_id=project, summary="Same   Text  here", importance=0.5)
    b = memory.l2.add(project_id=project, summary="same text here", importance=0.5)
    assert a.memory_id == b.memory_id


def test_content_key_dedup(memory: MemorySystem, project: str):
    a = memory.l2.add(project_id=project, summary="first phrasing", content_key="k1")
    b = memory.l2.add(project_id=project, summary="totally different words", content_key="k1")
    assert a.memory_id == b.memory_id


def test_search_is_project_scoped(memory: MemorySystem, project: str):
    memory.ensure_project("proj-b")
    memory.l2.add(project_id=project, summary="alpha beta gamma login failure")
    memory.l2.add(project_id="proj-b", summary="alpha beta gamma login failure")
    hits = memory.l2.search("alpha beta gamma login", project_ids=[project], reinforce=False)
    assert len(hits) == 1
    assert hits[0].episode.project_id == project


def test_dormant_hidden_by_default(memory: MemorySystem, project: str):
    # S = 24h * 0.4 = 9.6h; R(24h) = 0.082 -> dormant (0.05 <= R < 0.30).
    episode = memory.l2.add(project_id=project, summary="sqlite vector index decision", importance=0.4)
    old = to_iso(utcnow() - dt.timedelta(hours=24))
    memory.store.execute("UPDATE l2_episodes SET last_access = ?, created_at = ? WHERE memory_id = ?",
                         (old, old, episode.memory_id))
    assert memory.l2.compute(memory.l2.get(episode.memory_id)).state == "dormant"
    hidden = memory.l2.search("sqlite vector index", project_ids=[project], reinforce=False)
    shown = memory.l2.search("sqlite vector index", project_ids=[project], include_dormant=True, reinforce=False)
    assert all(h.episode.memory_id != episode.memory_id for h in hidden)
    assert any(h.episode.memory_id == episode.memory_id for h in shown)


def test_archived_needs_explicit_opt_in(memory: MemorySystem, project: str):
    episode = memory.l2.add(project_id=project, summary="ancient migration note", importance=0.4)
    old = to_iso(utcnow() - dt.timedelta(hours=500))
    memory.store.execute("UPDATE l2_episodes SET last_access = ?, created_at = ? WHERE memory_id = ?",
                         (old, old, episode.memory_id))
    assert memory.l2.compute(memory.l2.get(episode.memory_id)).state == "archived"
    dormant_only = memory.l2.search("ancient migration note", project_ids=[project], include_dormant=True,
                                    reinforce=False)
    assert all(h.episode.memory_id != episode.memory_id for h in dormant_only)
    archived = memory.l2.search("ancient migration note", project_ids=[project], include_dormant=True,
                                include_archived=True, reinforce=False)
    assert any(h.episode.memory_id == episode.memory_id for h in archived)


def test_similarity_floor_excludes_noise(memory: MemorySystem, project: str):
    memory.l2.add(project_id=project, summary="kubernetes deployment rollback procedure")
    hits = memory.l2.search("dragonfruit smoothie recipe", project_ids=[project], reinforce=False)
    assert hits == []


def test_retrieval_reinforces(memory: MemorySystem, project: str):
    episode = memory.l2.add(project_id=project, summary="cache invalidation strategy notes", importance=0.5)
    memory.l2.search("cache invalidation", project_ids=[project])
    assert memory.l2.get(episode.memory_id).access_count == 1


def test_supersede_keeps_history(memory: MemorySystem, project: str):
    old = memory.l2.add(project_id=project, summary="deploy target is staging", importance=0.6)
    new = memory.l2.add(project_id=project, summary="deploy target changed to production", importance=0.6)
    memory.l2.supersede(old.memory_id, new.memory_id)
    assert memory.l2.get(old.memory_id).superseded_by == new.memory_id
    hits = memory.l2.search("deploy target staging", project_ids=[project], reinforce=False)
    assert all(h.episode.memory_id != old.memory_id for h in hits)


def pytest_approx(value: float, rel: float = 1e-6):
    import pytest

    return pytest.approx(value, rel=rel)