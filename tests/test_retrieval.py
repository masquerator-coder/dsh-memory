"""L3 retrieval: routing, fast/deep paths, fusion, communities."""

from __future__ import annotations

import json

import pytest

from memory_system import FactInput, MemorySystem, SearchOptions
from memory_system.communities import CommunityIndex
from memory_system.retrieval import rrf_fuse, route_query


def build_graph(memory: MemorySystem, project: str) -> None:
    edges = [
        ("billing-service", "depends_on", "payment-gateway"),
        ("billing-service", "uses", "postgres"),
        ("payment-gateway", "depends_on", "bank-api"),
        ("bank-api", "depends_on", "tls-certificate"),
        ("billing-service", "located_in", "eu-west-1"),
        ("billing-service", "owns", "invoice-worker"),
        ("invoice-worker", "uses", "postgres"),
    ]
    for head, relation, tail in edges:
        memory.l3.add_fact(project, FactInput(head=head, relation=relation, tail=tail, confidence=0.8))


@pytest.mark.parametrize(
    ("query", "kind"),
    [
        ("billing-service", "point"),
        ("billing service 和 payment gateway 的关系", "relational"),
        ("总结一下 billing 系统都有哪些组件", "global"),
        ("payment gateway 依赖哪些组件", "relational"),
    ],
)
def test_router_classifies(query: str, kind: str):
    assert route_query(query).kind == kind


def test_router_is_fast_after_warmup():
    route_query("warm up")
    plan = route_query("anything at all")
    assert plan.latency_us < 50_000  # generous for CI; typically < 1 ms


def test_fast_path_returns_connected_facts(memory: MemorySystem, project: str):
    build_graph(memory, project)
    result = memory.recall("billing-service", project_id=project, mode="fast")
    facts = {f"{f.head.name} {f.edge.relation} {f.tail.name}" for f in result.facts}
    assert "billing-service depends_on payment-gateway" in facts
    assert result.degraded is None


def test_recall_is_project_isolated(memory: MemorySystem, project: str):
    build_graph(memory, project)
    memory.ensure_project("proj-b")
    memory.l3.add_fact("proj-b", FactInput(head="billing-service", relation="uses", tail="mysql"))
    result = memory.recall("billing-service postgres mysql", project_id=project, mode="fast")
    tails = {f.tail.name for f in result.facts}
    assert "postgres" in tails
    assert "mysql" not in tails


def test_deep_path_runs_pagerank(memory: MemorySystem, project: str):
    build_graph(memory, project)
    result = memory.recall("how are billing service and tls certificate connected", project_id=project, mode="deep")
    sources = {f.source for f in result.facts}
    assert sources & {"ppr", "rewrite", "vector", "path:1", "path:2"}
    assert result.route.use_deep is True


def test_multi_hop_reaches_distant_node(memory: MemorySystem, project: str):
    build_graph(memory, project)
    result = memory.recall("billing-service", project_id=project, mode="deep")
    all_heads_or_tails = {f.head.name for f in result.facts} | {f.tail.name for f in result.facts}
    assert "tls-certificate" in all_heads_or_tails


def test_rrf_fusion_prefers_agreement():
    class Item:
        def __init__(self, key):
            self.key = key
            self.score = 1.0

    a = [Item("x"), Item("y")]
    b = [Item("y"), Item("z")]
    fused = rrf_fuse([a, b], key=lambda i: i.key)
    assert fused[0].key == "y"


def test_communities_detected_and_searchable(memory: MemorySystem, project: str):
    build_graph(memory, project)
    index = CommunityIndex(memory.store, memory.l3, min_size=2)
    communities = index.rebuild(project)
    assert communities
    result = memory.recall("总结一下 billing 系统都有哪些组件", project_id=project)
    assert result.communities


def test_token_budget_trims_results(memory: MemorySystem, project: str):
    for i in range(40):
        memory.l3.add_fact(project, FactInput(head="hub", relation="related_to", tail=f"leaf-{i}-x"))
    result = memory.retriever.search(
        "hub", SearchOptions(project_ids=[project], k_l3=30, token_budget=40)
    )
    assert result.tokens_estimated <= 40
    # Budget trimming is normal operation, so it is reported on its own field:
    # ``degraded`` stays reserved for actual failures (a broken search path).
    assert result.trimmed
    assert result.degraded is None


def test_empty_query_returns_empty(memory: MemorySystem, project: str):
    result = memory.recall("   ", project_id=project)
    assert result.empty


def test_recall_includes_episodes(memory: MemorySystem, project: str):
    memory.l2.add(project_id=project, summary="billing service retries failed charges three times", importance=0.8)
    result = memory.recall("billing service retries", project_id=project)
    assert result.episodes
    assert "retries" in result.episodes[0].episode.summary


def edge_names(result) -> set[str]:
    return {f"{f.head.name} {f.edge.relation} {f.tail.name}" for f in result.facts}


@pytest.mark.parametrize("mode", ["fast", "deep"])
def test_forgotten_episode_stops_serving_its_facts(memory: MemorySystem, project: str, mode: str):
    """Forget must retire the L3 edges whose only source it archived.

    L2 filters ``meta.forgotten_at`` on its own; the graph reads the edge table
    directly, so without this every fact justified by the forgotten episode
    would keep surfacing in recall.
    """
    from memory_system.summary import MemoryNotepad

    remembered = memory.remember(
        project_id=project,
        summary="billing-service 迁移到 eu-west-1 区域",
        event_type="decision",
        facts=[{"head": "billing-service", "relation": "located_in", "tail": "eu-west-1"}],
    )
    memory_id = remembered["memory_id"]
    assert "billing-service located_in eu-west-1" in edge_names(memory.recall("billing-service", project_id=project, mode=mode))

    notepad = MemoryNotepad(memory)
    notepad.forget(memory_id)
    hidden = memory.recall("billing-service", project_id=project, mode=mode)
    assert memory_id not in [h.episode.memory_id for h in hidden.episodes]
    assert "billing-service located_in eu-west-1" not in edge_names(hidden)

    notepad.restore(memory_id)
    restored = memory.recall("billing-service", project_id=project, mode=mode)
    assert "billing-service located_in eu-west-1" in edge_names(restored)


def test_fact_with_one_live_source_outlives_a_forgotten_one(memory: MemorySystem, project: str):
    """A fact still supported by a visible episode must not be hidden."""
    from memory_system.summary import MemoryNotepad

    first = memory.remember(
        project_id=project,
        summary="billing-service 部署在 postgres 之上",
        facts=[{"head": "billing-service", "relation": "uses", "tail": "postgres"}],
    )
    second = memory.remember(
        project_id=project,
        summary="billing-service 再次确认使用 postgres 数据库",
        facts=[{"head": "billing-service", "relation": "uses", "tail": "postgres"}],
    )
    edge = memory.store.query_one(
        "SELECT edge_id, meta FROM l3_edges WHERE relation = 'uses' AND valid_to IS NULL"
    )
    assert edge is not None
    sources = json.loads(edge["meta"])["episode_ids"]
    assert set(sources) == {first["memory_id"], second["memory_id"]}

    MemoryNotepad(memory).forget(first["memory_id"])
    result = memory.recall("billing-service postgres", project_id=project, mode="fast")
    assert "billing-service uses postgres" in edge_names(result)