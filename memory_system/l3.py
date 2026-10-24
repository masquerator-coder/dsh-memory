"""L3 — semantic memory (knowledge graph).

Four responsibilities, in the order a write passes through them:

1. **Normalization**: entity resolution (alias/name/type) so the graph has one
   node per thing, not one per phrasing.
2. **Write-time consistency** (design §5.2): cardinality, type domain/range,
   cycle detection, evidence conflict — *reject or close*, never "delete".
3. **Dual temporality**: ``valid_from``/``valid_to`` describe the world;
   ``recorded_at`` describes what the system believed and when. Closing an edge
   sets ``valid_to``; nothing is removed, so "what did we believe in March" stays
   answerable.
4. **Epistemics** (an addition, see DESIGN.md §Divergences D2): every edge
   carries *why we believe it* — L3→L2 evidence, L2→L0 provenance, plus system
   observations such as configuration deltas and launches actually offered.
   Beliefs derived from a superseded *belief* are retracted transitively.

Retrieval lives in :mod:`memory_system.retrieval`; community summarization in
:mod:`memory_system.communities`.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Sequence

from .config import L3Config, MemoryConfig, RelationTypeSpec
from .embedding import EmbeddingProvider
from .errors import NotFoundError, ValidationError
from .storage import Store, json_dumps, json_loads, parse_iso, to_iso, utcnow
from .text import estimate_tokens, keywords, normalize_name

ConflictPolicy = Literal["evidence", "last_write", "defer"]

CHANGE_KIND = Literal[
    "entity.created",
    "entity.updated",
    "edge.created",
    "edge.closed",
    "edge.disputed",
    "edge.rejected",
    "edge.resolved",
    "edge.superseded_by_belief",
    "attribute.updated",
]


def new_entity_id() -> str:
    return "en_" + uuid.uuid4().hex[:12]


def new_edge_id() -> str:
    return "ed_" + uuid.uuid4().hex[:12]


def new_change_id() -> str:
    return "ch_" + uuid.uuid4().hex[:12]


@dataclass(slots=True)
class Entity:
    entity_id: str
    project_id: str
    name: str
    type: str
    aliases: list[str] = field(default_factory=list)
    attributes: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""
    ordinal: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "entity_id": self.entity_id,
            "project_id": self.project_id,
            "name": self.name,
            "type": self.type,
            "aliases": list(self.aliases),
            "attributes": dict(self.attributes),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(slots=True)
class Edge:
    edge_id: str
    project_id: str
    head_id: str
    relation: str
    tail_id: str
    confidence: float
    valid_from: str
    valid_to: str | None = None
    recorded_at: str = ""
    anchor_id: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def is_current(self) -> bool:
        return self.valid_to is None

    @property
    def disputed(self) -> bool:
        return bool(self.meta.get("disputed"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "edge_id": self.edge_id,
            "project_id": self.project_id,
            "head_id": self.head_id,
            "relation": self.relation,
            "tail_id": self.tail_id,
            "confidence": round(self.confidence, 4),
            "valid_from": self.valid_from,
            "valid_to": self.valid_to,
            "recorded_at": self.recorded_at,
            "anchor_id": self.anchor_id,
            "disputed": self.disputed,
            "episode_ids": list(self.meta.get("episode_ids", [])),
        }

    @classmethod
    def from_row(cls, row: Any) -> "Edge":
        return cls(
            edge_id=row["edge_id"],
            project_id=row["project_id"],
            head_id=row["head_id"],
            relation=row["relation"],
            tail_id=row["tail_id"],
            confidence=float(row["confidence"]),
            valid_from=row["valid_from"],
            valid_to=row["valid_to"],
            recorded_at=row["recorded_at"],
            anchor_id=row["anchor_id"],
            meta=json_loads(row["meta"], {}) or {},
        )


@dataclass(slots=True)
class FactInput:
    """One world-claim from a caller.

    ``head``/``tail`` are *names*; resolution to entities happens inside
    :meth:`SemanticMemory.add_fact`, so callers never need entity ids.
    """

    head: str
    relation: str
    tail: str
    confidence: float = 0.8
    valid_from: str | None = None
    head_type: str | None = None
    tail_type: str | None = None
    attributes: dict[str, Any] | None = None
    episode_ids: list[str] | None = None
    anchor_id: str | None = None
    conflict_policy: ConflictPolicy | None = None
    # Observation the belief depends on (L4 launch context, tool result, ...).
    observed_context: dict[str, Any] | None = None


@dataclass(slots=True)
class EdgeDecision:
    """Outcome of one write attempt; always returned, never raised for content."""

    status: Literal["accepted", "rejected", "closed", "disputed", "duplicate"]
    reason: str = ""
    edge: Edge | None = None
    closed_edge_ids: list[str] = field(default_factory=list)
    conflict: dict[str, Any] | None = None

    @property
    def ok(self) -> bool:
        return self.status in {"accepted", "closed", "duplicate"}


class SemanticMemory:
    def __init__(
        self,
        store: Store,
        config: MemoryConfig,
        embeddings: EmbeddingProvider,
        *,
        embedding_cache: Any | None = None,
        episodic: Any | None = None,
    ) -> None:
        self.store = store
        self.config = config
        self.cfg: L3Config = config.l3
        self.embeddings = embeddings
        self._cache = embedding_cache
        # Injected after construction to avoid a cycle; used for evidence walk.
        self.episodic = episodic
        self._registry: dict[str, RelationTypeSpec] = {s.name: s for s in self.cfg.relation_types}
        self._tokenizer = config.lexical.tokenizer

    # ══ relation registry ═══════════════════════════════════════════════
    def relation_spec(self, relation: str) -> RelationTypeSpec | None:
        return self._registry.get(normalize_relation(relation))

    def register_relation(self, spec: RelationTypeSpec) -> None:
        self._registry[spec.name] = spec

    @property
    def relation_names(self) -> list[str]:
        return sorted(self._registry)

    # ══ entity resolution ═══════════════════════════════════════════════
    def resolve_entity(
        self,
        project_id: str,
        name: str,
        entity_type: str = "thing",
        *,
        create: bool = True,
        persist: bool = True,
        aliases: Sequence[str] | None = None,
        attributes: dict[str, Any] | None = None,
    ) -> Entity | None:
        """Find-or-create by normalized name, then alias, then similarity probe.

        ``persist=False`` resolves without writing: a caller that validates the
        resolved endpoints (type constraints, cycles) must not leave an entity
        behind when it goes on to reject the fact. Such a placeholder carries
        ``ordinal=None``; persist it later with ``_create_entity``.
        """
        norm = normalize_name(name)
        if not norm:
            raise ValidationError("entity name is empty")
        # Match the declared type first so two same-named nodes of different
        # types (a car and a company both called "Toyota") resolve to the one
        # the caller meant instead of whichever row happens to come back.
        row = self.store.query_one(
            "SELECT * FROM l3_entities WHERE project_id = ? AND name_norm = ? AND type = ?",
            (project_id, norm, entity_type),
        )
        if row is None:
            row = self.store.query_one(
                "SELECT * FROM l3_entities WHERE project_id = ? AND name_norm = ? ORDER BY type = 'thing' DESC, ord",
                (project_id, norm),
            )
        if row is not None:
            entity = self._entity_from_row(row)
            # An explicitly typed caller upgrades an untyped placeholder node.
            upgrade = entity_type if (entity.type == "thing" and entity_type not in ("thing", "")) else None
            if aliases or attributes or upgrade:
                if persist:
                    self._merge_entity(
                        entity, aliases=aliases, attributes=attributes, entity_type=upgrade
                    )
                    return self.get_entity(entity.entity_id)
                # Dry run: report the upgrade without applying it.
                entity.type = upgrade or entity.type
                return entity
            return entity
        # Alias hit: an alternate form already registered for another node.
        for candidate in self.store.query(
            "SELECT * FROM l3_entities WHERE project_id = ? AND aliases LIKE ? LIMIT 5",
            (project_id, f'%"{norm}"%'),
        ):
            return self._entity_from_row(candidate)
        if not create:
            return None
        if not persist:
            # A placeholder for validation only: no row, no vector, no change log.
            now = to_iso(utcnow())
            return Entity(
                entity_id=new_entity_id(),
                project_id=project_id,
                name=name.strip(),
                type=entity_type,
                aliases=_dedupe_aliases(name, aliases or []),
                attributes=dict(attributes or {}),
                created_at=now,
                updated_at=now,
                ordinal=None,
            )
        return self._create_entity(project_id, name, entity_type, aliases, attributes)

    def _materialize_entity(
        self,
        project_id: str,
        entity: Entity,
        name: str,
        *,
        aliases: Sequence[str] | None,
        attributes: dict[str, Any] | None,
    ) -> Entity:
        """Persist a placeholder from ``resolve_entity(persist=False)``.

        An entity that already exists comes back with an ordinal and only needs
        its aliases/attributes folded in; a placeholder is inserted now, after
        the caller's validation has passed.
        """
        if entity.ordinal is not None:
            self._merge_entity(entity, aliases=aliases, attributes=attributes, entity_type=None)
            return self.get_entity(entity.entity_id)
        # Re-resolve against the store: a concurrent caller may have inserted
        # the same name while this request was validating.
        existing = self.store.query_one(
            "SELECT * FROM l3_entities WHERE project_id = ? AND name_norm = ? AND type = ?",
            (project_id, normalize_name(name), entity.type),
        )
        if existing is not None:
            return self._entity_from_row(existing)
        return self._create_entity(project_id, name, entity.type, aliases, attributes)

    def _create_entity(
        self,
        project_id: str,
        name: str,
        entity_type: str,
        aliases: Sequence[str] | None,
        attributes: dict[str, Any] | None,
    ) -> Entity:
        entity_id = new_entity_id()
        now = to_iso(utcnow())
        alias_list = _dedupe_aliases(name, aliases or [])
        with self.store.transaction():
            cur = self.store.execute(
                """INSERT INTO l3_entities
                   (entity_id, project_id, name, name_norm, type, aliases, attributes,
                    created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    entity_id,
                    project_id,
                    name.strip(),
                    normalize_name(name),
                    entity_type,
                    json_dumps(alias_list),
                    json_dumps(attributes or {}),
                    now,
                    now,
                ),
            )
            ordinal = int(cur.lastrowid)
            self.store.vectors.upsert("l3_entity", ordinal, self._embed(self._entity_text(name, entity_type, alias_list)))
            self.store.execute(
                "INSERT INTO l3_entities_fts(entity_id, body) VALUES (?, ?)",
                (entity_id, " ".join([name, entity_type, *alias_list, *map(str, (attributes or {}).values())])),
            )
            self._record_change(
                project_id,
                kind="entity.created",
                target_kind="entity",
                target_id=entity_id,
                detail={"name": name, "type": entity_type},
            )
        entity = self.get_entity(entity_id)
        entity.ordinal = ordinal
        return entity

    def _merge_entity(
        self,
        entity: Entity,
        *,
        aliases: Sequence[str] | None,
        attributes: dict[str, Any] | None,
        entity_type: str | None,
    ) -> None:
        changed_attrs: dict[str, Any] = {}
        new_attrs = dict(entity.attributes)
        for key, value in (attributes or {}).items():
            if new_attrs.get(key) != value:
                changed_attrs[key] = {"from": new_attrs.get(key), "to": value}
                new_attrs[key] = value
        new_aliases = _dedupe_aliases(entity.name, [*(entity.aliases or []), *(aliases or [])])
        aliases_changed = new_aliases != entity.aliases
        type_changed = entity_type is not None and entity_type != entity.type
        if not changed_attrs and not aliases_changed and not type_changed:
            return
        now = to_iso(utcnow())
        with self.store.transaction():
            self.store.execute(
                "UPDATE l3_entities SET aliases = ?, attributes = ?, type = ?, updated_at = ? "
                "WHERE entity_id = ?",
                (
                    json_dumps(new_aliases),
                    json_dumps(new_attrs),
                    entity_type or entity.type,
                    now,
                    entity.entity_id,
                ),
            )
            if changed_attrs:
                self._record_change(
                    entity.project_id,
                    kind="attribute.updated",
                    target_kind="entity",
                    target_id=entity.entity_id,
                    detail=changed_attrs,
                )
            if aliases_changed:
                self.store.execute("DELETE FROM l3_entities_fts WHERE entity_id = ?", (entity.entity_id,))
                self.store.execute(
                    "INSERT INTO l3_entities_fts(entity_id, body) VALUES (?, ?)",
                    (
                        entity.entity_id,
                        " ".join([entity.name, entity_type or entity.type, *new_aliases]),
                    ),
                )

    @staticmethod
    def _entity_text(name: str, entity_type: str, aliases: Sequence[str]) -> str:
        return " ".join([name, entity_type, *aliases])

    def get_entity(self, entity_id: str) -> Entity:
        row = self.store.query_one("SELECT * FROM l3_entities WHERE entity_id = ?", (entity_id,))
        if row is None:
            raise NotFoundError(f"entity {entity_id} not found")
        return self._entity_from_row(row)

    @staticmethod
    def _entity_from_row(row: Any) -> Entity:
        return Entity(
            entity_id=row["entity_id"],
            project_id=row["project_id"],
            name=row["name"],
            type=row["type"],
            aliases=json_loads(row["aliases"], []) or [],
            attributes=json_loads(row["attributes"], {}) or {},
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            ordinal=int(row["ord"]),
        )

    def find_entities(self, project_ids: Sequence[str], text: str, *, limit: int = 8) -> list[Entity]:
        """Entities mentioned in ``text``: exact name/alias first, then vector."""
        if not project_ids or not text:
            return []
        marks = ",".join("?" * len(project_ids))
        found: dict[str, Entity] = {}
        for term in set([normalize_name(text), *keywords(text, limit=10, tokenizer=self._tokenizer)]):
            if not term:
                continue
            for row in self.store.query(
                f"SELECT * FROM l3_entities WHERE project_id IN ({marks}) AND name_norm = ? LIMIT 5",
                (*project_ids, term),
            ):
                e = self._entity_from_row(row)
                found.setdefault(e.entity_id, e)
        # FTS on entity names for partial mentions
        from .text import fts_match_expression

        match = fts_match_expression(text, tokenizer=self._tokenizer)
        if match:
            for row in self.store.query(
                f"""SELECT e.* FROM l3_entities_fts f JOIN l3_entities e ON e.entity_id = f.entity_id
                     WHERE l3_entities_fts MATCH ? AND e.project_id IN ({marks})
                     ORDER BY bm25(l3_entities_fts) LIMIT ?""",
                (match, *project_ids, limit),
            ):
                e = self._entity_from_row(row)
                found.setdefault(e.entity_id, e)
        if len(found) < limit:
            allowed = self._entity_ordinals(project_ids)
            if allowed:
                qvec = self._embed(text)
                ords = self.store.vectors.knn("l3_entity", qvec, k=limit, allowed_rowids=allowed)
                for ordinal, distance in ords:
                    if 1.0 - distance < 0.35:
                        continue
                    row = self.store.query_one("SELECT * FROM l3_entities WHERE ord = ?", (ordinal,))
                    if row is not None:
                        e = self._entity_from_row(row)
                        found.setdefault(e.entity_id, e)
        return list(found.values())[:limit]

    def _entity_ordinals(self, project_ids: Sequence[str]) -> set[int]:
        marks = ",".join("?" * len(project_ids))
        return {
            int(r["ord"])
            for r in self.store.query(
                f"SELECT ord FROM l3_entities WHERE project_id IN ({marks})", list(project_ids)
            )
        }

    # ══ facts / edges ═══════════════════════════════════════════════════
    def add_fact(self, project_id: str, fact: FactInput, *, recorded_at: str | None = None) -> EdgeDecision:
        relation = normalize_relation(fact.relation)
        spec = self.relation_spec(relation)
        if spec is None and not self.cfg.allow_unknown_relations:
            return EdgeDecision(
                status="rejected",
                reason="unknown_relation",
                conflict={"relation": relation, "known": self.relation_names},
            )
        if fact.confidence < self.cfg.min_confidence:
            return EdgeDecision(status="rejected", reason="low_confidence")
        if not (fact.head or "").strip() or not (fact.tail or "").strip():
            return EdgeDecision(status="rejected", reason="empty_endpoint")

        # Provenance validation (DESIGN §3.3). Supplied episode ids must exist
        # in L2: a dangling id silently weakens the evidence chain. A fact with
        # *no* provenance stays allowed by default (hand-written / imported
        # edges), strict hosts set ``require_evidence``.
        if fact.episode_ids:
            known = self.episodic.by_ids(fact.episode_ids) if self.episodic is not None else {}
            missing = [mid for mid in fact.episode_ids if mid and mid not in known]
            if missing:
                return EdgeDecision(
                    status="rejected",
                    reason="needs_evidence",
                    conflict={"missing_episode_ids": missing},
                )
        elif self.cfg.require_evidence:
            return EdgeDecision(status="rejected", reason="needs_evidence")

        # Resolve both endpoints *without persisting*: every rejection below
        # returns before any write, so a refused fact must not leave the two
        # nodes it mentioned behind as orphans in the graph.
        head = self.resolve_entity(
            project_id,
            fact.head,
            fact.head_type or (spec.domain[0] if spec and spec.domain else "thing"),
            attributes=fact.attributes,
            aliases=[fact.head],
            persist=False,
        )
        tail = self.resolve_entity(
            project_id, fact.tail, fact.tail_type or "thing", aliases=[fact.tail], persist=False
        )
        assert head is not None and tail is not None

        # Type constraint (design §5.2 row 2). Checked against the *declared*
        # type when the caller supplied one, otherwise the stored type.
        declared_head = head.type
        declared_tail = tail.type
        if spec is not None:
            if spec.domain and declared_head not in spec.domain:
                return EdgeDecision(
                    status="rejected",
                    reason="type_constraint",
                    conflict={"end": "head", "expected": list(spec.domain), "actual": declared_head},
                )
            if spec.range and declared_tail not in spec.range:
                return EdgeDecision(
                    status="rejected",
                    reason="type_constraint",
                    conflict={"end": "tail", "expected": list(spec.range), "actual": declared_tail},
                )

        # Validation passed: commit the endpoints for real (creating the ones
        # that were placeholders), then re-read their stored form.
        head = self._materialize_entity(project_id, head, fact.head, aliases=[fact.head], attributes=fact.attributes)
        tail = self._materialize_entity(project_id, tail, fact.tail, aliases=[fact.tail], attributes=None)

        # Type promotion: an explicit type on a previously untyped node upgrades it.
        if fact.head_type and head.type == "thing":
            self._merge_entity(head, aliases=None, attributes=None, entity_type=fact.head_type)
        if fact.tail_type and tail.type == "thing":
            self._merge_entity(tail, aliases=None, attributes=None, entity_type=fact.tail_type)

        # Exact duplicate
        existing = self._edge_by_triple(head.entity_id, relation, tail.entity_id)
        if existing is not None and existing.is_current:
            self._strengthen_edge(existing, fact)
            return EdgeDecision(status="duplicate", edge=self.get_edge(existing.edge_id), reason="existing")

        # Cycle (design §5.2 row 3)
        if spec is not None and spec.acyclic and self._would_cycle(project_id, head.entity_id, relation, tail.entity_id):
            return EdgeDecision(
                status="rejected",
                reason="cycle",
                conflict={"head": head.name, "relation": relation, "tail": tail.name},
            )

        valid_from = fact.valid_from or recorded_at or to_iso(utcnow())
        recorded = recorded_at or to_iso(utcnow())
        policy = fact.conflict_policy or self.cfg.default_conflict_policy

        # Cardinality conflict (design §5.2 rows 1+4)
        conflicting: list[Edge] = []
        if spec is not None and spec.cardinality == "one":
            conflicting = [
                e
                for e in self.edges_of(head.entity_id, relation=relation, direction="out")
                if e.is_current and e.tail_id != tail.entity_id
            ]
        if conflicting:
            return self._resolve_conflict(project_id, head, relation, tail, conflicting, fact, policy, valid_from, recorded)

        return self._create_edge(project_id, head, relation, tail, fact, valid_from, recorded)

    def _create_edge(
        self,
        project_id: str,
        head: Entity,
        relation: str,
        tail: Entity,
        fact: FactInput,
        valid_from: str,
        recorded_at: str,
    ) -> EdgeDecision:
        # Reuse a closed triple instead of inserting a second row: keeps the
        # uniqueness constraint honest while preserving the full history in
        # l3_changes. "Preserving" means snapshotting the prior belief row:
        # without this snapshot the UPDATE below would erase the previous
        # valid_from/valid_to interval and its evidence — the only place the
        # closed world-state could still be reconstructed is right here.
        prior = self._edge_by_triple(head.entity_id, relation, tail.entity_id)
        prior_snapshot: dict[str, Any] | None = None
        if prior is not None:
            prior_snapshot = {
                "edge_id": prior.edge_id,
                "valid_from": prior.valid_from,
                "valid_to": prior.valid_to,
                "confidence": prior.confidence,
                "episode_ids": list(prior.meta.get("episode_ids") or []),
            }
        episode_ids = list(fact.episode_ids or [])
        meta = {
            "episode_ids": episode_ids,
            "observed_context": fact.observed_context or {},
            "evidence_strength": 0.0,
        }
        with self.store.transaction():
            if prior is not None:
                edge_id = prior.edge_id
                self.store.execute(
                    """UPDATE l3_edges SET confidence = ?, valid_from = ?, valid_to = NULL,
                       recorded_at = ?, anchor_id = ?, meta = ? WHERE edge_id = ?""",
                    (fact.confidence, valid_from, recorded_at, fact.anchor_id, json_dumps(meta), edge_id),
                )
            else:
                edge_id = new_edge_id()
                self.store.execute(
                    """INSERT INTO l3_edges
                       (edge_id, project_id, head_id, relation, tail_id, confidence, valid_from,
                        valid_to, recorded_at, anchor_id, meta)
                       VALUES (?,?,?,?,?,?,?,NULL,?,?,?)""",
                    (
                        edge_id,
                        project_id,
                        head.entity_id,
                        relation,
                        tail.entity_id,
                        fact.confidence,
                        valid_from,
                        recorded_at,
                        fact.anchor_id,
                        json_dumps(meta),
                    ),
                )
            detail: dict[str, Any] = {
                "head": head.name,
                "relation": relation,
                "tail": tail.name,
                "reopened": prior is not None,
            }
            if prior_snapshot is not None:
                detail["prior"] = prior_snapshot
            change_id = self._record_change(
                project_id,
                kind="edge.created",
                target_kind="edge",
                target_id=edge_id,
                detail=detail,
                anchor_id=fact.anchor_id,
                recorded_at=recorded_at,
            )
            self._link_episodes(change_id, episode_ids)
        return EdgeDecision(status="accepted", edge=self.get_edge(edge_id))

    def _resolve_conflict(
        self,
        project_id: str,
        head: Entity,
        relation: str,
        tail: Entity,
        conflicting: Sequence[Edge],
        fact: FactInput,
        policy: ConflictPolicy,
        valid_from: str,
        recorded_at: str,
    ) -> EdgeDecision:
        if policy == "defer":
            decision = self._create_edge(project_id, head, relation, tail, fact, valid_from, recorded_at)
            if decision.status == "accepted" and decision.edge is not None:
                ids = [decision.edge.edge_id, *[e.edge_id for e in conflicting]]
                with self.store.transaction():
                    for edge_id in ids:
                        self.store.execute(
                            """UPDATE l3_edges
                                  SET meta = json_set(meta, '$.disputed', 1)
                                WHERE edge_id = ?""",
                            (edge_id,),
                        )
                    self._record_change(
                        project_id,
                        kind="edge.disputed",
                        target_kind="edge",
                        target_id=decision.edge.edge_id,
                        detail={"contenders": ids, "policy": policy},
                    )
                decision.status = "disputed"
                decision.conflict = {"contenders": ids, "policy": policy}
                decision.edge = self.get_edge(decision.edge.edge_id)
                return decision
            return decision

        if policy == "last_write":
            winner, losers = "new", list(conflicting)
        else:  # evidence
            new_strength = self._evidence_strength(fact.episode_ids or [], fact.confidence)
            best_existing = max(
                ((e, self._edge_strength(e)) for e in conflicting), key=lambda pair: pair[1][0]
            )
            existing_edge, (existing_strength, existing_recorded) = best_existing
            if new_strength > existing_strength + 1e-9:
                winner, losers = "new", list(conflicting)
            elif new_strength < existing_strength - 1e-9:
                # The claim is weaker than what we believe: record the attempt,
                # do not change the belief. This is what keeps a model's
                # hallucinated fact from overwriting a verified one.
                with self.store.transaction():
                    self._record_change(
                        project_id,
                        kind="edge.rejected",
                        target_kind="edge",
                        target_id=existing_edge.edge_id,
                        detail={
                            "head": head.name,
                            "relation": relation,
                            "tail": tail.name,
                            "reason": "weaker_evidence",
                            "incoming_strength": round(new_strength, 4),
                            "existing_strength": round(existing_strength, 4),
                        },
                        anchor_id=fact.anchor_id,
                        recorded_at=recorded_at,
                    )
                return EdgeDecision(
                    status="rejected",
                    reason="weaker_evidence",
                    edge=existing_edge,
                    conflict={
                        "incoming": round(new_strength, 4),
                        "existing": round(existing_strength, 4),
                        "policy": "evidence",
                    },
                )
            else:
                # A tie is not resolvable from evidence; recency is the only
                # remaining signal, and deferring here would hide the clash.
                newer = max(
                    [*conflicting], key=lambda e: e.recorded_at or ""
                ).recorded_at or ""
                winner, losers = ("new", list(conflicting)) if recorded_at >= newer else (
                    "existing",
                    [],
                )

        if winner == "existing":
            decision = self._create_edge(project_id, head, relation, tail, fact, valid_from, recorded_at)
            if decision.edge is not None:
                with self.store.transaction():
                    self.store.execute(
                        """UPDATE l3_edges SET valid_to = ?, meta = json_set(meta, '$.closed_reason', ?)
                           WHERE edge_id = ?""",
                        (valid_from, "superseded", decision.edge.edge_id),
                    )
                    self._record_change(
                        project_id,
                        kind="edge.closed",
                        target_kind="edge",
                        target_id=decision.edge.edge_id,
                        detail={"reason": "superseded", "by_policy": policy},
                    )
            decision.status = "closed"
            return decision

        decision = self._create_edge(project_id, head, relation, tail, fact, valid_from, recorded_at)
        if decision.edge is None:
            return decision
        closed: list[str] = []
        with self.store.transaction():
            for old in losers:
                self.store.execute(
                    """UPDATE l3_edges SET valid_to = ?, meta = json_set(meta, '$.closed_reason', ?)
                       WHERE edge_id = ?""",
                    (valid_from, "superseded", old.edge_id),
                )
                closed.append(old.edge_id)
            self._record_change(
                project_id,
                kind="edge.closed",
                target_kind="edge",
                target_id=decision.edge.edge_id,
                detail={"closed": closed, "by_policy": policy, "replacement": decision.edge.edge_id},
                recorded_at=recorded_at,
            )
        decision.status = "closed"
        decision.closed_edge_ids = closed
        decision.conflict = {"closed": closed, "policy": policy}
        decision.edge = self.get_edge(decision.edge.edge_id)
        return decision

    def close_edge(self, edge_id: str, *, valid_to: str | None = None, reason: str = "user_forget") -> Edge:
        valid_to = valid_to or to_iso(utcnow())
        with self.store.transaction():
            edge = self.get_edge(edge_id)
            self.store.execute(
                "UPDATE l3_edges SET valid_to = ?, meta = json_set(meta, '$.closed_reason', ?) WHERE edge_id = ?",
                (valid_to, reason, edge_id),
            )
            self._record_change(
                edge.project_id,
                kind="edge.closed",
                target_kind="edge",
                target_id=edge_id,
                detail={"reason": reason, "valid_to": valid_to},
            )
        return self.get_edge(edge_id)

    def get_edge(self, edge_id: str) -> Edge:
        row = self.store.query_one("SELECT * FROM l3_edges WHERE edge_id = ?", (edge_id,))
        if row is None:
            raise NotFoundError(f"edge {edge_id} not found")
        return Edge.from_row(row)

    def _edge_by_triple(self, head_id: str, relation: str, tail_id: str) -> Edge | None:
        row = self.store.query_one(
            "SELECT * FROM l3_edges WHERE head_id = ? AND relation = ? AND tail_id = ?",
            (head_id, relation, tail_id),
        )
        return Edge.from_row(row) if row else None

    def edges_of(
        self,
        entity_id: str,
        *,
        relation: str | None = None,
        direction: Literal["out", "in", "both"] = "both",
        current_only: bool = True,
        at: str | None = None,
        include_disputed: bool = True,
    ) -> list[Edge]:
        """Edges incident to an entity, honouring the dual-temporal view."""
        clauses = []
        params: list[Any] = []
        if direction == "out":
            clauses.append("head_id = ?")
            params.append(entity_id)
        elif direction == "in":
            clauses.append("tail_id = ?")
            params.append(entity_id)
        else:
            clauses.append("(head_id = ? OR tail_id = ?)")
            params.extend([entity_id, entity_id])
        if relation:
            clauses.append("relation = ?")
            params.append(relation)
        if current_only:
            clauses.append("valid_to IS NULL")
        if at:
            # "What was believed/true at instant `at`" — valid interval contains it,
            # and we had recorded it by then.
            clauses.append("valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) AND recorded_at <= ?")
            params.extend([at, at, at])
        if not include_disputed:
            clauses.append("json_extract(meta, '$.disputed') IS NULL")
        sql = "SELECT * FROM l3_edges WHERE " + " AND ".join(clauses)
        return [Edge.from_row(r) for r in self.store.query(sql, params)]

    def neighbors(self, entity_ids: Sequence[str], *, current_only: bool = True) -> list[Edge]:
        if not entity_ids:
            return []
        marks = ",".join("?" * len(entity_ids))
        extra = " AND valid_to IS NULL" if current_only else ""
        rows = self.store.query(
            f"SELECT * FROM l3_edges WHERE (head_id IN ({marks}) OR tail_id IN ({marks})){extra}",
            [*entity_ids, *entity_ids],
        )
        return [Edge.from_row(r) for r in rows]

    # ══ validation helpers ══════════════════════════════════════════════
    def _would_cycle(self, project_id: str, head_id: str, relation: str, tail_id: str) -> bool:
        """True if adding ``head -[relation]-> tail`` closes a cycle in acyclic relations."""
        if head_id == tail_id:
            return True
        spec = self.relation_spec(relation)
        acyclic_relations = [name for name, s in self._registry.items() if s.acyclic]
        if spec is not None and spec.inverse:
            acyclic_relations.append(spec.inverse)
        if not acyclic_relations:
            return False
        marks = ",".join("?" * len(acyclic_relations))
        # Walk forward from `tail`; reaching `head` means head -> tail closes a loop.
        frontier = [tail_id]
        seen = {tail_id}
        rows = self.store.query(
            f"SELECT head_id, tail_id FROM l3_edges WHERE project_id = ? AND valid_to IS NULL "
            f"AND relation IN ({marks})",
            (project_id, *acyclic_relations),
        )
        adjacency: dict[str, list[str]] = {}
        for row in rows:
            adjacency.setdefault(row["head_id"], []).append(row["tail_id"])
        while frontier:
            node = frontier.pop()
            for nxt in adjacency.get(node, []):
                if nxt == head_id:
                    return True
                if nxt not in seen:
                    seen.add(nxt)
                    frontier.append(nxt)
        return False

    def _strengthen_edge(self, edge: Edge, fact: FactInput) -> None:
        """A repeated claim raises confidence and accumulates evidence.

        Confidence only moves when the repeat brings *new* support: an episode
        the edge has not seen, or a fresh observation context. Repeating the
        same claim with no new evidence must not ratchet a hallucinated fact up
        to 0.99, which would defeat the "low evidence cannot override high
        evidence" rule in ``_resolve_conflict``.
        """
        meta = dict(edge.meta or {})
        known = list(meta.get("episode_ids", []))
        incoming = [e for e in (fact.episode_ids or []) if e not in known]
        observations = list(meta.get("observations", []))
        new_observation = bool(fact.observed_context) and fact.observed_context not in observations
        if new_observation:
            observations.append(fact.observed_context)
            observations = observations[-10:]
        if not incoming and not new_observation:
            # Same claim, same evidence: nothing to record.
            return
        episodes = list(dict.fromkeys([*known, *incoming]))
        new_confidence = min(0.99, edge.confidence + 0.02)
        meta["episode_ids"] = episodes
        meta["observations"] = observations
        with self.store.transaction():
            self.store.execute(
                "UPDATE l3_edges SET confidence = ?, meta = ? WHERE edge_id = ?",
                (new_confidence, json_dumps(meta), edge.edge_id),
            )
            if incoming:
                change_id = self._record_change(
                    edge.project_id,
                    kind="edge.strengthened",
                    target_kind="edge",
                    target_id=edge.edge_id,
                    detail={"confidence": new_confidence, "episodes": incoming},
                )
                self._link_episodes(change_id, incoming)

    def _evidence_strength(self, episode_ids: Sequence[str], confidence: float) -> float:
        if not episode_ids or self.episodic is None:
            return confidence
        strength = self.episodic.evidence_strength(episode_ids)
        return confidence * (0.25 + strength)

    def _edge_strength(self, edge: Edge) -> tuple[float, str]:
        episode_ids = list(edge.meta.get("episode_ids", []))
        strength = self._evidence_strength(episode_ids, edge.confidence)
        return strength, edge.recorded_at or ""

    # ══ changes / traceability ══════════════════════════════════════════
    def _record_change(
        self,
        project_id: str,
        *,
        kind: str,
        target_kind: str,
        target_id: str,
        detail: dict[str, Any],
        reason: str | None = None,
        anchor_id: str | None = None,
        recorded_at: str | None = None,
    ) -> str:
        change_id = new_change_id()
        self.store.execute(
            """INSERT INTO l3_changes
               (change_id, project_id, kind, target_kind, target_id, detail, reason, anchor_id, recorded_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                change_id,
                project_id,
                kind,
                target_kind,
                target_id,
                json_dumps(detail),
                reason,
                anchor_id,
                recorded_at or to_iso(utcnow()),
            ),
        )
        return change_id

    def _link_episodes(self, change_id: str, episode_ids: Sequence[str], role: str = "evidence") -> None:
        if not episode_ids:
            return
        self.store.executemany(
            "INSERT OR IGNORE INTO l3_change_sources(change_id, episode_id, role) VALUES (?,?,?)",
            [(change_id, ep, role) for ep in episode_ids if ep],
        )

    def history(
        self,
        target_id: str | None = None,
        *,
        limit: int = 50,
        involved_entity_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Audit trail, oldest first.

        With ``target_id``: changes to that entity or edge. With
        ``involved_entity_id``: changes to any edge touching that entity
        (answer "what happened around this node", not just "what changed on it").
        """
        if involved_entity_id and not target_id:
            edge_ids = [
                r["edge_id"]
                for r in self.store.query(
                    "SELECT edge_id FROM l3_edges WHERE head_id = ? OR tail_id = ?",
                    (involved_entity_id, involved_entity_id),
                )
            ]
            targets = [involved_entity_id, *edge_ids]
            marks = ",".join("?" * len(targets))
            rows = self.store.query(
                f"SELECT * FROM l3_changes WHERE target_id IN ({marks}) "
                "ORDER BY recorded_at ASC LIMIT ?",
                (*targets, limit),
            )
        else:
            rows = self.store.query(
                "SELECT * FROM l3_changes WHERE target_id = ? ORDER BY recorded_at ASC LIMIT ?",
                (target_id, limit),
            )
        out: list[dict[str, Any]] = []
        for row in rows:
            evidence = [
                r["episode_id"]
                for r in self.store.query(
                    "SELECT episode_id FROM l3_change_sources WHERE change_id = ?", (row["change_id"],)
                )
            ]
            out.append(
                {
                    "change_id": row["change_id"],
                    "kind": row["kind"],
                    "detail": json_loads(row["detail"], {}),
                    "reason": row["reason"],
                    "recorded_at": row["recorded_at"],
                    "anchor_id": row["anchor_id"],
                    "episode_ids": evidence,
                }
            )
        return out

    def provenance(self, target_id: str, *, include_edges: bool = True) -> dict[str, Any]:
        """Three-level trace: L3 change -> L2 episode -> L0 anchor.

        For an entity, the trace includes the changes of every edge incident to
        it — an entity's beliefs live on its edges, so citing only the entity's
        own creation row would report empty provenance for every established
        node.
        """
        episodes: dict[str, list[str]] = {}
        anchors: set[str] = set()
        targets = [target_id]
        if include_edges and self.store.query_one(
            "SELECT 1 FROM l3_entities WHERE entity_id = ?", (target_id,)
        ):
            targets += [
                r["edge_id"]
                for r in self.store.query(
                    "SELECT edge_id FROM l3_edges WHERE head_id = ? OR tail_id = ?",
                    (target_id, target_id),
                )
            ]
        marks = ",".join("?" * len(targets))
        for row in self.store.query(
            "SELECT s.episode_id, c.target_id FROM l3_change_sources s "
            "JOIN l3_changes c ON c.change_id = s.change_id "
            f"WHERE c.target_id IN ({marks})",
            targets,
        ):
            role = "evidence" if row["target_id"] == target_id else "edge_evidence"
            episodes.setdefault(row["episode_id"], []).append(role)
        if self.episodic is not None:
            for ep in self.episodic.by_ids(episodes).values():
                if ep.anchor_id:
                    anchors.add(ep.anchor_id)
        edge_row = self.store.query_one(
            "SELECT anchor_id, meta FROM l3_edges WHERE edge_id = ?", (target_id,)
        )
        if edge_row is not None:
            if edge_row["anchor_id"]:
                anchors.add(edge_row["anchor_id"])
            meta = json_loads(edge_row["meta"], {}) or {}
            for ep_id in meta.get("episode_ids", []):
                episodes.setdefault(ep_id, []).append("edge")
        for row in self.store.query(
            f"SELECT anchor_id FROM l3_changes WHERE target_id IN ({marks}) AND anchor_id IS NOT NULL",
            targets,
        ):
            anchors.add(row["anchor_id"])
        return {
            "target_id": target_id,
            "episode_ids": sorted(episodes),
            "anchor_ids": sorted(a for a in anchors if a),
        }

    # ══ write-path evidence retraction (epistemics) ══════════════════════
    def retract_dependents(self, launched_skill: str, missing_tools: Sequence[str]) -> list[dict[str, Any]]:
        """Close beliefs whose recorded observation no longer holds.

        A belief written from L4 launch context (``observed_context.skill``)
        is only as good as the configuration it was observed in. When that
        skill is retired (or its tools disappear), the observation is stale and
        the belief must stop being asserted — recorded as a closed edge with a
        ``retracted`` reason rather than deleted.
        """
        missing = {t for t in missing_tools}
        rows = self.store.query(
            "SELECT * FROM l3_edges WHERE valid_to IS NULL AND json_extract(meta, '$.observed_context.skill') = ?",
            (launched_skill,),
        )
        retracted: list[dict[str, Any]] = []
        now = to_iso(utcnow())
        with self.store.transaction():
            for row in rows:
                edge = Edge.from_row(row)
                ctx = (edge.meta.get("observed_context") or {})
                ctx_tools = set(ctx.get("tools") or [])
                if missing and not (ctx_tools & missing):
                    continue
                self.store.execute(
                    "UPDATE l3_edges SET valid_to = ?, meta = json_set(meta, '$.closed_reason', ?) WHERE edge_id = ?",
                    (now, "retracted_observation_stale", edge.edge_id),
                )
                self._record_change(
                    edge.project_id,
                    kind="edge.closed",
                    target_kind="edge",
                    target_id=edge.edge_id,
                    detail={"reason": "retracted_observation_stale", "skill": launched_skill},
                    reason="retracted_observation_stale",
                )
                retracted.append({"edge_id": edge.edge_id, "head_id": edge.head_id, "relation": edge.relation})
        return retracted

    # ══ bulk read helpers used by retrieval/communities ═════════════════
    def load_subgraph(
        self, project_ids: Sequence[str], *, current_only: bool = True
    ) -> tuple[dict[str, Entity], list[Edge]]:
        if not project_ids:
            return {}, []
        marks = ",".join("?" * len(project_ids))
        entities = {
            e.entity_id: e
            for e in (
                self._entity_from_row(r)
                for r in self.store.query(
                    f"SELECT * FROM l3_entities WHERE project_id IN ({marks})", list(project_ids)
                )
            )
        }
        extra = " AND valid_to IS NULL" if current_only else ""
        edges = [
            Edge.from_row(r)
            for r in self.store.query(
                f"SELECT * FROM l3_edges WHERE project_id IN ({marks}){extra}", list(project_ids)
            )
        ]
        return entities, edges

    def entity_by_ordinals(self, ordinals: Iterable[int]) -> dict[int, Entity]:
        ords = list(ordinals)
        if not ords:
            return {}
        marks = ",".join("?" * len(ords))
        return {
            int(r["ord"]): self._entity_from_row(r)
            for r in self.store.query(f"SELECT * FROM l3_entities WHERE ord IN ({marks})", ords)
        }

    # ══ stats ═══════════════════════════════════════════════════════════
    def stats(self, project_id: str | None = None) -> dict[str, Any]:
        where = "WHERE project_id = ?" if project_id else ""
        params: tuple[Any, ...] = (project_id,) if project_id else ()
        entities = int(self.store.scalar(f"SELECT count(*) FROM l3_entities {where}", params, 0))
        current = int(
            self.store.scalar(
                f"SELECT count(*) FROM l3_edges {where}{' AND' if where else 'WHERE'} valid_to IS NULL",
                params,
                0,
            )
        )
        historical = int(self.store.scalar(f"SELECT count(*) FROM l3_edges {where}", params, 0))
        disputed = int(
            self.store.scalar(
                f"SELECT count(*) FROM l3_edges {where}{' AND' if where else 'WHERE'} "
                "json_extract(meta, '$.disputed') = 1",
                params,
                0,
            )
        )
        total_changes = int(self.store.scalar(f"SELECT count(*) FROM l3_changes {where}", params, 0))
        rejected = int(
            self.store.scalar(
                f"SELECT count(*) FROM l3_changes {where}{' AND' if where else 'WHERE'} kind = 'edge.rejected'",
                params,
                0,
            )
        )
        # Every conflict leaves one of two records: ``edge.disputed`` when the
        # defer policy kept both sides, ``edge.rejected`` when evidence kept the
        # incumbent. Counting only rejections made a knowledge base full of
        # deferred disputes report a zero conflict rate.
        conflicts = int(
            self.store.scalar(
                f"SELECT count(*) FROM l3_changes {where}{' AND' if where else 'WHERE'} "
                "kind IN ('edge.rejected', 'edge.disputed')",
                params,
                0,
            )
        )
        return {
            "entities": entities,
            "edges_current": current,
            "edges_total": historical,
            "edges_closed": historical - current,
            "edges_disputed": disputed,
            "changes": total_changes,
            "conflicts": conflicts,
            "conflict_rate": (conflicts / total_changes) if total_changes else 0.0,
        }

    def _embed(self, text: str) -> list[float]:
        if self._cache is not None:
            return self._cache.embed_one(text)
        return self.embeddings.embed_one(text)


def normalize_relation(relation: str) -> str:
    return (relation or "").strip().lower().replace(" ", "_").replace("-", "_")


def _dedupe_aliases(name: str, aliases: Iterable[str]) -> list[str]:
    norms = {normalize_name(name)}
    out: list[str] = []
    for alias in aliases:
        norm = normalize_name(alias)
        if not norm or norm in norms:
            continue
        norms.add(norm)
        out.append(norm)
    return out[:20]


def edge_signature(head: str, relation: str, tail: str) -> str:
    return hashlib.sha1(f"{head}|{relation}|{tail}".encode("utf-8")).hexdigest()[:16]