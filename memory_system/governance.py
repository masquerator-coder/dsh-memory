"""L4 — skill archive and promotion governance.

Two mechanisms, both of the form *system recommends, user decides*:

**Archive** (design §6.7). A global, append-only backup pool. It never enters
``match`` and never appears in a Level-1 index — that invariant is what keeps
project isolation intact. Its purpose is (a) surviving project deletion and
(b) preventing duplicate creation: before a new candidate is minted, the
archive is searched. The thresholds are the design's:

    sim > 0.85   -> import(reference)  : create a thin reference skill
    0.60 - 0.85  -> mark similar_to    : reviewer decides
    < 0.60       -> create normally

**Promotion** (design §6.8). Cross-project similarity clusters become a
*pending recommendation* with evidence. Nothing moves until a human records a
decision. Rejections are remembered for a cooldown so the system does not
re-recommend the same cluster every cycle.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Sequence

from . import project_skills
from .config import L4Config
from .errors import NotFoundError, ValidationError
from .l4 import ScopeView, Skill, SkillDefinition, new_skill_id
from .skills import CapacityError, SkillRegistry
from .storage import Store, json_dumps, json_loads, iso_ago, to_iso, utcnow
from .text import clip_words

PromotionStatus = Literal["pending", "accepted", "rejected", "expired"]
ArchiveStatus = Literal["active", "superseded", "retired", "orphaned"]


@dataclass(slots=True)
class ArchiveHit:
    archive_id: str
    name: str
    description: str
    similarity: float
    origin_project: str | None
    status: str
    definition: SkillDefinition | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "archive_id": self.archive_id,
            "name": self.name,
            "description": self.description,
            "similarity": round(self.similarity, 3),
            "origin_project": self.origin_project,
            "status": self.status,
        }


@dataclass(slots=True)
class Promotion:
    promotion_id: str
    cluster_key: str
    proposal_scope: str
    suggestion: SkillDefinition | None
    rationale: str
    evidence: dict[str, Any]
    copy_from: list[str]
    similarity: float
    step_consistency: float
    status: PromotionStatus
    created_at: str
    decided_at: str | None = None
    decision_note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "promotion_id": self.promotion_id,
            "cluster_key": self.cluster_key,
            "proposal_scope": self.proposal_scope,
            "suggestion": self.suggestion.to_dict() if self.suggestion else None,
            "rationale": self.rationale,
            "evidence": self.evidence,
            "copy_from": self.copy_from,
            "similarity": round(self.similarity, 3),
            "step_consistency": round(self.step_consistency, 3),
            "status": self.status,
            "created_at": self.created_at,
        }


class SkillArchive:
    """Global append-only backup pool. Never matched at runtime."""

    def __init__(self, store: Store, cfg: L4Config, embeddings: Any, *, embedding_cache: Any | None = None) -> None:
        self.store = store
        self.cfg = cfg
        self.embeddings = embeddings
        self._cache = embedding_cache

    def snapshot(self, skill: Skill, *, status: ArchiveStatus = "active") -> str:
        """Append the skill's current definition to the archive.

        The pool is append-only *per archived version*, not per call: the same
        skill with the same definition under the same lifecycle status is one
        row. Re-snapshotting it used to add another row plus its vector and FTS
        entry, so a retried scan (or a second ``archive_project``) inflated the
        pool with identical copies that `search` then surfaced as duplicates.
        """
        search_text = skill.definition.search_text()
        digest = hashlib.sha1(search_text.encode("utf-8")).hexdigest()[:16]
        existing = self.store.scalar(
            "SELECT archive_id FROM l4_archive "
            "WHERE origin_skill_id = ? AND search_hash = ? AND status = ? LIMIT 1",
            (skill.skill_id, digest, status),
            0,
        )
        if existing:
            return str(existing)
        archive_id = "ar_" + uuid.uuid4().hex[:12]
        now = to_iso(utcnow())
        with self.store.transaction():
            cur = self.store.execute(
                """INSERT INTO l4_archive
                   (archive_id, origin_skill_id, origin_project, ns, name, description, search_text,
                    search_hash, definition, status, labels, snapshot_at, last_used_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    archive_id,
                    skill.skill_id,
                    skill.origin_project,
                    skill.ns,
                    skill.name,
                    skill.definition.description,
                    search_text,
                    digest,
                    json_dumps(skill.definition.to_dict()),
                    status,
                    json_dumps(skill.definition.intent_labels),
                    now,
                    now,
                ),
            )
            ordinal = int(cur.lastrowid)
            self.store.vectors.upsert("l4_archive", ordinal, self._embed(search_text))
            self.store.execute(
                "INSERT INTO l4_archive_fts(archive_id, body) VALUES (?,?)", (archive_id, search_text)
            )
        return archive_id

    def search(self, text: str, *, limit: int = 5, min_similarity: float = 0.0) -> list[ArchiveHit]:
        if not text.strip():
            return []
        ords = {
            int(r["ord"]): r
            for r in self.store.query(
                "SELECT ord, archive_id, name, description, origin_project, status, definition FROM l4_archive "
                "WHERE status != 'retired'"
            )
        }
        if not ords:
            return []
        out: list[ArchiveHit] = []
        for rowid, distance in self.store.vectors.knn("l4_archive", self._embed(text), k=max(limit * 3, 6)):
            row = ords.get(int(rowid))
            if row is None:
                continue
            similarity = 1.0 - distance
            if similarity < min_similarity:
                continue
            out.append(
                ArchiveHit(
                    archive_id=row["archive_id"],
                    name=row["name"],
                    description=row["description"],
                    similarity=similarity,
                    origin_project=row["origin_project"],
                    status=row["status"],
                    definition=SkillDefinition.from_dict(json_loads(row["definition"], {}) or {}),
                )
            )
        out.sort(key=lambda h: -h.similarity)
        return out[:limit]

    def classify(self, text: str) -> tuple[str, ArchiveHit | None]:
        """Route a would-be new skill: ``reference`` / ``similar`` / ``new``."""
        hits = self.search(text, limit=1)
        if not hits:
            return "new", None
        top = hits[0]
        if top.similarity > self.cfg.archive_reference_similarity:
            return "reference", top
        if top.similarity >= self.cfg.archive_similar_similarity:
            return "similar", top
        return "new", None

    def import_reference(
        self,
        *,
        registry: SkillRegistry,
        view: ScopeView,
        archive_hit: ArchiveHit,
        name: str,
    ) -> Skill:
        """Thin reference skill: same procedure, isolated identity and scope."""
        if archive_hit.definition is None:
            raise NotFoundError(f"archive {archive_hit.archive_id} has no definition")
        definition = SkillDefinition.from_dict(archive_hit.definition.to_dict())
        definition.notes = (definition.notes or "") + (
            f"\n导入自备份仓库 {archive_hit.archive_id}（原项目 {archive_hit.origin_project}）"
        )
        try:
            skill = registry.create(
                view=view,
                definition=definition,
                name=name,
                status="candidate",
                unaudited=True,
                activation_reason=f"archive_reference:{archive_hit.archive_id}",
            )
        except ValidationError:
            # Name collision in this project: qualify by archive id.
            skill = registry.create(
                view=view,
                definition=definition,
                name=f"{name}-{archive_hit.archive_id[-4:]}",
                status="candidate",
                unaudited=True,
            )
        self.store.execute(
            "UPDATE l4_archive SET last_used_at = ? WHERE archive_id = ?",
            (to_iso(utcnow()), archive_hit.archive_id),
        )
        return skill

    def mark_similar(self, archive_hit: ArchiveHit, skill_id: str) -> None:
        row = self.store.query_one("SELECT similar_to FROM l4_archive WHERE archive_id = ?", (archive_hit.archive_id,))
        existing = json_loads(row["similar_to"], []) if row else []
        if skill_id not in existing:
            existing.append(skill_id)
        self.store.execute(
            "UPDATE l4_archive SET similar_to = ? WHERE archive_id = ?",
            (json_dumps(existing), archive_hit.archive_id),
        )

    def mark_orphaned(self, project_id: str) -> int:
        """Project deletion -> its archive entries stay but are flagged."""
        with self.store.transaction():
            cur = self.store.execute(
                "UPDATE l4_archive SET status = 'orphaned' WHERE origin_project = ? AND status = 'active'",
                (project_id,),
            )
        return cur.rowcount or 0

    def stats(self) -> dict[str, Any]:
        rows = self.store.query("SELECT status, count(*) AS n FROM l4_archive GROUP BY status")
        return {row["status"]: int(row["n"]) for row in rows}

    def _embed(self, text: str) -> list[float]:
        if self._cache is not None:
            return self._cache.embed_one(text)
        return self.embeddings.embed_one(text)


class PromotionService:
    """Finds cross-project clusters; books recommendations; applies user decisions."""

    def __init__(
        self,
        store: Store,
        cfg: L4Config,
        registry: SkillRegistry,
        archive: SkillArchive,
    ) -> None:
        self.store = store
        self.cfg = cfg
        self.registry = registry
        self.archive = archive

    # ── proposal generation ─────────────────────────────────────────────
    def propose(self, *, today_count: int | None = None) -> list[Promotion]:
        """Scan for promotable clusters and book at most ``max_daily`` proposals."""
        booked = 0
        out: list[Promotion] = []
        today_count = self.count_today() if today_count is None else today_count
        if today_count >= self.cfg.promotion_max_daily:
            return out
        for cluster in self._cross_project_clusters():
            remaining = self.cfg.promotion_max_daily - today_count - booked
            if remaining <= 0:
                break
            if self._recently_rejected(cluster["key"]):
                continue
            if self._pending_exists(cluster["key"]):
                continue
            promotion = self._book(cluster)
            out.append(promotion)
            booked += 1
        for single in self._single_project_high_value():
            remaining = self.cfg.promotion_max_daily - today_count - booked
            if remaining <= 0:
                break
            if self._recently_rejected(single["key"]) or self._pending_exists(single["key"]):
                continue
            out.append(self._book(single))
            booked += 1
        return out

    def count_today(self) -> int:
        return int(
            self.store.scalar(
                "SELECT count(*) FROM l4_promotions WHERE created_at >= ?", (iso_ago(days=1),), 0
            )
        )

    def _cross_project_clusters(self) -> list[dict[str, Any]]:
        rows = self.store.query(
            "SELECT * FROM l4_skills WHERE status='active' AND scope_kind='project' "
            "ORDER BY origin_project, qualified_name"
        )
        skills = [self.registry._from_row(r) for r in rows]
        by_origin: dict[str, list[Skill]] = {}
        for skill in skills:
            by_origin.setdefault(skill.origin_project or skill.scope_ref or "", []).append(skill)
        clusters: list[dict[str, Any]] = []
        seen: set[tuple[str, ...]] = set()
        for skill in skills:
            similar = self.registry.find_counterparts(
                skill, threshold=self.cfg.promotion_cross_project_similarity
            )
            members = {skill.skill_id: skill}
            for other, similarity in similar:
                if other.scope_kind == "project" and other.scope_ref != skill.scope_ref:
                    members[other.skill_id] = other
            origins = {m.scope_ref for m in members.values()}
            key_tuple = tuple(sorted(members))
            if len(origins) >= 2 and key_tuple not in seen:
                seen.add(key_tuple)
                clusters.append(
                    {
                        "key": "cross:" + hashlib.sha1("|".join(key_tuple).encode()).hexdigest()[:12],
                        "kind": "cross_project",
                        "skills": list(members.values()),
                        "similarity": max(
                            (s for _, s in similar if s), default=self.cfg.promotion_cross_project_similarity
                        ),
                        "projects": sorted(o for o in origins if o),
                    }
                )
        return clusters

    def _single_project_high_value(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        rows = self.store.query(
            """SELECT skill_id, count(*) AS runs, sum(success) AS ok, count(DISTINCT session_key) AS sessions
                 FROM l4_runs GROUP BY skill_id HAVING runs >= ?""",
            (self.cfg.promotion_single_project_runs,),
        )
        for row in rows:
            rate = (row["ok"] or 0) / row["runs"]
            if rate < self.cfg.promotion_single_project_success_rate:
                continue
            try:
                skill = self.registry.get(row["skill_id"])
            except NotFoundError:
                continue
            if skill.status != "active" or skill.scope_kind != "project":
                continue
            if skill.promoted_to:
                continue
            out.append(
                {
                    "key": "single:" + skill.skill_id,
                    "kind": "high_value",
                    "skills": [skill],
                    "similarity": 1.0,
                    "projects": [skill.scope_ref or ""],
                    "runs": int(row["runs"]),
                    "success_rate": rate,
                }
            )
        return out

    def _book(self, cluster: dict[str, Any]) -> Promotion:
        skills: list[Skill] = cluster["skills"]
        suggestion = self._generalize(skills)
        step_consistency = self._step_consistency(skills)
        promotion_id = "pm_" + uuid.uuid4().hex[:12]
        now = to_iso(utcnow())
        evidence = {
            "kind": cluster["kind"],
            "skill_ids": [s.skill_id for s in skills],
            "qualified_names": [s.qualified_name for s in skills],
            "projects": cluster["projects"],
            "runs": [
                {
                    "skill_id": s.skill_id,
                    "success_rate": round(self.registry.success_rate(s.skill_id), 3),
                    "executions": int(
                        self.store.scalar("SELECT count(*) FROM l4_runs WHERE skill_id = ?", (s.skill_id,), 0)
                    ),
                }
                for s in skills
            ],
        }
        rationale = self._rationale(cluster, skills, step_consistency)
        with self.store.transaction():
            self.store.execute(
                """INSERT INTO l4_promotions
                   (promotion_id, cluster_key, proposal_scope, suggestion, rationale, evidence, copy_from,
                    similarity, step_consistency, status, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)""",
                (
                    promotion_id,
                    cluster["key"],
                    "global",
                    json_dumps(suggestion.to_dict()),
                    rationale,
                    json_dumps(evidence),
                    json_dumps([s.skill_id for s in skills]),
                    cluster.get("similarity", 1.0),
                    step_consistency,
                    now,
                    now,
                ),
            )
        return Promotion(
            promotion_id=promotion_id,
            cluster_key=cluster["key"],
            proposal_scope="global",
            suggestion=suggestion,
            rationale=rationale,
            evidence=evidence,
            copy_from=[s.skill_id for s in skills],
            similarity=float(cluster.get("similarity", 1.0)),
            step_consistency=step_consistency,
            status="pending",
            created_at=now,
        )

    def _generalize(self, skills: Sequence[Skill]) -> SkillDefinition:
        """Parameterize a concrete procedure into a reusable one."""
        base = skills[0].definition
        merged = SkillDefinition.from_dict(base.to_dict())
        for skill in skills[1:]:
            merged.triggers = list(dict.fromkeys([*merged.triggers, *skill.definition.triggers]))[:8]
            merged.intent_labels = list(dict.fromkeys([*merged.intent_labels, *skill.definition.intent_labels]))
            merged.requires_tools = list(dict.fromkeys([*merged.requires_tools, *skill.definition.requires_tools]))
            merged.requires_entities = list(
                dict.fromkeys([*merged.requires_entities, *skill.definition.requires_entities])
            )
        # Drop project-specific environment pins: generality is the point.
        merged.environment = {k: v for k, v in merged.environment.items() if not _looks_project_specific(v)}
        merged.parameters = merged.parameters or [
            {"name": "target", "type": "string", "description": "本次操作的对象", "required": True}
        ]
        merged.notes = (merged.notes or "") + "\n由跨项目相似技能归纳，通用性需人工审核。"
        merged.title = clip_words(merged.title, 40)
        return merged

    def _step_consistency(self, skills: Sequence[Skill]) -> float:
        sequences = [s.definition.step_signature() for s in skills if s.definition.step_signature()]
        if len(sequences) < 2:
            return 1.0
        base = sequences[0]
        scores = []
        for seq in sequences[1:]:
            n, m = len(base), len(seq)
            prev = [0] * (m + 1)
            for i in range(1, n + 1):
                cur = [0] * (m + 1)
                for j in range(1, m + 1):
                    cur[j] = prev[j - 1] + 1 if base[i - 1] == seq[j - 1] else max(prev[j], cur[j - 1])
                prev = cur
            scores.append(prev[m] / max(n, m))
        return sum(scores) / len(scores)

    def _rationale(self, cluster: dict[str, Any], skills: Sequence[Skill], consistency: float) -> str:
        names = "、".join(s.qualified_name for s in skills[:4])
        if cluster["kind"] == "cross_project":
            return (
                f"在 {len(cluster['projects'])} 个项目中检测到相似度 ≥ "
                f"{self.cfg.promotion_cross_project_similarity:.0%} 的技能（{names}），"
                f"步骤一致率 {consistency:.0%}。建议归纳为组织级技能，避免各项目重复维护。"
            )
        return (
            f"技能 {names} 在本项目执行 {cluster.get('runs')} 次、成功率 "
            f"{cluster.get('success_rate', 0):.0%}，达到高价值阈值，建议晋升为组织级技能。"
        )

    # ── decisions ───────────────────────────────────────────────────────
    def list_pending(self) -> list[Promotion]:
        rows = self.store.query("SELECT * FROM l4_promotions WHERE status='pending' ORDER BY created_at DESC")
        return [self._from_row(r) for r in rows]

    def get(self, promotion_id: str) -> Promotion:
        row = self.store.query_one("SELECT * FROM l4_promotions WHERE promotion_id = ?", (promotion_id,))
        if row is None:
            raise NotFoundError(f"promotion {promotion_id} not found")
        return self._from_row(row)

    @staticmethod
    def _from_row(row: Any) -> Promotion:
        return Promotion(
            promotion_id=row["promotion_id"],
            cluster_key=row["cluster_key"],
            proposal_scope=row["proposal_scope"],
            suggestion=SkillDefinition.from_dict(json_loads(row["suggestion"], {}) or {}),
            rationale=row["rationale"],
            evidence=json_loads(row["evidence"], {}) or {},
            copy_from=json_loads(row["copy_from"], []) or [],
            similarity=float(row["similarity"]),
            step_consistency=float(row["step_consistency"]),
            status=row["status"],
            created_at=row["created_at"],
            decided_at=row["decided_at"],
            decision_note=row["decision_note"],
        )

    def accept(
        self,
        promotion_id: str,
        *,
        view: ScopeView,
        name: str | None = None,
        scope_kind: Literal["global", "org", "sys"] = "global",
        decided_by: str = "user",
        note: str | None = None,
    ) -> Skill:
        """User accepts: materialize the generalized skill as a global bundle.

        ``scope_kind`` is accepted for backwards compatibility (``org``/``sys``
        used to mean database rows) and is ignored: every promoted skill is now
        a file under ``~/.agents/skills``.
        """
        promotion = self.get(promotion_id)
        if promotion.status != "pending":
            raise ValidationError(f"promotion {promotion_id} is {promotion.status}")
        if promotion.suggestion is None:
            raise ValidationError("promotion has no suggestion")
        base_name = name or _name_from_definition(promotion.suggestion)
        now = to_iso(utcnow())
        # A promoted skill is global procedural memory, so it is written as a
        # bundle under ~/.agents/skills — not as an l4_skills row. The file is
        # written before the decision is recorded so a successful decision
        # always has its file; if a previous attempt wrote the file and then
        # failed, retrying reuses that identical bundle instead of colliding.
        root = project_skills.global_skill_root()
        existing = project_skills.load_at(root, base_name)
        if existing is not None:
            if (
                existing.title != promotion.suggestion.title
                or existing.description != promotion.suggestion.description
            ):
                raise ValidationError(
                    f"global skill {base_name!r} already exists with different content; "
                    "retire it or accept the promotion under another name"
                )
            bundle = existing
        else:
            bundle = project_skills.create_at(
                root,
                promotion.suggestion,
                name=base_name,
                scope="global",
            )
        skill = bundle.to_skill(scope_kind="global", ns="user", status="active")
        with self.store.transaction():
            # ``status='pending'`` in the predicate: the earlier read is outside
            # the transaction, so re-assert it where it is actually enforced.
            cur = self.store.execute(
                "UPDATE l4_promotions SET status='accepted', decided_at=?, updated_at=?, decision_note=?, "
                "decided_by=? WHERE promotion_id = ? AND status = 'pending'",
                (now, now, note, decided_by, promotion_id),
            )
            if not cur.rowcount:
                raise ValidationError(f"promotion {promotion_id} is no longer pending")
            self.store.execute(
                "INSERT INTO events(event_id, kind, layer, project_id, detail, created_at) "
                "VALUES (lower(hex(randomblob(8))), 'skill.promoted', 'l4', ?, ?, ?)",
                (
                    view.project_id,
                    json_dumps(
                        {
                            "promotion_id": promotion_id,
                            "name": bundle.name,
                            "path": str(bundle.path),
                            "scope": "global",
                        }
                    ),
                    now,
                ),
            )
        return skill

    def reject(self, promotion_id: str, *, note: str | None = None, decided_by: str = "user") -> Promotion:
        promotion = self.get(promotion_id)
        # A decided promotion is history. Overwriting an accepted one with
        # 'rejected' left the global skill it created alive while its
        # provenance said the proposal was refused; and re-rejecting re-armed
        # the cooldown clock. Refuse instead of silently rewriting the record.
        if promotion.status != "pending":
            raise ValidationError(f"promotion {promotion_id} is {promotion.status}")
        now = to_iso(utcnow())
        with self.store.transaction():
            cur = self.store.execute(
                "UPDATE l4_promotions SET status='rejected', decided_at=?, updated_at=?, "
                "decision_note=?, decided_by=? WHERE promotion_id = ? AND status = 'pending'",
                (now, now, note, decided_by, promotion_id),
            )
            if not cur.rowcount:
                raise ValidationError(f"promotion {promotion_id} is no longer pending")
        return self.get(promotion_id)

    def expire_old(self) -> int:
        cutoff = iso_ago(days=self.cfg.promotion_expiry_days)
        with self.store.transaction():
            cur = self.store.execute(
                "UPDATE l4_promotions SET status='expired', updated_at=? "
                "WHERE status='pending' AND created_at < ?",
                (to_iso(utcnow()), cutoff),
            )
        return cur.rowcount or 0

    def _recently_rejected(self, cluster_key: str) -> bool:
        cutoff = iso_ago(days=self.cfg.promotion_reject_cooldown_days)
        return bool(
            self.store.scalar(
                "SELECT 1 FROM l4_promotions WHERE cluster_key=? AND status='rejected' "
                "AND decided_at >= ? LIMIT 1",
                (cluster_key, cutoff),
                0,
            )
        )

    def _pending_exists(self, cluster_key: str) -> bool:
        return bool(
            self.store.scalar(
                "SELECT 1 FROM l4_promotions WHERE cluster_key=? AND status='pending' LIMIT 1",
                (cluster_key,),
                0,
            )
        )

    def stats(self) -> dict[str, Any]:
        rows = self.store.query("SELECT status, count(*) AS n FROM l4_promotions GROUP BY status")
        return {row["status"]: int(row["n"]) for row in rows}


def _looks_project_specific(value: Any) -> bool:
    text = str(value).lower()
    return any(token in text for token in ("project", "repo", "workspace", "c:/", "/users/"))


def _name_from_definition(definition: SkillDefinition) -> str:
    """A kebab-case ASCII bundle name for a promoted skill.

    Copy-source rows are gone (project skills are files now), so the name is
    derived from the generalized suggestion itself rather than from a store
    lookup that would always miss. Titles are often Chinese, and the skill
    catalog only accepts ``[a-z0-9-]``, so prefer the ASCII intent labels and
    triggers before falling back to a sanitized title.
    """
    for source in (*definition.intent_labels, *definition.triggers, definition.title):
        words = re.findall(r"[a-z0-9]+", str(source or "").lower())
        slug = "-".join(words[:6]).strip("-")
        if slug:
            return slug[:60].strip("-") or "promoted-skill"
    return "promoted-skill"
