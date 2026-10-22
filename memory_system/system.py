"""The memory system facade.

`MemorySystem` is the only class a host integration needs to know about. It
owns the store, wires the layers together, and exposes use-case-level methods.
The thin DSH adapter (``memory_system.adapters.dsh``) translates tool calls into
these methods; a different Agent runtime writes its own adapter against the
same methods (see DESIGN.md §Portability).

Layering note: L2 <-> L3 is a genuine cycle at the *behaviour* level (L3 edges
cite L2 episodes as evidence; L2 episodes are written with L3 context), but not
at the construction level — :class:`EpisodicMemory` and :class:`SemanticMemory`
are created independently and cross-linked afterwards. Keeping them
independently constructible is what makes them testable in isolation.
"""

from __future__ import annotations

import dataclasses
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal, Sequence

from .anchors import Anchor, AnchorRegistry
from .cache import EmbeddingCache
from .communities import CommunityIndex
from .config import L2Config, L3Config, L4Config, MemoryConfig
from .embedding import EmbeddingProvider, ProbeResult, build_checked_provider, build_provider
from .errors import MemoryError, NotFoundError, ValidationError
from .governance import Promotion, PromotionService, SkillArchive
from .l2 import Episode, EpisodeHit, EpisodicMemory
from .l3 import Edge, EdgeDecision, Entity, FactInput, SemanticMemory
from .l4 import Disclosure, ScopeView, Skill, SkillDefinition
from .maintenance import Maintenance, TaskReport
from .maturity import MaturityEvidence, TrajectoryStep, TrajectoryStore
from .retrieval import Retriever, SearchOptions, SearchResult
from .skills import CapacityError, SkillContext, SkillMatch, SkillRegistry
from .storage import Store, to_iso, utcnow
from .text import prewarm


@dataclass(slots=True)
class ProjectInfo:
    project_id: str
    display_name: str | None = None
    org_id: str | None = None
    root_path: str | None = None
    created_at: str = ""
    last_seen_at: str = ""


class MemorySystem:
    """One instance per database. Thread-safe (delegates to :class:`Store`)."""

    def __init__(
        self,
        config: MemoryConfig | None = None,
        *,
        embedding: EmbeddingProvider | None = None,
        store: Store | None = None,
    ) -> None:
        self.config = config or MemoryConfig()
        if embedding is not None:
            provider, probe = embedding, ProbeResult(ok=True, provider=embedding.name, dim=embedding.dim)
        else:
            provider, probe = build_checked_provider(self.config.embedding)
        self.probe = probe
        target_dim = provider.dim
        if self.config.embedding.dim != target_dim:
            # The probe may have degraded us to the 256-dim hash backend; the
            # vector index is sized from config, so it must be corrected before
            # the store opens or every write would fail on a width mismatch.
            self.config = self.config.with_(
                embedding=dataclasses.replace(self.config.embedding, dim=target_dim)
            )
        self.store = store or Store(self.config)
        if probe.degraded:
            # Refuse to mix vector spaces on a database that already has rows:
            # down-weighting is reversible, a corrupted similarity space is not.
            if self._store_has_vectors():
                raise MemoryError(
                    "embedding endpoint unavailable and the database already contains vectors; "
                    "refusing to degrade to hash embeddings (would mix incomparable spaces). "
                    f"Cause: {probe.error}"
                )
        if provider.dim != self.store.vectors.dim:
            hint = ""
            if self.config.embedding.preset or self.config.embedding.provider == "http":
                hint = " — the configured model's dimension must match the database"
            raise MemoryError(
                f"embedding dim {provider.dim} != database dim {self.store.vectors.dim}; "
                "switching embedding models requires re-embedding every row" + hint
            )
        self.embeddings = EmbeddingCache(provider)
        self.store.set_meta("embedding_fingerprint", provider.fingerprint)
        # Move first-call costs (CJK segmenter dictionary) to open time.
        self.tokenizer_ready = prewarm(self.config.lexical.tokenizer)

        self.anchors = AnchorRegistry(self.store)
        self.l2 = EpisodicMemory(self.store, self.config, self.embeddings, embedding_cache=self.embeddings)
        self.l3 = SemanticMemory(
            self.store, self.config, self.embeddings, embedding_cache=self.embeddings, episodic=self.l2
        )
        self.retriever = Retriever(
            self.store, self.config, self.embeddings, episodic=self.l2, semantic=self.l3,
            embedding_cache=self.embeddings,
        )
        self.communities = CommunityIndex(
            self.store, self.l3, min_size=self.config.l3.community_min_size
        )
        self.skills = SkillRegistry(
            self.store, self.config.l4, self.embeddings, embedding_cache=self.embeddings
        )
        self.trajectories = TrajectoryStore(self.store, self.config.l4, self.skills)
        self.archive = SkillArchive(
            self.store, self.config.l4, self.embeddings, embedding_cache=self.embeddings
        )
        # Any path that publishes a skill (user accept, review accept, promotion)
        # must also land it in the global backup pool.
        self.skills.on_activate = lambda skill: self.archive.snapshot(skill, status="active")
        self.promotions = PromotionService(self.store, self.config.l4, self.skills, self.archive)
        self.maintenance = Maintenance(
            self.store,
            self.config,
            episodic=self.l2,
            semantic=self.l3,
            registry=self.skills,
            trajectories=self.trajectories,
            communities=self.communities,
            archive=self.archive,
            promotions=self.promotions,
        )

    # ══ lifecycle ═══════════════════════════════════════════════════════
    def _store_has_vectors(self) -> bool:
        """True if any layer already holds embeddings."""
        for kind in ("l2", "l3_entity", "l4_skill", "l4_archive"):
            try:
                if self.store.vectors.count(kind):
                    return True
            except Exception:  # noqa: BLE001 - absent table means empty
                continue
        return False

    def close(self) -> None:
        self.store.close()

    def change_embedding(
        self,
        provider: EmbeddingProvider,
        *,
        allow_redimension: bool = False,
    ) -> dict[str, Any]:
        """Switch this database to a different embedding model, in place.

        Every stored vector is recomputed so the whole corpus lives in one
        vector space. Refuses a dimension change unless ``allow_redimension``
        is set, because the vector index is fixed-width on disk.
        """
        from .migrate import reembed

        report = reembed(self.store, provider, allow_redimension=allow_redimension)
        self.embeddings = EmbeddingCache(provider)
        # Rebind every layer that captured the old cache. Each layer keeps two
        # aliases for the same object, so both must be replaced.
        for owner in (self.l2, self.l3, self.retriever, self.skills, self.archive):
            for name in ("embeddings", "_cache"):
                setattr(owner, name, self.embeddings)
        self.probe = ProbeResult(ok=True, provider=provider.name, dim=provider.dim)
        payload = report.to_dict()
        if report.errors:
            payload["warning"] = "some layers failed to re-embed; run again to finish"
        return payload

    def __enter__(self) -> "MemorySystem":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @classmethod
    def open(cls, home: Path | str, **config_overrides: Any) -> "MemorySystem":
        return cls(MemoryConfig.for_home(home, **config_overrides))

    # ══ projects ════════════════════════════════════════════════════════
    def ensure_project(
        self,
        project_id: str,
        *,
        display_name: str | None = None,
        org_id: str | None = None,
        root_path: str | None = None,
    ) -> ProjectInfo:
        """Idempotently register a project and refresh ``last_seen_at``."""
        if not project_id:
            raise ValidationError("project_id is required")
        now = to_iso(utcnow())
        with self.store.transaction():
            self.store.execute(
                """INSERT INTO projects(project_id, display_name, org_id, root_path, created_at, last_seen_at, stats)
                   VALUES (?,?,?,?,?,?,'{}')
                   ON CONFLICT(project_id) DO UPDATE SET
                     display_name = COALESCE(excluded.display_name, projects.display_name),
                     org_id = COALESCE(excluded.org_id, projects.org_id),
                     root_path = COALESCE(excluded.root_path, projects.root_path),
                     last_seen_at = excluded.last_seen_at""",
                (project_id, display_name, org_id, root_path, now, now),
            )
        return self.get_project(project_id)

    def get_project(self, project_id: str) -> ProjectInfo:
        row = self.store.query_one("SELECT * FROM projects WHERE project_id = ?", (project_id,))
        if row is None:
            raise NotFoundError(f"project {project_id} not found")
        return ProjectInfo(
            project_id=row["project_id"],
            display_name=row["display_name"],
            org_id=row["org_id"],
            root_path=row["root_path"],
            created_at=row["created_at"],
            last_seen_at=row["last_seen_at"],
        )

    def view(self, project_id: str, *, org_id: str | None = None) -> ScopeView:
        """Scope view for a project; falls back to the registered org."""
        if org_id is None:
            row = self.store.query_one("SELECT org_id FROM projects WHERE project_id = ?", (project_id,))
            org_id = row["org_id"] if row else None
        return ScopeView(project_id=project_id, org_id=org_id)

    def list_projects(self) -> list[ProjectInfo]:
        return [
            ProjectInfo(
                project_id=r["project_id"],
                display_name=r["display_name"],
                org_id=r["org_id"],
                root_path=r["root_path"],
                created_at=r["created_at"],
                last_seen_at=r["last_seen_at"],
            )
            for r in self.store.query("SELECT * FROM projects ORDER BY last_seen_at DESC")
        ]

    # ══ write: one thing happened ═══════════════════════════════════════
    def remember(
        self,
        *,
        project_id: str,
        summary: str,
        importance: float | None = None,
        event_type: str | None = None,
        participants: Sequence[str] | None = None,
        outcome: str | None = None,
        anchor: Anchor | str | None = None,
        session_key: str | None = None,
        content_key: str | None = None,
        meta: dict[str, Any] | None = None,
        facts: Sequence[FactInput | dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """The single high-level write used by both agents and humans.

        One call = one episode + zero or more graph facts that cite it. Doing
        both together is what makes provenance complete: the graph never holds
        a claim without an L2 episode behind it.
        """
        self.ensure_project(project_id)
        anchor_id = anchor.anchor_id if isinstance(anchor, Anchor) else anchor
        if anchor_id is None and session_key:
            latest = self.anchors.latest(session_key)
            anchor_id = latest.anchor_id if latest else None
        episode = self.l2.add(
            project_id=project_id,
            summary=summary,
            importance=importance,
            event_type=event_type,
            participants=participants,
            outcome=outcome,
            session_key=session_key,
            anchor_id=anchor_id,
            content_key=content_key,
            meta=meta,
        )
        decisions: list[dict[str, Any]] = []
        for raw in facts or []:
            fact = raw if isinstance(raw, FactInput) else FactInput(**raw)
            if not fact.episode_ids:
                fact.episode_ids = [episode.memory_id]
            decision = self.l3.add_fact(project_id, fact)
            decisions.append(
                {
                    "status": decision.status,
                    "reason": decision.reason,
                    "edge_id": decision.edge.edge_id if decision.edge else None,
                    "conflict": decision.conflict,
                }
            )
        return {
            "memory_id": episode.memory_id,
            "anchor_id": episode.anchor_id,
            "facts": decisions,
        }

    # ══ read: recall ════════════════════════════════════════════════════
    def recall(
        self,
        query: str,
        *,
        project_id: str,
        org_id: str | None = None,
        mode: Literal["auto", "fast", "deep"] = "auto",
        k_l2: int = 6,
        k_l3: int = 8,
        include_dormant: bool = False,
        as_of: str | None = None,
        explain: bool = False,
    ) -> SearchResult:
        view = self.view(project_id, org_id=org_id)
        options = SearchOptions(
            project_ids=[project_id],
            mode=mode,
            k_l2=k_l2,
            k_l3=k_l3,
            include_dormant=include_dormant,
            as_of=as_of,
            explain=explain,
        )
        return self.retriever.search(query, options)

    def explain(self, *, edge_id: str | None = None, memory_id: str | None = None) -> dict[str, Any]:
        """Provenance chain for one belief or recollection: L3 -> L2 -> L0."""
        if edge_id:
            edge = self.l3.get_edge(edge_id)
            head = self.l3.get_entity(edge.head_id)
            tail = self.l3.get_entity(edge.tail_id)
            provenance = self.l3.provenance(edge_id)
            episodes = self.l2.by_ids(provenance["episode_ids"])
            return {
                "kind": "edge",
                "fact": f"{head.name} --{edge.relation}--> {tail.name}",
                "confidence": edge.confidence,
                "valid_from": edge.valid_from,
                "valid_to": edge.valid_to,
                "disputed": edge.disputed,
                "history": self.l3.history(edge_id),
                "episodes": [ep.to_row() for ep in episodes.values()],
                "anchors": [a.to_dict() for a in (self.anchors.get(x) for x in provenance["anchor_ids"]) if a],
            }
        if memory_id:
            episode = self.l2.get(memory_id)
            anchor = self.anchors.get(episode.anchor_id)
            return {
                "kind": "episode",
                "episode": episode.to_row(),
                "anchor": anchor.to_dict() if anchor else None,
            }
        raise ValidationError("explain() needs edge_id or memory_id")

    # ══ L4: skills ══════════════════════════════════════════════════════
    def prepare_turn(
        self,
        *,
        project_id: str,
        user_text: str,
        available_tools: Sequence[str] = (),
        available_entities: Sequence[str] = (),
        intent_labels: Sequence[str] = (),
        environment: dict[str, Any] | None = None,
        session_key: str | None = None,
        turn: int | None = None,
        loaded_skill_ids: Sequence[str] = (),
        record_launch: bool = True,
    ) -> Disclosure:
        """Everything L4 injects for one user prompt, within the token budget."""
        return self.skills.prepare_turn(
            view=self.view(project_id),
            user_text=user_text,
            context=SkillContext(
                tools=frozenset(available_tools),
                entities=frozenset(available_entities),
                environment=dict(environment or {}),
                session_key=session_key,
                turn=turn,
                project_id=project_id,
            ),
            intent_labels=intent_labels,
            loaded_skill_ids=loaded_skill_ids,
            record_launch=record_launch,
        )

    def add_skill(
        self,
        *,
        project_id: str,
        definition: SkillDefinition | dict[str, Any],
        name: str,
        scope_kind: Literal["project", "org", "sys"] = "project",
        status: Literal["candidate", "draft", "active"] = "active",
        ns: Literal["sys", "user", "ext"] = "user",
        check_archive: bool = True,
    ) -> dict[str, Any]:
        """Create a skill, consulting the archive first to avoid duplicates."""
        from .l4 import coerce_definition

        definition_obj = coerce_definition(definition)
        verdict, hit = ("new", None)
        if check_archive:
            verdict, hit = self.archive.classify(definition_obj.search_text())
        result: dict[str, Any] = {"archive_verdict": verdict}
        if verdict == "similar" and hit is not None:
            result["similar_archive"] = hit.to_dict()
        if status == "active":
            # Activation is capacity-checked inside the registry.
            pass
        skill = self.skills.create(
            view=self.view(project_id),
            definition=definition_obj,
            name=name,
            scope_kind=scope_kind,
            ns=ns,
            status=status,
            unaudited=False,
            activation_reason="user_added",
        )
        if status == "active":
            # Every published skill enters the global backup pool immediately:
            # creation-time reuse must be able to see the skill from another
            # project, and a deleted project must not take its procedures with it.
            self.archive.snapshot(skill, status="active")
        if verdict == "similar" and hit is not None:
            self.archive.mark_similar(hit, skill.skill_id)
        result["skill"] = skill.to_dict()
        return result

    def load_skill(self, *, project_id: str, skill: str) -> str:
        """Level-3 disclosure: the full definition text."""
        return self.skills.level3_definition(self.view(project_id), skill)

    def record_skill_run(
        self,
        *,
        project_id: str,
        skill: str,
        outcome: str,
        success: bool | None = None,
        steps: Sequence[str] = (),
        tool_names: Sequence[str] = (),
        error: str | None = None,
        deviation: str | None = None,
        duration_ms: int | None = None,
        session_key: str | None = None,
        anchor_id: str | None = None,
        summary: str | None = None,
    ) -> dict[str, Any]:
        """Record an execution outcome; optionally mirror it into L2."""
        from .skills import RunRecord

        skill_obj = self.skills.find(skill, self.view(project_id))
        ok = success if success is not None else outcome.lower() in ("success", "ok", "completed")
        episode_id = None
        if summary:
            episode = self.l2.add(
                project_id=project_id,
                summary=summary,
                importance=0.6,
                event_type="skill-run",
                outcome=outcome,
                session_key=session_key,
                anchor_id=anchor_id,
                content_key=f"skill-run:{skill_obj.skill_id}:{anchor_id or uuid.uuid4().hex[:8]}",
            )
            episode_id = episode.memory_id
        run_id = self.skills.record_run(
            skill_obj.skill_id,
            RunRecord(
                skill_id=skill_obj.skill_id,
                outcome=outcome,
                success=ok,
                steps=list(steps),
                tool_names=list(tool_names),
                duration_ms=duration_ms,
                error=error,
                deviation=deviation,
                project_id=project_id,
                session_key=session_key,
                anchor_id=anchor_id,
                episode_id=episode_id,
            ),
        )
        return {
            "run_id": run_id,
            "success": ok,
            "success_rate": round(self.skills.success_rate(skill_obj.skill_id), 3),
            "episode_id": episode_id,
        }

    def capture_trajectory(
        self,
        *,
        project_id: str,
        steps: Sequence[TrajectoryStep | dict[str, Any]],
        outcome: str = "success",
        success: bool = True,
        session_key: str | None = None,
        intent_label: str | None = None,
        preconditions: dict[str, Any] | None = None,
        launch_context: dict[str, Any] | None = None,
        episode_ids: Sequence[str] = (),
        anchor_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Store one raw execution trace for offline maturity evaluation."""
        parsed = [
            s if isinstance(s, TrajectoryStep) else TrajectoryStep(**s) for s in steps
        ]
        traj = self.trajectories.record(
            project_id=project_id,
            steps=parsed,
            outcome=outcome,
            success=success,
            session_key=session_key,
            intent_label=intent_label,
            preconditions=preconditions,
            launch_context=launch_context,
            episode_ids=episode_ids,
            anchor_id=anchor_id,
        )
        return None if traj is None else {"traj_id": traj.traj_id, "signature": traj.signature}

    def review_candidates(self, *, project_id: str) -> list[dict[str, Any]]:
        """Drafted-but-unpublished skills, for the user review UI."""
        pending = self.trajectories.pending_candidates(project_id)
        for item in pending:
            try:
                skill = self.skills.get(item["skill_id"]) if item.get("skill_id") else None
            except NotFoundError:
                skill = None
            if skill is not None:
                item["skill"] = skill.to_dict()
                item["preview"] = self.skills.level3_definition(self.view(project_id), skill.skill_id)
        return pending

    def accept_candidate(self, *, project_id: str, skill_id: str) -> Skill:
        return self.skills.activate(skill_id, reason="user_review")
    def reject_candidate(self, *, project_id: str, skill_id: str, note: str | None = None) -> Skill:
        self.store.execute(
            "UPDATE l4_candidates SET status='rejected', last_reason=?, updated_at=? WHERE skill_id=?",
            (note or "user_rejected", to_iso(utcnow()), skill_id),
        )
        return self.skills.retire(skill_id, reason="user_rejected")

    # ══ L4: governance ══════════════════════════════════════════════════
    def pending_promotions(self) -> list[dict[str, Any]]:
        return [p.to_dict() for p in self.promotions.list_pending()]

    def decide_promotion(
        self,
        promotion_id: str,
        *,
        accept: bool,
        project_id: str,
        note: str | None = None,
        name: str | None = None,
    ) -> dict[str, Any]:
        if not accept:
            promotion = self.promotions.reject(promotion_id, note=note)
            return {"status": promotion.status}
        skill = self.promotions.accept(
            promotion_id, view=self.view(project_id), name=name, note=note
        )
        return {"status": "accepted", "skill": skill.to_dict()}

    def archive_project(self, project_id: str) -> dict[str, Any]:
        """Snapshot every visible skill, then flag them orphaned.

        Used when a project is deleted: the procedures survive in the global
        archive and can be referenced from a future project.
        """
        skills = self.skills.visible(self.view(project_id), include_cold=True, include_retired=False)
        archived = [self.archive.snapshot(s, status="active") for s in skills]
        orphaned = self.archive.mark_orphaned(project_id)
        return {"snapshot_archive_ids": archived, "orphaned": orphaned}

    # ══ maintenance / observability ═════════════════════════════════════
    def run_maintenance(
        self, *, project_ids: list[str] | None = None, tasks: list[str] | None = None, force: bool = False
    ) -> list[TaskReport]:
        return self.maintenance.run_once(project_ids=project_ids, tasks=tasks, force=force)

    def stats(self, project_id: str | None = None) -> dict[str, Any]:
        return {
            "embedding": {
                "fingerprint": self.embeddings.fingerprint,
                "cache": self.embeddings.stats(),
                "vectors": self.store.vectors.health(),
            },
            "anchors": {"count": self.anchors.count()},
            "l2": self.l2.stats(project_id),
            "l3": self.l3.stats(project_id),
            "l4": self.skills.stats(self.view(project_id)) if project_id else self.skills.stats(),
            "archive": self.archive.stats(),
            "promotions": self.promotions.stats(),
            "maintenance": self.maintenance.status(),
            "schema_version": self.store.get_meta("schema_version"),
        }

    # ══ convenience re-exports ══════════════════════════════════════════
    def recent_episodes(self, project_id: str, limit: int = 10) -> list[Episode]:
        return self.l2.recent([project_id], limit=limit)

    def entities(self, project_id: str) -> list[Entity]:
        rows = self.store.query(
            "SELECT * FROM l3_entities WHERE project_id = ? ORDER BY name", (project_id,)
        )
        return [self.l3._entity_from_row(r) for r in rows]

    def edges(self, project_id: str, *, current_only: bool = True) -> list[Edge]:
        extra = " AND valid_to IS NULL" if current_only else ""
        return [
            Edge.from_row(r)
            for r in self.store.query(
                f"SELECT * FROM l3_edges WHERE project_id = ?{extra}", (project_id,)
            )
        ]

    def forget_edge(self, edge_id: str, *, reason: str = "user_forget") -> Edge:
        """Soft forget: closes the validity interval, keeps the history."""
        return self.l3.close_edge(edge_id, reason=reason)