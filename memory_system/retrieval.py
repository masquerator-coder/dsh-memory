"""L2/L3 retrieval: query routing, fast path, deep path, RRF fusion.

Shape of one ``search`` call:

1. **Route** the query with a ~0 ms heuristic classifier
   (``point`` / ``relational`` / ``global`` / ``explicit deep``).
2. **Fast path** always runs: vector seeds -> bounded graph expansion ->
   path scoring -> fusion. Target < 200 ms with a small graph.
3. **Deep path** runs when routed to, or when the fast path is thin: seeded
   Personalized PageRank, community summaries, and bounded iterative rewrites.
4. **Fuse** every ranked list with Reciprocal Rank Fusion. RRF is rank-based,
   so lists whose scores live on different scales (cosine, PPR mass, bm25)
   combine without calibration.

Design decisions worth calling out:

* **PPR instead of BFS for "spreading activation".** The design asks for
  "unexpected associations"; uniform-neighbour expansion mostly returns
  high-degree hubs. Personalized PageRank weights paths by continuation
  probability, so hubs are damped and multi-hop relevance survives. ``alpha``
  is the restart probability.
* **Expansion is type-constrained** by an edge whitelist and a hard hop cap,
  and every expanded node carries the path that reached it so the answer can
  explain itself.
* **Iterative rewriting is local and deterministic**, not a second LLM call.
  Detected evidence gaps become *structured sub-queries* (entity co-mention,
  relation of interest, time window) executed against the same index. This
  costs ~0 tokens and cannot loop; the interface leaves room for an
  ``LLMRewriter`` that a host may inject, but the default system never calls a
  model from inside search.
"""

from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Literal, Sequence

from .config import MemoryConfig
from .embedding import EmbeddingProvider
from .l2 import EpisodeHit, EpisodicMemory
from .l3 import Edge, Entity, SemanticMemory
from .storage import Store, json_loads
from .text import estimate_tokens, fts_match_expression, keywords

Mode = Literal["auto", "fast", "deep"]
QueryKind = Literal["point", "relational", "global", "temporal"]

CJK_RELATIONAL = ("的关系", "什么关系", "之间", "影响", "导致", "依赖", "关联", "为什么", "如何影响")
EN_RELATIONAL = ("relationship", "related", "connect", "why does", "leads to", "causes", "depends on", "between")
GLOBAL_MARKERS = ("总结", "概述", "整体", "汇总", "都有哪些", "全部", "概况", "summary", "overview", "overall", "all of", "in general")
TEMPORAL_MARKERS = ("以前", "之前", "当时", "历史", "曾经", "以前是", "后来", "之前是", "previously", "used to", "before", "earlier", "last year", "on ")


@dataclass(slots=True)
class RoutePlan:
    kind: QueryKind
    use_deep: bool
    reasons: list[str] = field(default_factory=list)
    latency_us: int = 0


def edge_lost_its_sources(edge: Edge, forgotten: set[str]) -> bool:
    """True when every episode citing ``edge`` was user-forgotten.

    An edge with no recorded provenance stays: nothing says a user asked for it
    to go (hand-written or imported edges carry no episodes), and hiding it
    would need a marker that does not exist.
    """
    sources = edge.meta.get("episode_ids") or ()
    return bool(forgotten) and bool(sources) and all(source in forgotten for source in sources)


@dataclass(slots=True)
class SearchOptions:
    project_ids: Sequence[str] = ()
    mode: Mode = "auto"
    k_l2: int = 6
    k_l3: int = 8
    include_dormant: bool = False
    max_hops: int | None = None
    as_of: str | None = None
    token_budget: int = 2000
    explain: bool = False


@dataclass(slots=True)
class FactHit:
    edge: Edge
    head: Entity
    tail: Entity
    score: float
    similarity: float
    path: list[str] = field(default_factory=list)
    source: str = "vector"
    rank: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "edge_id": self.edge.edge_id,
            "fact": f"{self.head.name} --{self.edge.relation}--> {self.tail.name}",
            "head": self.head.name,
            "relation": self.edge.relation,
            "tail": self.tail.name,
            "confidence": round(self.edge.confidence, 3),
            "valid_from": self.edge.valid_from,
            "valid_to": self.edge.valid_to,
            "disputed": self.edge.disputed,
            "score": round(self.score, 4),
            "similarity": round(self.similarity, 4),
            "source": self.source,
            "path": self.path,
            "episode_ids": list(self.edge.meta.get("episode_ids", [])),
            "anchor_id": self.edge.anchor_id,
        }


@dataclass(slots=True)
class CommunityHit:
    community_id: str
    label: str
    summary: str
    size: int
    score: float
    members: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "community_id": self.community_id,
            "label": self.label,
            "summary": self.summary,
            "size": self.size,
            "score": round(self.score, 4),
        }


@dataclass(slots=True)
class SearchResult:
    query: str
    route: RoutePlan
    facts: list[FactHit]
    episodes: list[EpisodeHit]
    communities: list[CommunityHit] = field(default_factory=list)
    paths: list[dict[str, Any]] = field(default_factory=list)
    rewrites: list[str] = field(default_factory=list)
    timings_ms: dict[str, float] = field(default_factory=dict)
    degraded: str | None = None
    # Budget trimming is normal operation, not a fault: keep it out of
    # ``degraded`` so a caller watching that field still sees real failures.
    trimmed: bool = False
    tokens_estimated: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "query": self.query,
            "route": {"kind": self.route.kind, "deep": self.route.use_deep, "reasons": self.route.reasons},
            "facts": [f.to_dict() for f in self.facts],
            "episodes": [e.to_dict() for e in self.episodes],
            "communities": [c.to_dict() for c in self.communities],
            "paths": self.paths,
            "rewrites": self.rewrites,
            "timings_ms": self.timings_ms,
            "degraded": self.degraded,
            "trimmed": self.trimmed,
        }

    @property
    def empty(self) -> bool:
        return not self.facts and not self.episodes and not self.communities


# ── routing ─────────────────────────────────────────────────────────────


def route_query(query: str) -> RoutePlan:
    """~10 µs heuristic router; returns a plan, never raises."""
    started = time.perf_counter()
    text = (query or "").strip().lower()
    reasons: list[str] = []
    kind: QueryKind = "point"
    if any(marker in text for marker in GLOBAL_MARKERS) or text.endswith("有哪些"):
        kind = "global"
        reasons.append("global_marker")
    elif any(marker in text for marker in CJK_RELATIONAL) or any(
        marker in text for marker in EN_RELATIONAL
    ):
        kind = "relational"
        reasons.append("relational_marker")
    if any(marker in text for marker in TEMPORAL_MARKERS):
        reasons.append("temporal_hint")
        if kind == "point":
            kind = "temporal"
    # Long multi-entity questions need more than a point lookup.
    term_count = len(keywords(text, limit=12))
    if kind == "point" and term_count >= 6:
        kind = "relational"
        reasons.append("dense_query")
    plan = RoutePlan(kind=kind, use_deep=(kind in ("relational", "global")))
    plan.latency_us = int((time.perf_counter() - started) * 1_000_000)
    plan.reasons = reasons
    return plan


# ── engine ──────────────────────────────────────────────────────────────


class Retriever:
    """Runs L2 + L3 recall and fuses the answers."""

    def __init__(
        self,
        store: Store,
        config: MemoryConfig,
        embeddings: EmbeddingProvider,
        *,
        episodic: EpisodicMemory,
        semantic: SemanticMemory,
        embedding_cache: Any | None = None,
    ) -> None:
        self.store = store
        self.config = config
        self.cfg = config.l3
        self.embeddings = embeddings
        self.episodic = episodic
        self.semantic = semantic
        self._cache = embedding_cache
        self._tokenizer = config.lexical.tokenizer
        self._adjacency_cache: tuple[tuple, str, dict[str, list[Edge]]] | None = None

    # ══ public ═════════════════════════════════════════════════════════
    def search(self, query: str, options: SearchOptions | None = None) -> SearchResult:
        options = options or SearchOptions()
        query = (query or "").strip()
        project_ids = list(options.project_ids)
        started = time.perf_counter()
        plan = route_query(query)
        if options.mode == "fast":
            plan.use_deep = False
            plan.reasons.append("explicit_fast")
        elif options.mode == "deep":
            plan.use_deep = True
            plan.reasons.append("explicit_deep")
        result = SearchResult(query=query, route=plan, facts=[], episodes=[])
        if not query or not project_ids:
            return result

        # 1. L2 recall always (cheap, and the "what happened" half of recall).
        # ``include_archived`` stays False: a user-archived row must not come
        # back just because the caller widened the decay window.
        t0 = time.perf_counter()
        try:
            result.episodes = self.episodic.search(
                query,
                project_ids=project_ids,
                k=options.k_l2,
                include_dormant=options.include_dormant,
                until=options.as_of,
            )
        except Exception as exc:  # noqa: BLE001 - recall must never break the turn
            result.degraded = f"l2_search_failed: {type(exc).__name__}: {exc}"
            result.episodes = []
        result.timings_ms["l2"] = round((time.perf_counter() - t0) * 1000, 2)

        # 2. L3 fast path
        t0 = time.perf_counter()
        fast_lists: list[list[FactHit]] = []
        try:
            fast_lists.append(self._fast_path(query, project_ids, plan, options))
        except Exception as exc:  # noqa: BLE001
            result.degraded = f"l3_fast_failed: {type(exc).__name__}: {exc}"
        result.timings_ms["l3_fast"] = round((time.perf_counter() - t0) * 1000, 2)

        # 3. Deep path when the route asks for it (or the fast path found little)
        deep_lists: list[list[FactHit]] = []
        community_hits: list[CommunityHit] = []
        thin = not fast_lists or len(fast_lists[0]) < 3
        if plan.use_deep or thin:
            if plan.use_deep is False and thin:
                plan.reasons.append("fast_path_thin")
            t0 = time.perf_counter()
            try:
                deep, communities, rewrites = self._deep_path(query, project_ids, options)
                deep_lists.extend(deep)
                community_hits = communities
                result.rewrites = rewrites
            except Exception as exc:  # noqa: BLE001
                result.degraded = (result.degraded or "") + f" l3_deep_failed: {type(exc).__name__}"
            result.timings_ms["l3_deep"] = round((time.perf_counter() - t0) * 1000, 2)

        # 4. Fuse everything, then cut to budget.
        fused = rrf_fuse(
            [*fast_lists, *deep_lists],
            key=lambda hit: hit.edge.edge_id,
            k=self.cfg.rrf_k,
            weights=[1.0] * len(fast_lists) + [0.8] * len(deep_lists),
        )
        result.facts = fused[: max(options.k_l3, 1)]
        for i, hit in enumerate(result.facts):
            hit.rank = i + 1
        result.communities = sorted(community_hits, key=lambda c: -c.score)[:3]
        if options.explain:
            result.paths = [
                {"edge_id": h.edge.edge_id, "source": h.source, "path": h.path} for h in result.facts
            ]
        result.tokens_estimated = self._estimate_tokens(result)
        self._apply_budget(result, options.token_budget)
        result.timings_ms["total"] = round((time.perf_counter() - started) * 1000, 2)
        return result

    # ══ fast path ══════════════════════════════════════════════════════
    def _fast_path(
        self, query: str, project_ids: Sequence[str], plan: RoutePlan, options: SearchOptions
    ) -> list[FactHit]:
        """Vector seeds -> bounded multi-hop expansion -> path scoring."""
        seeds = self._vector_seeds(query, project_ids, k=self.cfg.fast_seed_k)
        lexical = self._lexical_facts(query, project_ids, limit=self.cfg.fast_seed_k)
        seed_ids = {e.entity_id: sim for e, sim in seeds}
        for entity, sim in lexical:
            seed_ids[entity.entity_id] = max(seed_ids.get(entity.entity_id, 0.0), sim)
        if not seed_ids:
            return []

        max_hops = min(options.max_hops or self.cfg.fast_max_hops, self.cfg.fast_max_hops)
        adjacency = self._adjacency(project_ids, as_of=options.as_of)
        entities = self.semantic.load_entities(project_ids)
        deadline = time.perf_counter() + self.cfg.fast_timeout_ms / 1000.0

        # Precision half: edges incident to the seeds themselves. An edge is
        # scored by how well its *matched endpoint* answers the query, damped
        # when the seed is the head (the relation's direction carries meaning:
        # "what does X depend on" is stronger than "what depends on X").
        hits: dict[str, FactHit] = {}
        for entity_id, sim in seed_ids.items():
            for edge in adjacency.get(entity_id, ()):
                if edge.disputed:
                    continue
                orientation = 1.0 if edge.tail_id == entity_id else 0.85
                seed_score = sim * edge.confidence * orientation
                self._record_fact(hits, edge, entities, seed_score, ["seed"], "vector")

        # Recall half: expand outward, decaying by hop count and edge weight.
        frontier: dict[str, tuple[float, list[str]]] = {
            eid: (sim, [eid]) for eid, sim in seed_ids.items()
        }
        visited = set(seed_ids)
        for hop in range(1, max_hops + 1):
            if time.perf_counter() > deadline:
                break
            if len(visited) > self.cfg.fast_max_nodes:
                break
            next_frontier: dict[str, tuple[float, list[str]]] = {}
            for entity_id, (sim, path) in frontier.items():
                for edge in adjacency.get(entity_id, ()):
                    spec = self.semantic.relation_spec(edge.relation)
                    if not self._edge_traversable(edge.relation, spec):
                        continue
                    weight = spec.weight if spec else 0.5
                    other = edge.tail_id if edge.head_id == entity_id else edge.head_id
                    attained = sim * (self.cfg.fast_hop_decay**hop) * weight
                    if attained < 0.05:
                        continue
                    new_path = [*path, edge.relation]
                    # Path score (design §5.3): confidence * 1/sqrt(depth) * similarity.
                    path_score = edge.confidence * attained / ((hop + 1) ** 0.5)
                    self._record_fact(hits, edge, entities, path_score, new_path, f"path:{hop}")
                    if other not in visited:
                        visited.add(other)
                        best = next_frontier.get(other)
                        if best is None or best[0] < attained:
                            next_frontier[other] = (attained, new_path)
            frontier = next_frontier
            if not frontier:
                break
        out = list(hits.values())
        out.sort(key=lambda h: -h.score)
        return out[: self.cfg.fast_seed_k * 4]

    def _record_fact(
        self,
        hits: dict[str, FactHit],
        edge: Edge,
        entities: dict[str, Entity],
        score: float,
        path: list[str],
        source: str,
    ) -> None:
        """Keep the best-scoring sighting of each edge.

        ``score`` is the caller-computed path/seed score; ``similarity`` stores
        the same number so callers can read one field regardless of source.
        """
        head = entities.get(edge.head_id)
        tail = entities.get(edge.tail_id)
        if head is None or tail is None:
            return
        prev = hits.get(edge.edge_id)
        if prev is not None and prev.score >= score:
            return
        hits[edge.edge_id] = FactHit(
            edge=edge, head=head, tail=tail, score=score, similarity=score,
            path=path, source=source,
        )

    def _adjacency(self, project_ids: Sequence[str], *, as_of: str | None = None) -> dict[str, list[Edge]]:
        """Current-edge adjacency for the given projects, or as-of adjacency.

        Edges justified *only* by user-forgotten episodes are left out: a fact
        whose every source was ``forget()``-ed must stop surfacing here too, or
        the graph would keep serving content L2 already refuses to return.

        ``as_of`` answers "what did we believe at T" and bypasses the cache:
        it reads the validity interval visible at T instead of the current
        one, a different answer by construction.
        """
        if not project_ids:
            return {}
        if as_of is not None:
            edges = self.semantic.load_subgraph(project_ids, current_only=True, at=as_of)[1]
            return self._build_adjacency(edges)
        signature = ",".join(sorted(project_ids))
        # Content-derived, not rowcount-derived: the graph mutates mostly by
        # UPDATE, not INSERT. close/retract flip valid_to (the row leaves the
        # current set), strengthen raises confidence and grows meta, dispute
        # grows meta ($ .disputed) — none change the row count. count, the
        # confidence total and the meta-lineage length together cover all of
        # those; a meta edit of identical length on a confidence-saturated
        # edge is the only blind spot left, and it is accepted (documented
        # residual).
        marks = ",".join("?" * len(project_ids))
        agg = self.store.query_one(
            f"SELECT count(*) AS n, coalesce(total(confidence), 0) AS conf, "
            f"coalesce(sum(length(meta)), 0) AS meta_len "
            f"FROM l3_edges WHERE project_id IN ({marks}) AND valid_to IS NULL",
            list(project_ids),
        )
        stamp = (agg["n"], agg["conf"], agg["meta_len"])
        # A forget/restore flips a source's visibility without adding an edge,
        # so edge content alone cannot invalidate the cache.
        forgotten_at_stamp = int(
            self.store.scalar(
                "SELECT count(*) FROM l2_episodes WHERE json_extract(meta, '$.forgotten_at') IS NOT NULL",
                default=0,
            )
        )
        stamp = (*stamp, forgotten_at_stamp)
        cache = self._adjacency_cache
        if cache is not None and cache[0] == stamp and cache[1] == signature:
            return cache[2]
        _, edges = self.semantic.load_subgraph(project_ids, current_only=True)
        adjacency = self._build_adjacency(edges)
        self._adjacency_cache = (stamp, signature, adjacency)
        return adjacency

    def _build_adjacency(self, edges: list[Edge]) -> dict[str, list[Edge]]:
        """Shared adjacency construction: drop lost-source edges, index both ends."""
        forgotten = set(self.episodic._forgotten_ids(itertools.chain.from_iterable(
            edge.meta.get("episode_ids") or () for edge in edges
        )))
        adjacency: dict[str, list[Edge]] = {}
        for edge in edges:
            if edge_lost_its_sources(edge, forgotten):
                continue
            adjacency.setdefault(edge.head_id, []).append(edge)
            adjacency.setdefault(edge.tail_id, []).append(edge)
        return adjacency

    def _visible_edges(self, edges: Iterable[Edge]) -> list[Edge]:
        """Drop edges whose every citing episode the user asked to forget.

        ``SemanticMemory.neighbors`` reads the table directly, so the deep path
        and the rewrite probe bypass :meth:`_adjacency`; this is the one place
        that keeps them consistent with it.
        """
        edges = list(edges)
        if not edges:
            return edges
        forgotten = set(self.episodic._forgotten_ids(itertools.chain.from_iterable(
            edge.meta.get("episode_ids") or () for edge in edges
        )))
        if not forgotten:
            return edges
        return [edge for edge in edges if not edge_lost_its_sources(edge, forgotten)]

    def _edge_traversable(self, relation: str, spec: Any) -> bool:
        allow = self.cfg.traversal_edge_allowlist
        if allow is not None and relation not in allow:
            return False
        return spec is not None or self.cfg.allow_unknown_relations

    def _vector_seeds(self, query: str, project_ids: Sequence[str], *, k: int) -> list[tuple[Entity, float]]:
        ords = self.semantic._entity_ordinals(project_ids)
        if not ords:
            return []
        qvec = self._embed(query)
        ranked = self.store.vectors.knn("l3_entity", qvec, k=k, allowed_rowids=ords)
        found = self.semantic.entity_by_ordinals(rowid for rowid, _ in ranked)
        out: list[tuple[Entity, float]] = []
        for rowid, distance in ranked:
            entity = found.get(int(rowid))
            similarity = 1.0 - distance
            # A negative cosine means "less alike than orthogonal": never a seed.
            if entity is None or similarity <= self.cfg.min_seed_similarity:
                continue
            out.append((entity, similarity))
        return out

    def _lexical_facts(
        self, query: str, project_ids: Sequence[str], *, limit: int
    ) -> list[tuple[Entity, float]]:
        match = fts_match_expression(query, tokenizer=self._tokenizer)
        if not match:
            return []
        marks = ",".join("?" * len(project_ids))
        rows = self.store.query(
            f"""SELECT e.*, bm25(l3_entities_fts) AS rank
                  FROM l3_entities_fts f JOIN l3_entities e ON e.entity_id = f.entity_id
                 WHERE l3_entities_fts MATCH ? AND e.project_id IN ({marks})
                 ORDER BY rank LIMIT ?""",
            (match, *project_ids, limit),
        )
        return [(self.semantic._entity_from_row(r), 0.85) for r in rows]

    # ══ deep path ══════════════════════════════════════════════════════
    def _deep_path(
        self, query: str, project_ids: Sequence[str], options: SearchOptions
    ) -> tuple[list[list[FactHit]], list[CommunityHit], list[str]]:
        """PPR + rewrites + communities, all inside ``deep_timeout_ms``.

        The deep path is the one stage whose cost grows with the graph rather
        than with the request (PPR touches every node, communities embed every
        stored summary), so it carries a wall-clock budget. Stages check it and
        return what they have; a truncated answer is still a ranked answer, and
        the elapsed time stays in ``timings_ms`` for the caller to see.
        """
        deadline = time.perf_counter() + self.cfg.deep_timeout_ms / 1000.0
        seeds = self._vector_seeds(query, project_ids, k=self.cfg.fast_seed_k)
        if not seeds:
            lexical = self._lexical_facts(query, project_ids, limit=self.cfg.fast_seed_k)
            seeds = lexical
        if not seeds:
            return [], self._communities_for(query, project_ids, deadline=deadline), []

        list_ppr = self._ppr_facts(
            query, project_ids, seeds, as_of=options.as_of, deadline=deadline
        )
        rewrites, list_rewrite = self._iterative_rewrites(
            query, project_ids, seeds, as_of=options.as_of, deadline=deadline
        )
        communities = self._communities_for(query, project_ids, deadline=deadline)
        return [list_ppr, list_rewrite], communities, rewrites

    def _ppr_facts(
        self, query: str, project_ids: Sequence[str], seeds: list[tuple[Entity, float]],
        *, as_of: str | None = None, deadline: float = float("inf"),
    ) -> list[FactHit]:
        """Personalized PageRank from the seeds; edges are ranked by endpoint mass.

        A budget hit stops iterating on the current rank vector: PPR converges
        monotonically enough that a partial sweep still ranks the neighbourhood
        of the seeds above the rest of the graph, which is the ordering this
        stage is asked for.
        """
        if time.perf_counter() > deadline:
            return []
        adjacency = self._adjacency(project_ids, as_of=as_of)
        entities = self.semantic.load_entities(project_ids)
        restart: dict[str, float] = {}
        total = sum(max(sim, 1e-6) for _, sim in seeds) or 1.0
        for entity, sim in seeds:
            restart[entity.entity_id] = max(sim, 1e-6) / total
        alpha = self.cfg.deep_ppr_alpha
        rank = dict(restart)
        for _ in range(self.cfg.deep_ppr_iterations):
            if time.perf_counter() > deadline:
                break
            nxt: dict[str, float] = {k: (1 - alpha) * v * 0 for k, v in restart.items()}
            for node, edges in adjacency.items():
                out_sum = 0.0
                for edge in edges:
                    spec = self.semantic.relation_spec(edge.relation)
                    out_sum += spec.weight if spec else 0.5
                if out_sum <= 0 or node not in rank:
                    continue
                share = rank[node] / out_sum
                for edge in edges:
                    spec = self.semantic.relation_spec(edge.relation)
                    weight = spec.weight if spec else 0.5
                    other = edge.tail_id if edge.head_id == node else edge.head_id
                    nxt[other] = nxt.get(other, 0.0) + (1 - alpha) * share * weight
            for node, value in restart.items():
                nxt[node] = nxt.get(node, 0.0) + alpha * value
            rank = nxt
        ranked = sorted(rank.items(), key=lambda kv: -kv[1])
        top = {node: value for node, value in ranked[: self.cfg.deep_ppr_max_nodes]}
        hits: list[FactHit] = []
        for edge in self._visible_edges(self.semantic.neighbors(list(top), current_only=True, at=as_of)):
            if edge.disputed:
                continue
            head = entities.get(edge.head_id)
            tail = entities.get(edge.tail_id)
            if head is None or tail is None:
                continue
            mass = top.get(edge.head_id, 0.0) + top.get(edge.tail_id, 0.0)
            if mass <= 0:
                continue
            hits.append(
                FactHit(
                    edge=edge,
                    head=head,
                    tail=tail,
                    score=mass * edge.confidence,
                    similarity=mass,
                    path=["ppr"],
                    source="ppr",
                )
            )
        hits.sort(key=lambda h: -h.score)
        return hits[: self.cfg.deep_top_k]

    def _iterative_rewrites(
        self, query: str, project_ids: Sequence[str], seeds: list[tuple[Entity, float]],
        *, as_of: str | None = None, deadline: float = float("inf"),
    ) -> tuple[list[str], list[FactHit]]:
        """Detect an evidence gap, run structured sub-queries, merge results.

        A *gap* is "the top seeds are weakly connected to each other". The
        rewrite for that gap is to ask for edges among the seed set and one hop
        out — which is exactly the query an entity-linking failure would need.

        Each probe is a separate graph query, so each one checks the deep-path
        budget first and the stage returns the probes it managed to run.
        """
        rewrites: list[str] = []
        if len(seeds) < 2:
            return rewrites, []
        seed_ids = [e.entity_id for e, _ in seeds[:4]]
        adjacency = self._adjacency(project_ids, as_of=as_of)
        seed_set = set(seed_ids)
        connected = False
        for entity_id in seed_ids:
            for edge in adjacency.get(entity_id, ()):
                other = edge.tail_id if edge.head_id == entity_id else edge.head_id
                if other in seed_set and other != entity_id:
                    connected = True
                    break
        if connected or time.perf_counter() > deadline:
            return rewrites, []
        entities = self.semantic.load_entities(project_ids)
        hits: list[FactHit] = []
        rewrites.append("connect_seeds:" + "+".join(sorted(seed_set))[:80])
        for edge in self._visible_edges(self.semantic.neighbors(seed_ids, current_only=True, at=as_of)):
            head = entities.get(edge.head_id)
            tail = entities.get(edge.tail_id)
            if head is None or tail is None or edge.disputed:
                continue
            hits.append(
                FactHit(
                    edge=edge,
                    head=head,
                    tail=tail,
                    score=edge.confidence * 0.5,
                    similarity=0.5,
                    path=["rewrite"],
                    source="rewrite",
                )
            )
        # Second gap probe: the most connected seed's own neighbourhood, which
        # answers "what do we actually know about this thing".
        if not hits and seed_ids and time.perf_counter() <= deadline:
            hub = seed_ids[0]
            rewrites.append(f"neighborhood:{hub}")
            for edge in adjacency.get(hub, ())[: self.cfg.deep_top_k]:
                head = entities.get(edge.head_id)
                tail = entities.get(edge.tail_id)
                if head is None or tail is None:
                    continue
                hits.append(
                    FactHit(
                        edge=edge,
                        head=head,
                        tail=tail,
                        score=edge.confidence * 0.35,
                        similarity=0.35,
                        path=["rewrite:neighborhood"],
                        source="rewrite",
                    )
                )
        hits.sort(key=lambda h: -h.score)
        return rewrites[: self.cfg.deep_max_rewrites], hits

    def _communities_for(
        self, query: str, project_ids: Sequence[str], *, deadline: float = float("inf")
    ) -> list[CommunityHit]:
        """Stored community summaries scored against the query.

        Scoring embeds one text per community, the only per-row provider call
        in retrieval, so the loop stops at the deep-path budget and returns the
        communities it already scored.
        """
        marks = ",".join("?" * len(project_ids))
        rows = self.store.query(
            f"SELECT * FROM l3_communities WHERE project_id IN ({marks})", list(project_ids)
        )
        if not rows:
            return []
        qterms = set(keywords(query, limit=12, tokenizer=self._tokenizer))
        qvec = self._embed(query)
        out: list[CommunityHit] = []
        for row in rows:
            if time.perf_counter() > deadline:
                break
            text = f"{row['label'] or ''} {row['summary'] or ''}"
            overlap = len(qterms & set(keywords(text, limit=24, tokenizer=self._tokenizer)))
            sim = _cosine(qvec, self._embed(text)) if text.strip() else 0.0
            score = 0.6 * min(1.0, overlap / 4) + 0.4 * max(0.0, sim)
            if score < 0.15:
                continue
            out.append(
                CommunityHit(
                    community_id=row["community_id"],
                    label=row["label"] or "",
                    summary=row["summary"] or "",
                    size=int(row["size"]),
                    score=score,
                    members=json_loads(row["member_ids"], [])[:8],
                )
            )
        out.sort(key=lambda c: -c.score)
        return out

    # ══ budget ═════════════════════════════════════════════════════════
    def _estimate_tokens(self, result: SearchResult) -> int:
        total = 0
        for fact in result.facts:
            total += estimate_tokens(f"{fact.head.name} {fact.edge.relation} {fact.tail.name}")
        for ep in result.episodes:
            total += estimate_tokens(ep.episode.summary)
        for c in result.communities:
            total += estimate_tokens(c.summary)
        return total

    def _apply_budget(self, result: SearchResult, budget: int) -> None:
        """Drop the lowest-ranked items until the estimate fits."""
        if budget <= 0:
            return
        while self._estimate_tokens(result) > budget and (result.episodes or result.facts):
            # Trim the weaker half first: episodes fade faster than facts.
            if len(result.episodes) > len(result.facts):
                result.episodes.pop()
            elif result.facts:
                result.facts.pop()
            else:
                result.episodes.pop()
            result.trimmed = True
        result.tokens_estimated = self._estimate_tokens(result)

    def _embed(self, text: str) -> list[float]:
        if self._cache is not None:
            return self._cache.embed_one(text)
        return self.embeddings.embed_one(text)


# ── utilities ───────────────────────────────────────────────────────────


def rrf_fuse(
    lists: Iterable[Sequence[Any]],
    *,
    key: Callable[[Any], Any],
    k: int = 60,
    weights: Sequence[float] | None = None,
) -> list[Any]:
    """Reciprocal Rank Fusion over arbitrary ranked lists."""
    scores: dict[Any, float] = {}
    best: dict[Any, Any] = {}
    for idx, items in enumerate(lists):
        weight = weights[idx] if weights and idx < len(weights) else 1.0
        for rank, item in enumerate(items, start=1):
            item_key = key(item)
            scores[item_key] = scores.get(item_key, 0.0) + weight / (k + rank)
            if item_key not in best or getattr(item, "score", 0.0) > getattr(best[item_key], "score", 0.0):
                best[item_key] = item
    ordered = sorted(best.items(), key=lambda kv: -scores[kv[0]])
    return [item for _, item in ordered]


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)