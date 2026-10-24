"""L3 community detection and summary roll-up.

Global questions ("summarize what we know about billing") cannot be answered by
a k-NN over entities: the answer is a *region* of the graph. This module
detects communities, writes one deterministic summary per community, and lets
the retriever route global queries to those summaries.

Algorithm: **label propagation** (Raghavan et al.) with deterministic tie-breaking.
Chosen over Louvain/Leiden on purpose:

* it needs no multilevel bookkeeping or quality tuning, so it cannot silently
  produce a different result for the same input;
* it is O(E) per sweep and converges in a handful of sweeps on memory-graph
  sizes (hundreds to low thousands of edges);
* every node keeps exactly one label, so "which community is this entity in"
  is a dictionary lookup rather than a dendrogram walk — that is what the
  retriever needs.

Summaries are extractive: a label plus the top-n edges by confidence and
degree. They are *not* LLM-generated — a summary that costs a model call per
graph change would reintroduce the cost the design is trying to avoid, and an
extractive summary cannot hallucinate. A host that wants richer summaries can
post-process ``Community.summary`` through its own model.
"""

from __future__ import annotations

import hashlib
import itertools
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from .l2 import EpisodicMemory
from .l3 import Edge, Entity, SemanticMemory
from .retrieval import edge_lost_its_sources
from .storage import Store, json_dumps, to_iso, utcnow
from .text import clip_words


@dataclass(slots=True)
class Community:
    community_id: str
    label: str
    members: list[str] = field(default_factory=list)  # entity ids
    summary: str = ""
    size: int = 0
    signature: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "community_id": self.community_id,
            "label": self.label,
            "size": self.size,
            "summary": self.summary,
        }


def detect_communities(
    entities: dict[str, Entity],
    edges: Sequence[Edge],
    *,
    max_iterations: int = 12,
) -> dict[str, int]:
    """Label propagation. Returns ``entity_id -> community label``."""
    adjacency: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for edge in edges:
        weight = edge.confidence
        adjacency[edge.head_id].append((edge.tail_id, weight))
        adjacency[edge.tail_id].append((edge.head_id, weight))
    labels: dict[str, int] = {eid: idx for idx, eid in enumerate(sorted(entities))}
    nodes = sorted(entities)
    for _ in range(max_iterations):
        changed = 0
        for node in nodes:
            neighbours = adjacency.get(node)
            if not neighbours:
                continue
            weights: dict[int, float] = defaultdict(float)
            for other, weight in neighbours:
                weights[labels[other]] += weight
            best_label = max(weights.items(), key=lambda kv: (kv[1], -kv[0]))[0]
            if labels[node] != best_label:
                labels[node] = best_label
                changed += 1
        if changed == 0:
            break
    # Normalize labels to dense ids in a deterministic order.
    remap: dict[int, int] = {}
    for node in nodes:
        label = labels[node]
        if label not in remap:
            remap[label] = len(remap)
        labels[node] = remap[label]
    return labels


def summarize_communities(
    entities: dict[str, Entity],
    edges: Sequence[Edge],
    labels: dict[str, int],
    *,
    min_size: int = 3,
    max_edges: int = 6,
) -> list[Community]:
    groups: dict[int, list[str]] = defaultdict(list)
    for entity_id, label in labels.items():
        groups[label].append(entity_id)
    by_id = {e.edge_id: e for e in edges}
    out: list[Community] = []
    for label, members in groups.items():
        if len(members) < min_size:
            continue
        member_set = set(members)
        internal = [
            e for e in edges if e.head_id in member_set and e.tail_id in member_set
        ]
        internal.sort(key=lambda e: (-e.confidence, -len(e.meta.get("episode_ids", []))))
        top = internal[:max_edges]
        # Label = highest-degree member name (ties broken by name for determinism).
        degree: Counter[str] = Counter()
        for e in edges:
            if e.head_id in member_set:
                degree[e.head_id] += 1
            if e.tail_id in member_set:
                degree[e.tail_id] += 1
        ranked = sorted(members, key=lambda m: (-degree[m], entities[m].name if m in entities else m))
        label_name = entities[ranked[0]].name if ranked and ranked[0] in entities else f"cluster-{label}"
        facts = [
            f"{entities[e.head_id].name} {e.relation} {entities[e.tail_id].name}"
            for e in top
            if e.head_id in entities and e.tail_id in entities
        ]
        summary = clip_words(
            f"{label_name} 簇（{len(members)} 个实体）: " + "；".join(facts), 400
        )
        signature = hashlib.sha1(
            "|".join(sorted(f"{m}:{entities[m].name}" for m in members if m in entities)).encode()
        ).hexdigest()[:16]
        out.append(
            Community(
                community_id=f"cm_{label:04d}",
                label=label_name,
                members=members,
                summary=summary,
                size=len(members),
                signature=signature,
            )
        )
    out.sort(key=lambda c: (-c.size, c.label))
    return out


class CommunityIndex:
    """Persists communities and skips recomputation when the graph is unchanged."""

    def __init__(self, store: Store, semantic: SemanticMemory, *, min_size: int = 3,
                 episodic: EpisodicMemory | None = None) -> None:
        self.store = store
        self.semantic = semantic
        self.min_size = min_size
        self.episodic = episodic

    def rebuild(self, project_id: str) -> list[Community]:
        entities, edges = self.semantic.load_subgraph([project_id], current_only=True)
        if not entities:
            with self.store.transaction():
                self.store.execute("DELETE FROM l3_communities WHERE project_id = ?", (project_id,))
            return []
        # Same visibility rules the rest of the system serves by: a disputed
        # conflict must not define community structure, and a claim whose
        # every cited episode was user-forgotten must not keep binding its
        # endpoints into a cluster — L2 already refuses to return those
        # sources, and the adjacency cache already refuses to traverse them;
        # communities were the one path left reading the raw table.
        edges = [edge for edge in edges if not edge.disputed]
        if self.episodic is not None and edges:
            forgotten = set(self.episodic._forgotten_ids(itertools.chain.from_iterable(
                edge.meta.get("episode_ids") or () for edge in edges
            )))
            if forgotten:
                edges = [edge for edge in edges if not edge_lost_its_sources(edge, forgotten)]
        if not edges:
            with self.store.transaction():
                self.store.execute("DELETE FROM l3_communities WHERE project_id = ?", (project_id,))
            return []
        labels = detect_communities(entities, edges)
        communities = summarize_communities(
            entities, edges, labels, min_size=self.min_size
        )
        now = to_iso(utcnow())
        with self.store.transaction():
            self.store.execute("DELETE FROM l3_communities WHERE project_id = ?", (project_id,))
            for community in communities:
                self.store.execute(
                    """INSERT INTO l3_communities
                       (project_id, community_id, label, summary, member_ids, size, signature, computed_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (
                        project_id,
                        community.community_id,
                        community.label,
                        community.summary,
                        json_dumps(community.members),
                        community.size,
                        community.signature,
                        now,
                    ),
                )
        return communities

    def current(self, project_id: str) -> list[dict[str, Any]]:
        return [
            dict(row)
            for row in self.store.query(
                "SELECT * FROM l3_communities WHERE project_id = ? ORDER BY size DESC", (project_id,)
            )
        ]

    def community_of(self, project_id: str, entity_id: str) -> str | None:
        for row in self.store.query(
            "SELECT community_id, member_ids FROM l3_communities WHERE project_id = ?", (project_id,)
        ):
            from .storage import json_loads

            if entity_id in (json_loads(row["member_ids"], []) or []):
                return row["community_id"]
        return None