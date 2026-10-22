"""L4 — the runtime skill registry.

Lifecycle (design §6.3, §6.4)::

    candidate ──user accept──> active ──retire──> retired
        │                       │  ▲
        │                       │  └── revive ──
        └──merge into another──>  (superseded, kept for history)
    a skill can also be versioned in place: version+1, supersedes=[old version id]

Three index levels back matching (design §6.2)::

    intent label inverted index (O(1))  ->  precondition boolean filter  ->  semantic rerank

with the composite score fixed by the design::

    0.4*intent + 0.3*prereq + 0.2*semantic + 0.1*success_rate

Capacity ceilings are enforced *before* an activation, and when a project hits
its cap the registry raises :class:`CapacityError` rather than silently
evicting: eviction of a user-blessed skill is a governance decision, not a
side effect of an agent choosing to learn something.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Sequence

from .config import L4Config
from .embedding import EmbeddingProvider
from .errors import BudgetError, MemoryError, NotFoundError, ValidationError
from .l4 import (
    SCOPE_RANK,
    BudgetPlanner,
    Disclosure,
    ScopeView,
    Skill,
    SkillDefinition,
    coerce_definition,
    definition_hash,
    new_skill_id,
    qualified,
    render_detail,
    render_full,
    render_index_line,
    scope_predicate,
)
from .storage import Store, json_dumps, json_loads, to_iso, utcnow
from .text import estimate_tokens, fts_match_expression, keywords

SELECT_COLUMNS = (
    "ord, skill_id, ns, qualified_name, scope_kind, scope_ref, title, description, version, "
    "status, tier, definition, launch_contexts, search_text, search_hash, origin_project, "
    "parent_skill_id, merged_from, supersedes, promoted_to, related_skill_ids, unaudited, "
    "created_at, updated_at, published_at, archived_at"
)


class CapacityError(MemoryError):
    """A capacity ceiling would be exceeded."""


@dataclass(slots=True)
class SkillMatch:
    skill: Skill
    score: float
    intent_score: float
    prereq_score: float
    semantic_score: float
    success_rate: float
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "skill_id": self.skill.skill_id,
            "qualified_name": self.skill.qualified_name,
            "title": self.skill.definition.title,
            "score": round(self.score, 4),
            "intent": round(self.intent_score, 3),
            "prereq": round(self.prereq_score, 3),
            "semantic": round(self.semantic_score, 3),
            "success_rate": round(self.success_rate, 3),
            "reasons": self.reasons,
            "tier": self.skill.tier,
            "enforcement": self.skill.definition.enforcement,
        }


@dataclass(slots=True)
class SkillContext:
    """What the caller can actually do right now; drives the prereq filter."""

    tools: frozenset[str] = frozenset()
    entities: frozenset[str] = frozenset()
    environment: dict[str, Any] = field(default_factory=dict)
    session_key: str | None = None
    turn: int | None = None
    project_id: str | None = None


@dataclass(slots=True)
class RunRecord:
    skill_id: str
    outcome: str
    success: bool
    steps: list[str] = field(default_factory=list)
    tool_names: list[str] = field(default_factory=list)
    duration_ms: int | None = None
    error: str | None = None
    deviation: str | None = None
    project_id: str | None = None
    session_key: str | None = None
    launch_context: dict[str, Any] = field(default_factory=dict)
    anchor_id: str | None = None
    episode_id: str | None = None


@dataclass(slots=True)
class PromotionOutcome:
    skill: Skill
    archived_skill_id: str | None = None
    retracted_beliefs: list[dict[str, Any]] = field(default_factory=list)


class SkillRegistry:
    def __init__(
        self,
        store: Store,
        config: L4Config,
        embeddings: EmbeddingProvider,
        *,
        embedding_cache: Any | None = None,
        on_activate: Any | None = None,
    ) -> None:
        self.store = store
        self.cfg = config
        self.embeddings = embeddings
        self._cache = embedding_cache
        self._tokenizer = "auto"
        # Set by MemorySystem to the archive callback (avoids a circular import).
        self.on_activate = on_activate

    # ══ row mapping ═════════════════════════════════════════════════════
    @staticmethod
    def _from_row(row: Any) -> Skill:
        return Skill(
            skill_id=row["skill_id"],
            qualified_name=row["qualified_name"],
            ns=row["ns"],
            scope_kind=row["scope_kind"],
            scope_ref=row["scope_ref"],
            status=row["status"],
            tier=row["tier"],
            definition=SkillDefinition.from_dict(json_loads(row["definition"], {}) or {}),
            version=int(row["version"]),
            origin_project=row["origin_project"],
            parent_skill_id=row["parent_skill_id"],
            merged_from=json_loads(row["merged_from"], []) or [],
            supersedes=json_loads(row["supersedes"], []) or [],
            promoted_to=row["promoted_to"],
            related_skill_ids=json_loads(row["related_skill_ids"], []) or [],
            unaudited=bool(row["unaudited"]),
            launch_contexts=json_loads(row["launch_contexts"], []) or [],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            published_at=row["published_at"],
            archived_at=row["archived_at"],
        )

    def get(self, skill_id: str) -> Skill:
        row = self.store.query_one(
            f"SELECT {SELECT_COLUMNS} FROM l4_skills WHERE skill_id = ?", (skill_id,)
        )
        if row is None:
            raise NotFoundError(f"skill {skill_id} not found")
        return self._from_row(row)

    def by_qualified_name(self, name: str) -> Skill | None:
        row = self.store.query_one(
            f"SELECT {SELECT_COLUMNS} FROM l4_skills WHERE qualified_name = ?", (name,)
        )
        return self._from_row(row) if row else None

    def find(self, name_or_id: str, view: ScopeView | None = None) -> Skill:
        """Resolve by id, qualified name, or bare name (bare name needs a view)."""
        if name_or_id.startswith("sk_"):
            return self.get(name_or_id)
        skill = self.by_qualified_name(name_or_id)
        if skill is not None:
            return skill
        if view is None:
            raise NotFoundError(f"skill {name_or_id} not found")
        candidates = [s for s in self.visible(view, include_cold=True) if s.name == name_or_id]
        if not candidates:
            raise NotFoundError(f"skill {name_or_id} not found in {view.project_id}")
        # Most specific scope wins.
        candidates.sort(key=lambda s: -SCOPE_RANK[s.scope_kind])
        return candidates[0]

    # ══ writes ══════════════════════════════════════════════════════════
    def create(
        self,
        *,
        view: ScopeView,
        definition: SkillDefinition | dict[str, Any],
        name: str,
        scope_kind: Literal["project", "org", "sys"] = "project",
        ns: Literal["sys", "user", "ext"] = "user",
        status: Literal["candidate", "draft", "active", "retired"] = "candidate",
        unaudited: bool = False,
        origin_project: str | None = None,
        parent_skill_id: str | None = None,
        launch_contexts: Sequence[dict[str, Any]] | None = None,
        tier: Literal["hot", "warm", "cold"] = "warm",
        activation_reason: str | None = None,
    ) -> Skill:
        definition = coerce_definition(definition)
        if scope_kind == "project" and scope_kind not in ("project", "org", "sys"):  # pragma: no cover
            raise ValidationError("bad scope")
        scope_ref = view.project_id if scope_kind == "project" else (
            view.org_id if scope_kind == "org" else None
        )
        if scope_kind in ("project", "org") and not scope_ref:
            raise ValidationError(f"scope {scope_kind} requires a reference")
        qname = qualified(ns, scope_kind, scope_ref, name)
        if self.by_qualified_name(qname) is not None:
            raise ValidationError(f"skill {qname} already exists")
        if status == "active":
            self._check_capacity(scope_kind, scope_ref, activating=True, ignore=None)
        now = to_iso(utcnow())
        skill = Skill(
            skill_id=new_skill_id(),
            qualified_name=qname,
            ns=ns,
            scope_kind=scope_kind,
            scope_ref=scope_ref,
            status=status,
            tier=tier,
            definition=definition,
            origin_project=origin_project or view.project_id,
            parent_skill_id=parent_skill_id,
            unaudited=unaudited,
            launch_contexts=list(launch_contexts or []),
            created_at=now,
            updated_at=now,
            published_at=now if status == "active" else None,
        )
        search_text = definition.search_text()
        with self.store.transaction():
            cur = self.store.execute(
                """INSERT INTO l4_skills
                   (skill_id, ns, qualified_name, scope_kind, scope_ref, title, description,
                    version, status, tier, definition, launch_contexts, search_text, search_hash,
                    origin_project, parent_skill_id, unaudited, created_at, updated_at, published_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    skill.skill_id,
                    ns,
                    qname,
                    scope_kind,
                    scope_ref,
                    definition.title,
                    definition.description,
                    skill.version,
                    status,
                    tier,
                    json_dumps(definition.to_dict()),
                    json_dumps(skill.launch_contexts),
                    search_text,
                    definition_hash(definition),
                    skill.origin_project,
                    parent_skill_id,
                    1 if unaudited else 0,
                    now,
                    now,
                    skill.published_at,
                ),
            )
            ordinal = int(cur.lastrowid)
            self.store.vectors.upsert("l4_skill", ordinal, self._embed(search_text))
            self.store.execute(
                "INSERT INTO l4_fts(skill_id, body) VALUES (?, ?)", (skill.skill_id, search_text)
            )
            self._log_event(
                "skill.created",
                "l4",
                view.project_id,
                {"skill_id": skill.skill_id, "qualified_name": qname, "status": status,
                 "reason": activation_reason},
            )
        return self.get(skill.skill_id)

    def update_definition(
        self,
        skill_id: str,
        definition: SkillDefinition | dict[str, Any],
        *,
        bump_version: bool = True,
    ) -> Skill:
        definition = coerce_definition(definition)
        skill = self.get(skill_id)
        new_hash = definition_hash(definition)
        old_hash = self.store.scalar(
            "SELECT search_hash FROM l4_skills WHERE skill_id = ?", (skill_id,), ""
        )
        if new_hash == old_hash and not bump_version:
            return skill
        version = skill.version + 1 if bump_version else skill.version
        now = to_iso(utcnow())
        search_text = definition.search_text()
        with self.store.transaction():
            # Keep the superseded version as an archived copy (git-like history).
            if bump_version:
                superseded_id = f"{skill_id}@v{skill.version}"
                row = self.store.query_one(
                    f"SELECT {SELECT_COLUMNS} FROM l4_skills WHERE skill_id = ?", (skill_id,)
                )
                self.store.execute(
                    """INSERT OR IGNORE INTO l4_skills
                       (skill_id, ns, qualified_name, scope_kind, scope_ref, title, description,
                        version, status, tier, definition, launch_contexts, search_text, search_hash,
                        origin_project, parent_skill_id, merged_from, supersedes, related_skill_ids,
                        unaudited, created_at, updated_at, published_at, archived_at)
                       VALUES (?,?,?,?,?,?,?,?,'retired',?,?,?,?,?,?,?,'[]','[]','[]',?,?,?,?,?)""",
                    (
                        superseded_id,
                        row["ns"],
                        f"{row['qualified_name']}#v{skill.version}",
                        row["scope_kind"],
                        row["scope_ref"],
                        row["title"],
                        row["description"],
                        skill.version,
                        row["tier"],
                        row["definition"],
                        row["launch_contexts"],
                        row["search_text"],
                        row["search_hash"],
                        row["origin_project"],
                        row["parent_skill_id"],
                        row["unaudited"],
                        row["created_at"],
                        now,
                        row["published_at"],
                        now,
                    ),
                )
                supersedes = [*skill.supersedes, superseded_id]
            else:
                supersedes = list(skill.supersedes)
            self.store.execute(
                """UPDATE l4_skills
                      SET title = ?, description = ?, definition = ?, search_text = ?,
                          search_hash = ?, version = ?, supersedes = ?, updated_at = ?
                    WHERE skill_id = ?""",
                (
                    definition.title,
                    definition.description,
                    json_dumps(definition.to_dict()),
                    search_text,
                    new_hash,
                    version,
                    json_dumps(supersedes),
                    now,
                    skill_id,
                ),
            )
            ordinal = int(self.store.scalar("SELECT ord FROM l4_skills WHERE skill_id = ?", (skill_id,)))
            self.store.vectors.upsert("l4_skill", ordinal, self._embed(search_text))
            self.store.execute("DELETE FROM l4_fts WHERE skill_id = ?", (skill_id,))
            self.store.execute("INSERT INTO l4_fts(skill_id, body) VALUES (?,?)", (skill_id, search_text))
        return self.get(skill_id)

    def activate(self, skill_id: str, *, reason: str = "user_accept") -> Skill:
        """candidate/draft -> active. Capacity is checked first."""
        skill = self.get(skill_id)
        if skill.status == "active":
            return skill
        self._check_capacity(skill.scope_kind, skill.scope_ref, activating=True, ignore=skill_id)
        now = to_iso(utcnow())
        with self.store.transaction():
            self.store.execute(
                "UPDATE l4_skills SET status='active', published_at=?, unaudited=0, updated_at=? "
                "WHERE skill_id = ?",
                (now, now, skill_id),
            )
            self._log_event("skill.activated", "l4", skill.origin_project, {"skill_id": skill_id, "reason": reason})
        activated = self.get(skill_id)
        # Publish into the global backup pool so other projects can reuse it.
        if self.on_activate is not None:
            self.on_activate(activated)
        return activated

    def retire(self, skill_id: str, *, reason: str = "manual") -> Skill:
        with self.store.transaction():
            self.store.execute(
                "UPDATE l4_skills SET status='retired', archived_at=?, updated_at=? WHERE skill_id=?",
                (to_iso(utcnow()), to_iso(utcnow()), skill_id),
            )
            self._log_event("skill.retired", "l4", None, {"skill_id": skill_id, "reason": reason})
        return self.get(skill_id)

    def revive(self, skill_id: str) -> Skill:
        self._check_capacity(self.get(skill_id).scope_kind, self.get(skill_id).scope_ref, True, skill_id)
        skill = self.get(skill_id)
        with self.store.transaction():
            self.store.execute(
                "UPDATE l4_skills SET status='active', archived_at=NULL, updated_at=? WHERE skill_id=?",
                (to_iso(utcnow()), skill_id),
            )
        return self.get(skill_id)

    # ══ capacity / tiers ════════════════════════════════════════════════
    def _check_capacity(self, scope_kind: str, scope_ref: str | None, *, activating: bool, ignore: str | None) -> None:
        if not activating:
            return
        if scope_kind == "project":
            count = int(
                self.store.scalar(
                    "SELECT count(*) FROM l4_skills WHERE scope_kind='project' AND scope_ref=? "
                    "AND status='active' AND skill_id != ?",
                    (scope_ref, ignore or ""),
                    0,
                )
            )
            if count >= self.cfg.max_active_per_project:
                raise CapacityError(
                    f"project {scope_ref} has {count} active skills (cap {self.cfg.max_active_per_project}); "
                    "retire or merge before adding"
                )
        total = int(
            self.store.scalar(
                "SELECT count(*) FROM l4_skills WHERE status='active' AND skill_id != ?",
                (ignore or "",),
                0,
            )
        )
        if total >= self.cfg.max_skills_global:
            raise CapacityError(f"global active skills cap reached ({self.cfg.max_skills_global})")

    def refresh_tiers(self, view: ScopeView) -> dict[str, int]:
        """Recompute Hot/Warm/Cold for one scope view (design §6.4)."""
        skills = self.visible(view, include_cold=True, include_retired=False)
        from datetime import timedelta

        cutoff = to_iso(utcnow() - timedelta(days=30))
        usage: dict[str, int] = {}
        for row in self.store.query(
            "SELECT skill_id, count(*) AS n FROM l4_runs WHERE started_at >= ? GROUP BY skill_id",
            (cutoff,),
        ):
            usage[row["skill_id"]] = int(row["n"])
        ordered = sorted(
            skills, key=lambda s: (-usage.get(s.skill_id, 0), -SCOPE_RANK[s.scope_kind], s.qualified_name)
        )
        updated = {"hot": 0, "warm": 0, "cold": 0}
        hot_seen = 0
        with self.store.transaction():
            for skill in ordered:
                runs = usage.get(skill.skill_id, 0)
                if hot_seen < self.cfg.hot_tier_limit and runs >= self.cfg.hot_min_executions_30d:
                    tier = "hot"
                    hot_seen += 1
                elif runs >= 1 or skill.scope_kind != "sys":
                    tier = "warm"
                else:
                    tier = "cold"
                if tier != skill.tier:
                    self.store.execute(
                        "UPDATE l4_skills SET tier=?, updated_at=? WHERE skill_id=?",
                        (tier, to_iso(utcnow()), skill.skill_id),
                    )
                updated[tier] += 1
        return updated

    # ══ reads / visibility ══════════════════════════════════════════════
    def visible(
        self,
        view: ScopeView,
        *,
        include_cold: bool = True,
        include_retired: bool = False,
        tier: str | None = None,
    ) -> list[Skill]:
        predicate, params = scope_predicate(view)
        clauses = [predicate]
        if not include_retired:
            clauses.append("status = 'active'")
        if tier:
            clauses.append("tier = ?")
            params = [*params, tier]
        rows = self.store.query(
            f"SELECT {SELECT_COLUMNS} FROM l4_skills WHERE {' AND '.join(clauses)} "
            "ORDER BY CASE scope_kind WHEN 'project' THEN 3 WHEN 'org' THEN 2 ELSE 1 END DESC, "
            "qualified_name",
            params,
        )
        skills = [self._from_row(r) for r in rows]
        if not include_cold:
            skills = [s for s in skills if s.tier != "cold"]
        return self._dedupe_by_name(skills)

    @staticmethod
    def _dedupe_by_name(skills: Sequence[Skill]) -> list[Skill]:
        """Design §6.1: ``project > org > sys``. Hard sys skills are never shadowed."""
        kept: dict[str, Skill] = {}
        for skill in sorted(skills, key=lambda s: -SCOPE_RANK[s.scope_kind]):
            existing = kept.get(skill.name)
            if existing is None:
                kept[skill.name] = skill
                continue
            if existing.definition.enforcement == "hard" and existing.scope_kind == "sys":
                continue
            if skill.definition.enforcement == "hard" and skill.scope_kind == "sys":
                kept[skill.name] = skill
        return list(kept.values())

    def hot_index(self, view: ScopeView) -> list[Skill]:
        return [s for s in self.visible(view, include_cold=False, tier="hot")]

    def stats(self, view: ScopeView | None = None) -> dict[str, Any]:
        predicate, params = (scope_predicate(view) if view else ("1=1", []))
        rows = self.store.query(
            f"SELECT status, tier, count(*) AS n FROM l4_skills WHERE {predicate} "
            "GROUP BY status, tier",
            params,
        )
        by_status: dict[str, int] = {}
        by_tier: dict[str, int] = {}
        for row in rows:
            by_status[row["status"]] = by_status.get(row["status"], 0) + int(row["n"])
            if row["status"] == "active":
                by_tier[row["tier"]] = by_tier.get(row["tier"], 0) + int(row["n"])
        return {
            "by_status": by_status,
            "by_tier": by_tier,
            "active": by_status.get("active", 0),
            "hot_tier_count": by_tier.get("hot", 0),
            "candidates": by_status.get("candidate", 0),
        }

    # ══ matching (design §6.2 three-level index) ════════════════════════
    def match(
        self,
        *,
        view: ScopeView,
        user_text: str,
        context: SkillContext | None = None,
        intent_labels: Sequence[str] | None = None,
        limit: int | None = None,
    ) -> list[SkillMatch]:
        context = context or SkillContext(tools=frozenset())
        limit = limit or self.cfg.match_candidate_limit
        candidates = self.visible(view, include_cold=False)
        if not candidates:
            return []
        labels = set(intent_labels or [])
        lower = (user_text or "").lower()
        text_keywords = set(keywords(user_text, limit=16, tokenizer=self._tokenizer))

        scored: list[SkillMatch] = []
        semantic_map = self._semantic_scores(candidates, user_text)
        for skill in candidates:
            reasons: list[str] = []
            d = skill.definition
            # Level 1 — intent: label hit or trigger substring.
            intent_hits = 0.0
            if labels & set(d.intent_labels):
                intent_hits = max(intent_hits, 1.0)
                reasons.append("intent_label")
            trigger_hits = sum(1 for t in d.triggers if t and t.lower() in lower)
            keyword_hits = len(text_keywords & set(d.intent_labels))
            if trigger_hits:
                intent_hits = max(intent_hits, min(1.0, 0.8 + 0.1 * trigger_hits))
                reasons.append("trigger")
            elif keyword_hits:
                intent_hits = max(intent_hits, 0.6)
                reasons.append("keyword")
            # Level 2 — prerequisites: boolean filter with partial credit.
            prereq, missing = self._check_prereqs(d, context)
            if prereq < 1.0:
                reasons.append(f"missing:{','.join(sorted(missing))[:40]}")
            # Level 3 — semantic: only relevant for candidates that already passed
            # an intent or prerequisite gate.
            semantic = 0.0
            if intent_hits > 0 or prereq >= 1.0:
                semantic = max(0.0, semantic_map.get(skill.skill_id, 0.0))
            if intent_hits == 0 and semantic < 0.35:
                continue
            success = self.success_rate(skill.skill_id)
            score = (
                self.cfg.match_intent_weight * intent_hits
                + self.cfg.match_prereq_weight * prereq
                + self.cfg.match_semantic_weight * semantic
                + self.cfg.match_success_weight * success
            )
            # A skill whose prerequisites are unavailable is not actionable.
            if prereq < 0.5:
                score *= 0.45
            if score < self.cfg.match_min_score:
                continue
            scored.append(
                SkillMatch(
                    skill=skill,
                    score=score,
                    intent_score=intent_hits,
                    prereq_score=prereq,
                    semantic_score=semantic,
                    success_rate=success,
                    reasons=reasons,
                )
            )
        scored.sort(key=lambda m: (-m.score, -SCOPE_RANK[m.skill.scope_kind]))
        return scored[:limit]

    def _check_prereqs(self, definition: SkillDefinition, context: SkillContext) -> tuple[float, set[str]]:
        missing: set[str] = set()
        checks = 0
        hits = 0
        for tool in definition.requires_tools:
            checks += 1
            if tool in context.tools:
                hits += 1
            else:
                missing.add(tool)
        for entity in definition.requires_entities:
            checks += 1
            if normalize_entity(entity) in {normalize_entity(e) for e in context.entities}:
                hits += 1
            else:
                missing.add(entity)
        for key, value in definition.environment.items():
            checks += 1
            if str(context.environment.get(key)) == str(value):
                hits += 1
            else:
                missing.add(key)
        if checks == 0:
            return 1.0, missing
        return hits / checks, missing

    def _semantic_scores(self, skills: Sequence[Skill], text: str) -> dict[str, float]:
        """Cosine similarity for every candidate in ONE k-NN query.

        Scoring candidates one at a time issued a separate KNN per skill and
        then kept only the row it was asked about — O(n) index scans per turn.
        A single over-fetch followed by a rowid lookup is O(1).
        """
        if not skills or not text:
            return {}
        ords = {
            int(r["ord"]): r["skill_id"]
            for r in self.store.query(
                f"SELECT ord, skill_id FROM l4_skills WHERE skill_id IN ({','.join('?' * len(skills))})",
                [s.skill_id for s in skills],
            )
        }
        if not ords:
            return {}
        wanted = set(ords)
        out: dict[str, float] = {}
        for rowid, distance in self.store.vectors.knn(
            "l4_skill", self._embed(text), k=len(ords) + 8
        ):
            skill_id = ords.get(int(rowid))
            if skill_id is not None:
                out[skill_id] = 1.0 - distance
        for skill_id in wanted:
            out.setdefault(skill_id, 0.0)
        return out

    def success_rate(self, skill_id: str, *, window: int | None = None) -> float:
        """Bayesian-smoothed success rate: unknown skills are 0.5, not 1.0 or 0.0."""
        rows = self.store.query(
            "SELECT success, count(*) AS n FROM l4_runs WHERE skill_id = ? GROUP BY success",
            (skill_id,),
        )
        if window:
            rows = self.store.query(
                "SELECT success, count(*) AS n FROM (SELECT success FROM l4_runs WHERE skill_id = ? "
                "ORDER BY started_at DESC LIMIT ?) GROUP BY success",
                (skill_id, window),
            )
        ok = sum(int(r["n"]) for r in rows if int(r["success"]) == 1)
        total = sum(int(r["n"]) for r in rows)
        return (ok + 1) / (total + 2)

    # ══ the turn-level entry point (design §6.2 + §6.5) ═════════════════
    def prepare_turn(
        self,
        *,
        view: ScopeView,
        user_text: str,
        context: SkillContext | None = None,
        intent_labels: Sequence[str] | None = None,
        loaded_skill_ids: Sequence[str] = (),
        record_launch: bool = True,
    ) -> Disclosure:
        """Produce everything L4 contributes to one turn, within budget.

        This is the single call a host adapter makes on ``UserPromptSubmit``.
        It also records a *launch record*: what was available, what matched,
        and what the user asked — the raw material for "capability gaps" and
        for L3 epistemics (see DESIGN.md §Divergences D2).
        """
        context = context or SkillContext()
        planner = BudgetPlanner(
            index=self.cfg.index_budget_tokens,
            detail=self.cfg.detail_budget_tokens,
            definition=self.cfg.definition_budget_tokens,
            turn=self.cfg.turn_budget_tokens,
        )
        hot = self.hot_index(view)
        matches = self.match(view=view, user_text=user_text, context=context, intent_labels=intent_labels)
        loaded: list[Skill] = []
        for skill_id in loaded_skill_ids:
            try:
                loaded.append(self.get(skill_id))
            except NotFoundError:
                continue
        disclosure = planner.plan(
            hot=hot,
            matched=[(m.skill, m.score) for m in matches],
            loaded=loaded,
            detail_max=self.cfg.detail_max_skills,
        )
        if record_launch:
            self._record_launch(
                view,
                user_text=user_text,
                labels=list(intent_labels or []),
                context=context,
                matches=matches,
                disclosure=disclosure,
            )
        return disclosure

    def _record_launch(
        self,
        view: ScopeView,
        *,
        user_text: str,
        labels: list[str],
        context: SkillContext,
        matches: list[SkillMatch],
        disclosure: Disclosure,
    ) -> str:
        launch_id = "ln_" + uuid.uuid4().hex[:12]
        self.store.execute(
            """INSERT INTO l4_launches
               (launch_id, session_key, turn, project_id, user_text, intent_labels, available_tools,
                available_skills, offered, capability_gaps, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                launch_id,
                context.session_key,
                context.turn,
                view.project_id,
                (user_text or "")[:2000],
                json_dumps(labels),
                json_dumps(sorted(context.tools)),
                json_dumps([s.qualified_name for s in self.visible(view, include_cold=False)]),
                json_dumps([m.to_dict() for m in matches[:5]]),
                json_dumps([m.skill.qualified_name for m in matches if m.prereq_score < 0.5]),
                to_iso(utcnow()),
            ),
        )
        return launch_id

    def level1_index(self, view: ScopeView) -> list[str]:
        """Just the resident index lines (usable on its own as a system-prompt block)."""
        return [render_index_line(s) for s in self.hot_index(view)]

    def level2_detail(self, view: ScopeView, skill_id: str) -> str:
        skill = self.find(skill_id, view)
        if skill.tier == "cold":
            raise BudgetError(f"{skill.qualified_name} is cold; load it explicitly with skill_load")
        return render_detail(skill)

    def level3_definition(self, view: ScopeView, skill_id: str) -> str:
        return render_full(self.find(skill_id, view))

    # ══ runs ════════════════════════════════════════════════════════════
    def record_run(self, skill_id: str, run: RunRecord) -> str:
        skill = self.get(skill_id)
        run_id = "rn_" + uuid.uuid4().hex[:12]
        with self.store.transaction():
            self.store.execute(
                """INSERT INTO l4_runs
                   (run_id, skill_id, project_id, session_key, outcome, success, steps, tool_names,
                    duration_ms, error, launch_context, deviation, anchor_id, episode_id, started_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    run_id,
                    skill.skill_id,
                    run.project_id or skill.origin_project,
                    run.session_key,
                    run.outcome,
                    1 if run.success else 0,
                    json_dumps(run.steps),
                    json_dumps(run.tool_names),
                    run.duration_ms,
                    run.error,
                    json_dumps(run.launch_context),
                    run.deviation,
                    run.anchor_id,
                    run.episode_id,
                    to_iso(utcnow()),
                ),
            )
        self._maybe_auto_retire(skill.skill_id)
        return run_id

    def _maybe_auto_retire(self, skill_id: str) -> None:
        """Retire on sustained failure (design §6.4), never on a single miss."""
        window = self.cfg.retire_window_runs
        rows = self.store.query(
            "SELECT success FROM l4_runs WHERE skill_id = ? ORDER BY started_at DESC LIMIT ?",
            (skill_id, window),
        )
        if len(rows) < window:
            return
        rate = sum(int(r["success"]) for r in rows) / len(rows)
        if rate < self.cfg.retire_success_rate:
            self.retire(skill_id, reason=f"success_rate {rate:.2f} < {self.cfg.retire_success_rate}")
            self._log_event(
                "skill.retired", "l4", None, {"skill_id": skill_id, "reason": "success_rate", "rate": rate}
            )

    # ══ merge primitive (design §6.4) ═══════════════════════════════════
    def find_similar(self, text: str, *, threshold: float, view: ScopeView, limit: int = 3) -> list[tuple[Skill, float]]:
        candidates = self.visible(view, include_cold=False, include_retired=False)
        if not candidates:
            return []
        ords = {
            int(r["ord"]): r["skill_id"]
            for r in self.store.query(
                f"SELECT ord, skill_id FROM l4_skills WHERE skill_id IN ({','.join('?' * len(candidates))})",
                [c.skill_id for c in candidates],
            )
        }
        by_id = {c.skill_id: c for c in candidates}
        out: list[tuple[Skill, float]] = []
        for rowid, distance in self.store.vectors.knn("l4_skill", self._embed(text), k=max(limit * 3, 6)):
            similarity = 1.0 - distance
            skill = by_id.get(ords.get(int(rowid), ""))
            if skill is not None and similarity >= threshold:
                out.append((skill, similarity))
        out.sort(key=lambda pair: -pair[1])
        return out[:limit]

    def find_counterparts(
        self, skill: Skill, *, threshold: float, limit: int = 5
    ) -> list[tuple[Skill, float]]:
        """Skills in *other* projects similar to ``skill`` (cross-project scan).

        Promotion is the one operation that must see across the isolation
        boundary, so it uses this instead of the scope-filtered
        :meth:`find_similar`. The result never feeds retrieval — only a
        recommendation a human decides on.
        """
        rows = self.store.query(
            "SELECT ord, skill_id FROM l4_skills "
            "WHERE status = 'active' AND scope_kind = 'project' AND scope_ref IS NOT ? AND skill_id != ?",
            (skill.scope_ref, skill.skill_id),
        )
        if not rows:
            return []
        ords = {int(r["ord"]): r["skill_id"] for r in rows}
        out: list[tuple[Skill, float]] = []
        for rowid, distance in self.store.vectors.knn(
            "l4_skill", self._embed(skill.definition.search_text()), k=max(limit * 4, 12)
        ):
            similarity = 1.0 - distance
            skill_id = ords.get(int(rowid))
            if skill_id is None or similarity < threshold:
                continue
            out.append((self.get(skill_id), similarity))
        out.sort(key=lambda pair: -pair[1])
        return out[:limit]

    def merge_into(self, skill_id: str, other_skill_id: str, *, note: str | None = None) -> Skill:
        """Fold ``other`` into ``skill`` (steps appended, triggers unioned)."""
        target = self.get(skill_id)
        other = self.get(other_skill_id)
        merged = SkillDefinition.from_dict(target.definition.to_dict())
        merged.triggers = list(dict.fromkeys([*merged.triggers, *other.definition.triggers]))[:8]
        merged.intent_labels = list(dict.fromkeys([*merged.intent_labels, *other.definition.intent_labels]))[:8]
        merged.requires_tools = list(dict.fromkeys([*merged.requires_tools, *other.definition.requires_tools]))
        for step in other.definition.steps:
            if step.signature() not in {s.signature() for s in merged.steps}:
                merged.steps.append(step)
        if not merged.notes:
            merged.notes = note or f"merged {other.qualified_name}"
        updated = self.update_definition(skill_id, merged, bump_version=True)
        with self.store.transaction():
            self.store.execute(
                "UPDATE l4_skills SET merged_from = ?, updated_at = ? WHERE skill_id = ?",
                (json_dumps([*updated.merged_from, other.skill_id]), to_iso(utcnow()), skill_id),
            )
            self.retire(other.skill_id, reason=f"merged_into:{skill_id}")
        return self.get(skill_id)

    # ══ helpers ═════════════════════════════════════════════════════════
    def _embed(self, text: str) -> list[float]:
        if self._cache is not None:
            return self._cache.embed_one(text)
        return self.embeddings.embed_one(text)

    def _log_event(self, kind: str, layer: str, project_id: str | None, detail: dict[str, Any]) -> None:
        self.store.execute(
            "INSERT INTO events(event_id, kind, layer, project_id, detail, created_at) VALUES (?,?,?,?,?,?)",
            (uuid.uuid4().hex, kind, layer, project_id, json_dumps(detail), to_iso(utcnow())),
        )


def normalize_entity(text: str) -> str:
    return " ".join((text or "").lower().split())