"""L3 retrieval: routing, fast/deep paths, fusion, communities."""

from __future__ import annotations

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
    assert result.degraded and "budget_trimmed" in result.degraded


def test_empty_query_returns_empty(memory: MemorySystem, project: str):
    result = memory.recall("   ", project_id=project)
    assert result.empty


def test_recall_includes_episodes(memory: MemorySystem, project: str):
    memory.l2.add(project_id=project, summary="billing service retries failed charges three times", importance=0.8)
    result = memory.recall("billing service retries", project_id=project)
    assert result.episodes
    assert "retries" in result.episodes[0].episode.summary