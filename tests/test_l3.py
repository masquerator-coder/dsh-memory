"""L3 semantic memory: write-time consistency, temporality, epistemics."""

from __future__ import annotations

import pytest

from memory_system import FactInput, MemorySystem
from memory_system.config import RelationTypeSpec


def fact(head, relation, tail, **kwargs) -> FactInput:
    return FactInput(head=head, relation=relation, tail=tail, **kwargs)


def test_unknown_relation_rejected(memory: MemorySystem, project: str):
    decision = memory.l3.add_fact(project, fact("a", "smells_like", "b"))
    assert decision.status == "rejected"
    assert decision.reason == "unknown_relation"


def test_nonfinite_or_unbounded_confidence_is_sanitized(memory: MemorySystem, project: str):
    """Model output can carry NaN (json.loads accepts the JSON5 literal),
    which binds to SQLite as NULL and detonates the NOT NULL constraint
    after both endpoints were materialized; inf poisons comparisons and
    serializes as `Infinity`. Same boundary policy as L2's importance."""
    import math

    nan = memory.l3.add_fact(project, fact("a", "uses", "b", confidence=float("nan")))
    assert nan.status == "accepted"
    assert nan.edge.confidence == 0.8

    inf = memory.l3.add_fact(project, fact("c", "uses", "d", confidence=float("inf")))
    assert inf.status == "accepted"
    assert inf.edge.confidence == 1.0

    huge = memory.l3.add_fact(project, fact("e", "uses", "f", confidence=42.0))
    assert huge.edge.confidence == 1.0

    negative = memory.l3.add_fact(project, fact("g", "uses", "h", confidence=-0.2))
    assert negative.status == "rejected"
    assert negative.reason == "low_confidence"

    # Every stored edge confidence is finite (no NaN/inf reached the table).
    rows = memory.store.query("SELECT confidence FROM l3_edges")
    assert all(math.isfinite(float(r["confidence"])) for r in rows)


def test_dangling_episode_ids_rejected(memory: MemorySystem, project: str):
    """A provenance chain must point at real episodes (DESIGN §3.3): a
    dangling episode id silently weakens every evidence comparison it joins."""
    decision = memory.l3.add_fact(project, fact("a", "uses", "b", episode_ids=["mem_dangling"]))
    assert decision.status == "rejected"
    assert decision.reason == "needs_evidence"
    assert decision.conflict == {"missing_episode_ids": ["mem_dangling"]}


def test_require_evidence_flags_rejects_unproven_assertions(memory: MemorySystem, project: str):
    """Strict hosts can demand provenance: no episode ids at all -> rejected.
    Default stays permissive (hand-written / imported edges carry none)."""
    assert memory.l3.add_fact(project, fact("a", "uses", "b")).status == "accepted"  # default: allowed
    memory.l3.cfg.require_evidence = True
    try:
        decision = memory.l3.add_fact(project, fact("c", "uses", "d"))
        assert decision.status == "rejected"
        assert decision.reason == "needs_evidence"
    finally:
        memory.l3.cfg.require_evidence = False


def test_entity_resolution_is_idempotent(memory: MemorySystem, project: str):
    memory.l3.add_fact(project, fact("API Gateway", "uses", "postgres"))
    memory.l3.add_fact(project, fact("api  gateway", "uses", "redis"))
    entities = memory.entities(project)
    names = sorted(e.name for e in entities)
    assert len([n for n in names if n.lower().replace(" ", "") in ("apigateway", "api gateway")]) <= 1


def test_cardinality_one_closes_previous(memory: MemorySystem, project: str):
    first = memory.l3.add_fact(project, fact("svc", "located_in", "dc1"), recorded_at="2026-01-01T00:00:00+00:00")
    assert first.status == "accepted"
    second = memory.l3.add_fact(project, fact("svc", "located_in", "dc2", confidence=0.95),
                                recorded_at="2026-02-01T00:00:00+00:00")
    assert second.status == "closed"
    assert len(second.closed_edge_ids) == 1
    svc = memory.l3.resolve_entity(project, "svc", create=False)
    current = memory.l3.edges_of(svc.entity_id, relation="located_in")
    assert len(current) == 1
    assert memory.l3.get_entity(current[0].tail_id).name == "dc2"


def test_weaker_evidence_does_not_overwrite(memory: MemorySystem, project: str):
    episode = memory.l2.add(project_id=project, summary="verified in a production incident", importance=0.95)
    strong = memory.l3.add_fact(
        project, fact("svc", "located_in", "dc1", confidence=0.9, episode_ids=[episode.memory_id]),
        recorded_at="2026-01-01T00:00:00+00:00",
    )
    assert strong.status == "accepted"
    weak = memory.l3.add_fact(project, fact("svc", "located_in", "dc2", confidence=0.5),
                              recorded_at="2026-02-01T00:00:00+00:00")
    assert weak.status == "rejected"
    assert weak.reason == "weaker_evidence"
    svc = memory.l3.resolve_entity(project, "svc", create=False)
    current = memory.l3.edges_of(svc.entity_id, relation="located_in")
    assert memory.l3.get_entity(current[0].tail_id).name == "dc1"


def test_dual_temporal_as_of_query(memory: MemorySystem, project: str):
    memory.l3.add_fact(project, fact("svc", "located_in", "dc1", confidence=0.95),
                       recorded_at="2026-01-01T00:00:00+00:00")
    memory.l3.add_fact(project, fact("svc", "located_in", "dc2", confidence=0.99),
                       recorded_at="2026-03-01T00:00:00+00:00")
    svc = memory.l3.resolve_entity(project, "svc", create=False)
    at_feb = memory.l3.edges_of(svc.entity_id, relation="located_in", current_only=False,
                                at="2026-02-15T00:00:00+00:00")
    assert [memory.l3.get_entity(e.tail_id).name for e in at_feb] == ["dc1"]
    now = memory.l3.edges_of(svc.entity_id, relation="located_in", current_only=True)
    assert [memory.l3.get_entity(e.tail_id).name for e in now] == ["dc2"]


def test_reopening_a_closed_triple_snapshots_the_prior_belief(memory: MemorySystem, project: str):
    """The unique-triple index forces a reassert to reuse the old row; the
    closed interval it carried must survive in the `l3_changes` audit."""
    memory.l3.add_fact(project, fact("svc", "located_in", "dc1", confidence=0.9),
                       recorded_at="2026-01-01T00:00:00+00:00")
    closed = memory.l3.add_fact(project, fact("svc", "located_in", "dc2", confidence=0.95),
                                recorded_at="2026-02-01T00:00:00+00:00")
    assert closed.status == "closed"

    # Real-world flow: the replacement is itself withdrawn, then the original
    # fact is re-asserted. No edge between them and the new `at` history must
    # lose the previous interval — it survives in the `l3_changes` audit.
    dc2_id = [e.edge_id for e in
              memory.l3.edges_of(memory.l3.resolve_entity(project, "svc", create=False).entity_id,
                                 relation="located_in", current_only=True)][0]
    memory.l3.close_edge(dc2_id)

    reopened = memory.l3.add_fact(project, fact("svc", "located_in", "dc1", confidence=0.9),
                                  recorded_at="2026-03-01T00:00:00+00:00")
    assert reopened.status == "accepted"
    changes = memory.l3.history(target_id=reopened.edge.edge_id, limit=100)
    arrivals = [
        c for c in changes
        if c["kind"] == "edge.created" and c.get("detail", {}).get("reopened") is True
    ]
    assert arrivals, "the reopen must be audited"
    prior = arrivals[-1]["detail"]["prior"]
    assert prior["valid_to"] is not None  # the closed world-state is preserved
    assert prior["confidence"] == 0.9


def test_cycle_detection_for_acyclic_relations(memory: MemorySystem, project: str):
    assert memory.l3.add_fact(project, fact("a", "depends_on", "b")).status == "accepted"
    assert memory.l3.add_fact(project, fact("b", "depends_on", "c")).status == "accepted"
    cyclic = memory.l3.add_fact(project, fact("c", "depends_on", "a"))
    assert cyclic.status == "rejected"
    assert cyclic.reason == "cycle"


def test_cycle_is_per_relation_not_crossed_between_rels(memory: MemorySystem, project: str):
    """Separate acyclic relations must not merge into one cycle-detection
    adjacency: a mix of is_a/causes/part_of chains is not a cycle in any
    single relation, so writing `part_of` must not be refused."""
    assert memory.l3.add_fact(project, fact("a", "is_a", "b")).status == "accepted"
    assert memory.l3.add_fact(project, fact("b", "causes", "c")).status == "accepted"
    assert memory.l3.add_fact(project, fact("a", "part_of", "c")).status == "accepted"
    # A real cycle within one relation is still caught.
    assert memory.l3.add_fact(project, fact("c", "depends_on", "d")).status == "accepted"
    # A real cycle within one relation is still caught.
    assert memory.l3.add_fact(project, fact("d", "depends_on", "c")).status == "rejected"


def test_self_loop_rejected(memory: MemorySystem, project: str):
    decision = memory.l3.add_fact(project, fact("a", "depends_on", "a"))
    assert decision.status == "rejected"
    assert decision.reason == "cycle"


def test_defer_policy_marks_both_disputed(memory: MemorySystem, project: str):
    memory.l3.add_fact(project, fact("thing", "located_in", "here", conflict_policy="defer"))
    second = memory.l3.add_fact(project, fact("thing", "located_in", "there", conflict_policy="defer"))
    assert second.status == "disputed"
    entity = memory.l3.resolve_entity(project, "thing", create=False)
    edges = memory.l3.edges_of(entity.entity_id, relation="located_in")
    assert len(edges) == 2
    assert all(e.disputed for e in edges)


def test_type_constraint_rejected(memory: MemorySystem, project: str):
    from memory_system.config import RelationTypeSpec

    memory.l3.register_relation(RelationTypeSpec("has_owner", domain=("service",), range=("person",)))
    decision = memory.l3.add_fact(
        project, fact("svc", "has_owner", "bob", head_type="service", tail_type="datastore")
    )
    assert decision.status == "rejected"
    assert decision.reason == "type_constraint"


def test_duplicate_strengthens_confidence(memory: MemorySystem, project: str):
    first = memory.l3.add_fact(project, fact("x", "uses", "y", confidence=0.5))
    # A repeat that brings a *new* observation is real corroboration.
    second = memory.l3.add_fact(
        project, fact("x", "uses", "y", confidence=0.5, observed_context="seen in config")
    )
    assert second.status == "duplicate"
    assert memory.l3.get_edge(first.edge.edge_id).confidence > 0.5


def test_duplicate_without_new_evidence_does_not_ratchet(memory: MemorySystem, project: str):
    """Repeating the same claim with no new evidence must not raise confidence:
    otherwise a hallucinated fact could be talked up to certainty."""
    first = memory.l3.add_fact(project, fact("x", "uses", "y", confidence=0.5))
    for _ in range(5):
        decision = memory.l3.add_fact(project, fact("x", "uses", "y", confidence=0.5))
        assert decision.status == "duplicate"
    assert memory.l3.get_edge(first.edge.edge_id).confidence == 0.5


def test_rejected_fact_leaves_no_orphan_entities(memory: MemorySystem, project: str):
    """Validation runs before persistence, so a refused fact must not add nodes."""
    before = memory.store.scalar("SELECT count(*) FROM l3_entities", default=0)
    decision = memory.l3.add_fact(
        project, fact("a_thing", "depends_on", "b_thing"), recorded_at="2026-01-01T00:00:00+00:00"
    )
    assert decision.status == "accepted"
    memory.l3.add_fact(
        project, fact("b_thing", "depends_on", "c_thing"), recorded_at="2026-01-01T00:00:01+00:00"
    )
    after_ok = memory.store.scalar("SELECT count(*) FROM l3_entities", default=0)
    # Closing the triangle would be a cycle, so the third fact is refused.
    rejected = memory.l3.add_fact(
        project, fact("c_thing", "depends_on", "a_thing"), recorded_at="2026-01-01T00:00:02+00:00"
    )
    assert rejected.status == "rejected"
    assert rejected.reason == "cycle"
    # No new entities appeared for the refused fact.
    assert memory.store.scalar("SELECT count(*) FROM l3_entities", default=0) == after_ok
    assert after_ok == before + 3


def test_history_and_provenance(memory: MemorySystem, project: str):
    episode = memory.l2.add(project_id=project, summary="discovered srv uses redis", importance=0.8)
    memory.l3.add_fact(project, fact("srv", "uses", "redis", episode_ids=[episode.memory_id]))
    srv = memory.l3.resolve_entity(project, "srv", create=False)
    history = memory.l3.history(involved_entity_id=srv.entity_id)
    assert any(h["kind"] == "edge.created" for h in history)
    provenance = memory.l3.provenance(srv.entity_id)
    assert episode.memory_id in provenance["episode_ids"]


def test_explain_walks_three_levels(memory: MemorySystem, project: str):
    anchor = memory.anchors.capture(session_id="s1", seq=5, event_type="user/message", quote="we use redis")
    episode = memory.l2.add(project_id=project, summary="srv uses redis", anchor_id=anchor.anchor_id)
    decision = memory.l3.add_fact(
        project, fact("srv", "uses", "redis", episode_ids=[episode.memory_id], anchor_id=anchor.anchor_id)
    )
    chain = memory.explain(edge_id=decision.edge.edge_id)
    assert chain["kind"] == "edge"
    assert episode.memory_id in chain["episodes"][0].values()
    assert any(a["anchor_id"] == anchor.anchor_id for a in chain["anchors"])


def test_retract_beliefs_from_stale_observation(memory: MemorySystem, project: str):
    memory.l3.register_relation(RelationTypeSpec("requires", cardinality="many"))
    memory.l3.add_fact(
        project,
        fact("deploy", "requires", "kubectl",
             observed_context={"skill": "skill:release", "tools": ["kubectl", "git"]}),
    )
    retracted = memory.l3.retract_dependents("skill:release", ["kubectl"])
    assert len(retracted) == 1
    assert all(not e.is_current for e in memory.edges(project))


def test_retract_leaves_unrelated_beliefs(memory: MemorySystem, project: str):
    memory.l3.register_relation(RelationTypeSpec("requires", cardinality="many"))
    memory.l3.add_fact(
        project, fact("deploy", "requires", "git", observed_context={"skill": "skill:release", "tools": ["git"]})
    )
    assert memory.l3.retract_dependents("skill:release", ["kubectl"]) == []
    assert len(memory.edges(project)) == 1


def test_stats_report_conflict_rate(memory: MemorySystem, project: str):
    episode = memory.l2.add(project_id=project, summary="strong evidence", importance=0.99)
    memory.l3.add_fact(project, fact("s", "located_in", "d1", confidence=0.95, episode_ids=[episode.memory_id]))
    memory.l3.add_fact(project, fact("s", "located_in", "d2", confidence=0.05))
    stats = memory.l3.stats(project)
    assert stats["entities"] >= 2
    # The weaker claim keeps the incumbent: exactly one rejection is recorded,
    # so the rate must be visible rather than merely non-negative.
    assert stats["conflicts"] == 1
    assert stats["conflict_rate"] == pytest.approx(1 / stats["changes"])


def test_stats_count_deferred_disputes_as_conflicts(memory: MemorySystem, project: str):
    memory.l2.add(project_id=project, summary="weighing two claims", importance=0.5)
    memory.l3.cfg.default_conflict_policy = "defer"
    memory.l3.add_fact(project, fact("svc", "located_in", "region-a", confidence=0.9))
    decision = memory.l3.add_fact(project, fact("svc", "located_in", "region-b", confidence=0.8))
    assert decision.status == "disputed"
    stats = memory.l3.stats(project)
    # A deferred dispute records ``edge.disputed`` and no ``edge.rejected``;
    # counting rejections alone reported a conflict-free graph.
    assert stats["edges_disputed"] >= 1
    assert stats["conflicts"] >= 1
    assert stats["conflict_rate"] > 0.0