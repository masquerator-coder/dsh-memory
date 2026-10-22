"""L4 — trajectory capture and maturity.

The design's three-stage generation is::

    online: record raw trajectories     (seconds)
    offline: decide maturity            (days)
    review: user publishes              (days)

This module owns the first two. It deliberately does **not** let a model write
a skill definition on its own: a draft produced here is *mined from tool-call
trajectories* and is therefore guaranteed to describe something the agent
actually did. A model-authored SOP would be a plausible-sounding document with
no execution evidence behind it — exactly the failure mode the maturity gate
exists to prevent (:class:`SkillDefinition` validation still applies).

Maturity is five conjunctive conditions (design §6.3):

1. >= 3 successful occurrences of the same signature
2. success rate >= 80%
3. observed across >= 2 distinct sessions
4. mean step-consistency >= 70% against the modal step sequence
5. prerequisites are identifiable (at least one tool or entity, or an
   environment condition)

Step consistency is computed **per variant**, where a variant is the tool-call
sequence projected onto non-parameterized tool names. Raw step text varies
(that is why they are grouped); the *shape* of the procedure is what must be
stable. Parameterization happens here: paths/ids/quoted values become slots
(``<path>``, ``<number>``, ``<quoted>``), so two runs of "edit the failing test"
are one procedure, not two.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Sequence

from .config import L4Config
from .l4 import ScopeView, SkillDefinition, Step, coerce_definition
from .skills import CapacityError, SkillRegistry
from .storage import Store, json_dumps, json_loads, to_iso, utcnow
from .text import clip_words, keywords

# Tools that never form part of a *procedure*: they are observation, not action.
READ_ONLY_TOOLS = frozenset(
    {
        "read", "read_file", "grep", "glob", "list", "ls", "search", "web_search", "web_fetch",
        "todo_write", "todo_read", "skill", "memory_search", "memory_add", "browser_page",
        "remember", "recall", "view_image",
    }
)

_PARAM_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("<quoted>", re.compile(r"\"[^\"]{1,120}\"|'[^']{1,120}'|`[^`]{1,120}`")),
    ("<path>", re.compile(r"[A-Za-z]:\\[^\s\"']+|(?:\.{0,2}/[\w./\-]+)")),
    ("<url>", re.compile(r"https?://\S+")),
    ("<number>", re.compile(r"\b\d+(?:\.\d+)?\b")),
)


def parameterize(arguments: str | None) -> str:
    """Reduce a raw tool-argument string to its structural shape."""
    text = (arguments or "").strip()
    if not text:
        return ""
    for token, pattern in _PARAM_PATTERNS:
        text = pattern.sub(token, text)
    text = re.sub(r"\s+", " ", text)
    return clip_words(text, 160)


@dataclass(slots=True)
class TrajectoryStep:
    action: str
    tool: str | None = None
    args_hint: str | None = None
    success: bool = True

    def signature(self) -> str:
        return (self.tool or self.action or "").strip().lower()

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "tool": self.tool,
            "args_hint": self.args_hint,
            "success": self.success,
        }


@dataclass(slots=True)
class Trajectory:
    traj_id: str
    project_id: str
    signature: str
    variant: str
    steps: list[TrajectoryStep]
    outcome: str
    success: bool
    sessions: list[str] = field(default_factory=list)
    episode_ids: list[str] = field(default_factory=list)
    intent_label: str | None = None
    preconditions: dict[str, Any] = field(default_factory=dict)
    launch_context: dict[str, Any] = field(default_factory=dict)
    anchor_id: str | None = None
    created_at: str = ""

    def tool_sequence(self) -> list[str]:
        return [s.signature() for s in self.steps if s.signature()]


@dataclass(slots=True)
class MaturityEvidence:
    signature: str
    variant: str
    intent_label: str
    runs: int
    successes: int
    success_rate: float
    sessions: int
    step_consistency: float
    prerequisites_identifiable: bool
    mature: bool
    failed_checks: list[str] = field(default_factory=list)
    steps: list[TrajectoryStep] = field(default_factory=list)
    preconditions: dict[str, Any] = field(default_factory=dict)
    episode_ids: list[str] = field(default_factory=list)
    anchor_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "signature": self.signature,
            "variant": self.variant,
            "intent_label": self.intent_label,
            "runs": self.runs,
            "successes": self.successes,
            "success_rate": round(self.success_rate, 3),
            "sessions": self.sessions,
            "step_consistency": round(self.step_consistency, 3),
            "prerequisites_identifiable": self.prerequisites_identifiable,
            "mature": self.mature,
            "failed_checks": self.failed_checks,
        }


def compute_signature(tool_sequence: Sequence[str], intent_label: str | None) -> str:
    """Stable identity of a procedure: its intent plus its tool-call shape."""
    body = ">".join(tool_sequence) if tool_sequence else "noop"
    material = f"{intent_label or ''}|{body}"
    return hashlib.sha1(material.encode("utf-8")).hexdigest()[:12]


def _consistency(candidate: Sequence[str], modal: Sequence[str]) -> float:
    """Order-aware similarity between two tool sequences in [0, 1]."""
    if not candidate and not modal:
        return 1.0
    if not candidate or not modal:
        return 0.0
    # Longest common subsequence / max length: rewards same tools in same order.
    n, m = len(modal), len(candidate)
    prev = [0] * (m + 1)
    for i in range(1, n + 1):
        cur = [0] * (m + 1)
        for j in range(1, m + 1):
            if modal[i - 1] == candidate[j - 1]:
                cur[j] = prev[j - 1] + 1
            else:
                cur[j] = max(prev[j], cur[j - 1])
        prev = cur
    return prev[m] / max(n, m)


class TrajectoryStore:
    """Records raw execution traces and decides maturity."""

    def __init__(self, store: Store, cfg: L4Config, registry: SkillRegistry) -> None:
        self.store = store
        self.cfg = cfg
        self.registry = registry

    # ── capture ─────────────────────────────────────────────────────────
    def record(
        self,
        *,
        project_id: str,
        steps: Sequence[TrajectoryStep],
        outcome: str = "success",
        success: bool = True,
        session_key: str | None = None,
        intent_label: str | None = None,
        preconditions: dict[str, Any] | None = None,
        launch_context: dict[str, Any] | None = None,
        episode_ids: Sequence[str] = (),
        anchor_id: str | None = None,
        include_read_only: bool = True,
    ) -> Trajectory | None:
        """Store one trace. Returns None when the trace is not a *procedure*.

        Rule: a procedure needs at least two mutating steps. A single tool call
        is an action, not a skill, and storing those would drown the candidate
        pool in noise.
        """
        kept = [
            s for s in steps
            if include_read_only or s.signature() not in READ_ONLY_TOOLS
        ]
        if not kept:
            return None
        mutating = [s for s in kept if s.signature() not in READ_ONLY_TOOLS]
        if len(mutating) < 2 and success:
            return None
        sequence = [s.signature() for s in kept]
        variant = hashlib.sha1(">".join(sequence).encode()).hexdigest()[:10]
        signature = compute_signature(
            [s.signature() for s in kept if s.signature() not in READ_ONLY_TOOLS],
            intent_label,
        )
        traj_id = "tj_" + uuid.uuid4().hex[:12]
        now = to_iso(utcnow())
        with self.store.transaction():
            self.store.execute(
                """INSERT INTO l4_trajectories
                   (traj_id, steps_hash, project_id, signature, variant, intent_label, steps,
                    tool_names, preconditions, launch_context, outcome, success, sessions,
                    episode_ids, anchor_id, derived_skill, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)""",
                (
                    traj_id,
                    variant,
                    project_id,
                    signature,
                    variant,
                    intent_label,
                    json_dumps([s.to_dict() for s in kept]),
                    json_dumps(sequence),
                    json_dumps(preconditions or {}),
                    json_dumps(launch_context or {}),
                    outcome,
                    1 if success else 0,
                    json_dumps([session_key] if session_key else []),
                    json_dumps(list(episode_ids)),
                    anchor_id,
                    now,
                ),
            )
        return Trajectory(
            traj_id=traj_id,
            project_id=project_id,
            signature=signature,
            variant=variant,
            steps=list(kept),
            outcome=outcome,
            success=success,
            sessions=[session_key] if session_key else [],
            episode_ids=list(episode_ids),
            intent_label=intent_label,
            preconditions=preconditions or {},
            launch_context=launch_context or {},
            anchor_id=anchor_id,
            created_at=now,
        )

    # ── maturity ────────────────────────────────────────────────────────
    def evaluate(self, project_id: str) -> list[MaturityEvidence]:
        """Group this project's trajectories and grade each group."""
        rows = self.store.query(
            "SELECT * FROM l4_trajectories WHERE project_id = ? AND derived_skill IS NULL",
            (project_id,),
        )
        groups: dict[tuple[str, str], list[Any]] = defaultdict(list)
        for row in rows:
            groups[(row["signature"], row["variant"])].append(row)
        out: list[MaturityEvidence] = []
        for (signature, variant), group in groups.items():
            evidence = self._grade(signature, variant, group)
            if evidence is not None:
                out.append(evidence)
        out.sort(key=lambda e: (-int(e.mature), -e.success_rate, -e.runs))
        return out

    def _grade(self, signature: str, variant: str, group: list[Any]) -> MaturityEvidence | None:
        total = len(group)
        successes = [r for r in group if int(r["success"]) == 1]
        sessions: set[str] = set()
        for row in group:
            sessions.update(json_loads(row["sessions"], []) or [])
        sequences = [json_loads(r["tool_names"], []) or [] for r in successes] or [
            json_loads(r["tool_names"], []) or [] for r in group
        ]
        modal = Counter(tuple(s) for s in sequences).most_common(1)[0][0] if sequences else ()
        consistencies = [_consistency(list(s), list(modal)) for s in sequences]
        mean_consistency = sum(consistencies) / len(consistencies) if consistencies else 0.0

        steps_raw = json_loads(successes[0]["steps"], []) if successes else json_loads(group[0]["steps"], [])
        steps = [
            TrajectoryStep(
                action=str(s.get("action", "")),
                tool=s.get("tool"),
                args_hint=s.get("args_hint"),
                success=bool(s.get("success", True)),
            )
            for s in steps_raw
        ]
        preconditions = json_loads(group[0]["preconditions"], {}) or {}
        for row in group:
            for key, value in (json_loads(row["preconditions"], {}) or {}).items():
                preconditions.setdefault(key, value)

        rate = len(successes) / total if total else 0.0
        prerequisites_ok = bool(
            preconditions.get("tools") or preconditions.get("entities") or preconditions.get("environment")
            or any(s.tool for s in steps)
        )
        failed: list[str] = []
        if len(successes) < self.cfg.maturity_min_successes:
            failed.append("insufficient_successes")
        if rate < self.cfg.maturity_min_success_rate:
            failed.append("success_rate")
        if len(sessions) < self.cfg.maturity_min_sessions:
            failed.append("insufficient_sessions")
        if mean_consistency < self.cfg.maturity_min_step_consistency:
            failed.append("step_consistency")
        if self.cfg.maturity_require_preconditions and not prerequisites_ok:
            failed.append("preconditions")

        intent = None
        for row in group:
            if row["intent_label"]:
                intent = row["intent_label"]
                break
        evidence = MaturityEvidence(
            signature=signature,
            variant=variant,
            intent_label=intent or "procedure",
            runs=total,
            successes=len(successes),
            success_rate=rate,
            sessions=len(sessions),
            step_consistency=mean_consistency,
            prerequisites_identifiable=prerequisites_ok,
            mature=not failed,
            failed_checks=failed,
            steps=steps,
            preconditions=preconditions,
            episode_ids=sorted({ep for row in group for ep in (json_loads(row["episode_ids"], []) or [])}),
            anchor_id=successes[0]["anchor_id"] if successes else group[0]["anchor_id"],
        )
        return evidence

    # ── drafting ────────────────────────────────────────────────────────
    def draft_definition(self, evidence: MaturityEvidence, *, tool_names: Sequence[str] = ()) -> SkillDefinition:
        """Mine a declarative procedure from the modal successful trace."""
        steps: list[Step] = []
        mutated: list[TrajectoryStep] = []
        for step in evidence.steps:
            sig = step.signature()
            if sig in READ_ONLY_TOOLS and steps:
                continue
            if sig in READ_ONLY_TOOLS:
                continue
            mutated.append(step)
        # Collapse immediate repeats (retry loops are not procedure steps).
        collapsed: list[TrajectoryStep] = []
        for step in mutated:
            if collapsed and collapsed[-1].signature() == step.signature():
                continue
            collapsed.append(step)
        for step in collapsed[:20]:
            action = step.action or (f"Call {step.tool}" if step.tool else "step")
            steps.append(
                Step(
                    action=clip_words(action, 160),
                    tool=step.tool,
                    args_hint=step.args_hint,
                )
            )
        if not steps:
            steps = [Step(action="执行该任务的既定流程")]
        tools = sorted({s.tool for s in steps if s.tool})
        entities = sorted(set(evidence.preconditions.get("entities") or []))
        label = evidence.intent_label or "procedure"
        triggers = keywords(label, limit=3)
        title = clip_words(label, 40) or (steps[0].action if steps else "procedure")
        return SkillDefinition(
            title=title,
            description=clip_words(label, 28),
            when_to_use=label if len(label) > 2 else f"当任务与「{title}」相似时使用",
            intent_labels=[label] if label else [],
            triggers=triggers,
            requires_tools=tools,
            requires_entities=entities[:5],
            environment=dict(evidence.preconditions.get("environment") or {}),
            steps=steps,
            fallback="若中途失败，记录偏差并回退到上次成功的步骤序列。",
            success_criteria=f"{evidence.successes} 次成功执行中一致的步骤序列",
            notes=f"由 {evidence.runs} 条轨迹归纳（成功率 {evidence.success_rate:.0%}）",
        )

    def mature(
        self,
        project_id: str,
        *,
        auto_create_candidates: bool = True,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """Evaluate all groups; create a candidate skill for each mature one."""
        from .l4 import new_skill_id  # local import to avoid pubsub cycles

        results: list[dict[str, Any]] = []
        evidences = self.evaluate(project_id)
        for evidence in evidences:
            if not evidence.mature:
                # Keep the last grading visible for observability.
                self.store.execute(
                    """INSERT INTO l4_candidates
                       (candidate_id, project_id, signature, variant, intent_label, evidence, preconditions,
                        status, skill_id, attempts, last_reason, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,'immature',NULL,?,?,?,?)
                       ON CONFLICT(project_id, signature, variant) DO UPDATE SET
                         evidence = excluded.evidence, attempts = l4_candidates.attempts + 1,
                         last_reason = excluded.last_reason, updated_at = excluded.updated_at""",
                    (
                        "cd_" + uuid.uuid4().hex[:10],
                        project_id,
                        evidence.signature,
                        evidence.variant,
                        evidence.intent_label,
                        json_dumps(evidence.to_dict()),
                        json_dumps(evidence.preconditions),
                        int(", ".join(evidence.failed_checks).__hash__() % 1000),
                        ", ".join(evidence.failed_checks),
                        to_iso(utcnow()),
                        to_iso(utcnow()),
                    ),
                )
                results.append({"signature": evidence.signature, "mature": False, "reason": evidence.failed_checks})
                continue
            if not auto_create_candidates:
                results.append({"signature": evidence.signature, "mature": True, "created": None})
                continue
            draft = self.draft_definition(evidence)
            try:
                coerce_definition(draft)
            except Exception as exc:  # noqa: BLE001 - a bad draft is not fatal
                results.append({"signature": evidence.signature, "mature": True, "error": str(exc)})
                continue
            row = self.store.query_one(
                "SELECT status, skill_id FROM l4_candidates WHERE project_id=? AND signature=? AND variant=?",
                (project_id, evidence.signature, evidence.variant),
            )
            if row is not None and row["skill_id"]:
                results.append(
                    {"signature": evidence.signature, "mature": True, "skill_id": row["skill_id"],
                     "note": "already drafted"}
                )
                continue
            view = ScopeView(project_id=project_id)
            # Design §6.4: don't create a near-duplicate — extend the existing skill.
            similar = self.registry.find_similar(
                draft.search_text(), threshold=self.registry.cfg.merge_similarity, view=view
            )
            if similar:
                existing, similarity = similar[0]
                self._mark_derived(project_id, evidence, existing.skill_id)
                self._upsert_candidate(
                    project_id, evidence, status="merged", skill_id=existing.skill_id,
                    reason=f"similar to {existing.qualified_name} ({similarity:.2f})",
                )
                results.append(
                    {"signature": evidence.signature, "mature": True, "merged_into": existing.qualified_name,
                     "similarity": round(similarity, 3)}
                )
                continue
            candidates_count = int(
                self.store.scalar(
                    "SELECT count(*) FROM l4_candidates WHERE project_id=? AND status IN ('draft','pending')",
                    (project_id,),
                    0,
                )
            )
            if candidates_count >= self.registry.cfg.max_candidates_per_project:
                self._upsert_candidate(
                    project_id, evidence, status="deferred", skill_id=None, reason="candidate_pool_full"
                )
                results.append({"signature": evidence.signature, "mature": True, "deferred": "candidate_pool_full"})
                continue
            name = _slug_from(evidence.intent_label, evidence.signature)
            try:
                skill = self.registry.create(
                    view=view,
                    definition=draft,
                    name=name,
                    status="candidate",
                    unaudited=True,
                    parent_skill_id=None,
                    launch_contexts=[json_loads(row["launch_context"], {}) or {} for row in []] or [],
                    activation_reason=f"auto_matured:{evidence.signature}",
                )
            except Exception as exc:  # noqa: BLE001
                results.append({"signature": evidence.signature, "mature": True, "error": str(exc)})
                continue
            self._mark_derived(project_id, evidence, skill.skill_id)
            self._upsert_candidate(
                project_id, evidence, status="draft", skill_id=skill.skill_id,
                reason="mature", intent_label=evidence.intent_label,
            )
            self.store.execute(
                "INSERT INTO events(event_id, kind, layer, project_id, detail, created_at) VALUES (?,?,?,?,?,?)",
                (
                    uuid.uuid4().hex,
                    "skill.drafted",
                    "l4",
                    project_id,
                    json_dumps({"skill_id": skill.skill_id, "evidence": evidence.to_dict()}),
                    to_iso(utcnow()),
                ),
            )
            results.append(
                {"signature": evidence.signature, "mature": True, "skill_id": skill.skill_id,
                 "qualified_name": skill.qualified_name}
            )
            if len(results) >= limit:
                break
        return results

    def _mark_derived(self, project_id: str, evidence: MaturityEvidence, skill_id: str) -> None:
        self.store.execute(
            "UPDATE l4_trajectories SET derived_skill = ? "
            "WHERE project_id = ? AND signature = ? AND variant = ?",
            (skill_id, project_id, evidence.signature, evidence.variant),
        )

    def _upsert_candidate(
        self,
        project_id: str,
        evidence: MaturityEvidence,
        *,
        status: str,
        skill_id: str | None,
        reason: str,
        intent_label: str | None = None,
    ) -> None:
        now = to_iso(utcnow())
        self.store.execute(
            """INSERT INTO l4_candidates
               (candidate_id, project_id, signature, variant, intent_label, evidence, preconditions,
                status, skill_id, attempts, last_reason, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)
               ON CONFLICT(project_id, signature, variant) DO UPDATE SET
                 status = excluded.status, skill_id = excluded.skill_id,
                 evidence = excluded.evidence, attempts = l4_candidates.attempts + 1,
                 last_reason = excluded.last_reason, updated_at = excluded.updated_at""",
            (
                "cd_" + uuid.uuid4().hex[:10],
                project_id,
                evidence.signature,
                evidence.variant,
                intent_label or evidence.intent_label,
                json_dumps(evidence.to_dict()),
                json_dumps(evidence.preconditions),
                status,
                skill_id,
                reason,
                now,
                now,
            ),
        )

    # ── review surface ──────────────────────────────────────────────────
    def pending_candidates(self, project_id: str) -> list[dict[str, Any]]:
        rows = self.store.query(
            "SELECT * FROM l4_candidates WHERE project_id = ? AND status = 'draft' ORDER BY updated_at DESC",
            (project_id,),
        )
        return [
            {
                "candidate_id": row["candidate_id"],
                "skill_id": row["skill_id"],
                "intent_label": row["intent_label"],
                "evidence": json_loads(row["evidence"], {}),
            }
            for row in rows
        ]


def _slug_from(label: str, signature: str) -> str:
    ascii_words = re.findall(r"[a-z0-9]+", (label or "").lower())
    if ascii_words:
        return "-".join(ascii_words[:4])
    return f"proc-{signature}"