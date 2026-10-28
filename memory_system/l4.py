"""L4 — procedural memory: skill definitions, scopes, and safe rendering.

The design document's L4 has six moving parts. This module owns three of them:
the **data model**, the **scope algebra**, and the **attention-budgeted
rendering**. The registry (matching, lifecycle) is :mod:`memory_system.skills`;
maturity/consolidation is :mod:`memory_system.maturity`; archive and promotion are
:mod:`memory_system.governance`.

Scope algebra (design §6.1)::

    visible(project P in org O) = project:P  ∪  org:O  ∪  sys

and ``project > org > sys`` for conflict resolution. Cross-project skills are
*never* visible through this algebra — that is the isolation guarantee, and it
is enforced in SQL by ``scope_predicate``, not by filtering Python-side.

A skill definition is a declarative object, not code. The system stores,
versions, scores and renders it; it never interprets it. That is what makes an
"agent-authored" skill safe to keep: the worst it can do is be bad advice.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal, Sequence

from .errors import BudgetError, ValidationError
from .text import clip_words, estimate_tokens

ScopeKind = Literal["project", "global", "org", "sys"]
Status = Literal["candidate", "draft", "active", "retired"]
Tier = Literal["hot", "warm", "cold"]
Enforcement = Literal["soft", "hard"]
Namespace = Literal["sys", "user", "ext"]

SCOPE_RANK = {"project": 3, "global": 2, "org": 2, "sys": 1}
MAX_DESCRIPTION_CHARS = 15  # CJK characters, per the writing standard


# ══ scope algebra ═══════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class ScopeRef:
    """One scope instance, e.g. ``ScopeRef("project", "p1")``."""

    kind: ScopeKind
    ref: str | None = None

    def key(self) -> str:
        return f"{self.kind}:{self.ref}" if self.ref else self.kind

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.key()


@dataclass(frozen=True, slots=True)
class ScopeView:
    """The set of scopes one caller can see."""

    project_id: str
    org_id: str | None = None

    def visible(self) -> list[ScopeRef]:
        out = [ScopeRef("project", self.project_id)]
        if self.org_id:
            out.append(ScopeRef("org", self.org_id))
        out.append(ScopeRef("sys", None))
        return out

    def can_see(self, kind: ScopeKind, ref: str | None) -> bool:
        if kind == "sys":
            return True
        if kind == "org":
            return bool(self.org_id) and ref == self.org_id
        return ref == self.project_id


def scope_predicate(view: ScopeView) -> tuple[str, list[Any]]:
    """SQL fragment (without WHERE) restricting rows to the view's scopes."""
    clauses = ["(scope_kind = 'project' AND scope_ref = ?)"]
    params: list[Any] = [view.project_id]
    if view.org_id:
        clauses.append("(scope_kind = 'org' AND scope_ref = ?)")
        params.append(view.org_id)
    clauses.append("scope_kind = 'sys'")
    return "(" + " OR ".join(clauses) + ")", params


# ══ definition ══════════════════════════════════════════════════════════


@dataclass(slots=True)
class Step:
    """One executable instruction in a skill body."""

    action: str
    # Tool this step is expected to use (drives prerequisite checks).
    tool: str | None = None
    args_hint: str | None = None
    # A failure here aborts the procedure (vs. being recoverable).
    critical: bool = False

    def signature(self) -> str:
        """Tool-level signature used for step-consistency comparison."""
        base = (self.tool or self.action or "").strip().lower()
        return re.sub(r"\s+", " ", base)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "tool": self.tool,
            "args_hint": self.args_hint,
            "critical": self.critical,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Step":
        return cls(
            action=str(data.get("action", "")),
            tool=data.get("tool"),
            args_hint=data.get("args_hint"),
            critical=bool(data.get("critical", False)),
        )


@dataclass(slots=True)
class SkillDefinition:
    """A versioned, declarative procedure."""

    title: str
    description: str
    when_to_use: str
    intent_labels: list[str] = field(default_factory=list)
    triggers: list[str] = field(default_factory=list)
    requires_tools: list[str] = field(default_factory=list)
    requires_entities: list[str] = field(default_factory=list)
    environment: dict[str, Any] = field(default_factory=dict)
    steps: list[Step] = field(default_factory=list)
    parameters: list[dict[str, Any]] = field(default_factory=list)
    fallback: str | None = None
    examples: list[str] = field(default_factory=list)
    success_criteria: str | None = None
    enforcement: Enforcement = "soft"
    resources: dict[str, str] = field(default_factory=dict)
    notes: str | None = None

    def search_text(self) -> str:
        parts = [
            self.title,
            self.description,
            self.when_to_use,
            " ".join(self.triggers),
            " ".join(self.intent_labels),
            " ".join(self.requires_tools),
            " ".join(self.requires_entities),
            " ".join(s.action for s in self.steps),
            " ".join(s.tool or "" for s in self.steps),
        ]
        return "\n".join(p for p in parts if p)

    def step_signature(self) -> list[str]:
        return [s.signature() for s in self.steps if s.signature()]

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "description": self.description,
            "when_to_use": self.when_to_use,
            "intent_labels": list(self.intent_labels),
            "triggers": list(self.triggers),
            "requires_tools": list(self.requires_tools),
            "requires_entities": list(self.requires_entities),
            "environment": dict(self.environment),
            "steps": [s.to_dict() for s in self.steps],
            "parameters": list(self.parameters),
            "fallback": self.fallback,
            "examples": list(self.examples),
            "success_criteria": self.success_criteria,
            "enforcement": self.enforcement,
            "resources": dict(self.resources),
            "notes": self.notes,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SkillDefinition":
        return cls(
            title=str(data.get("title", "")),
            description=str(data.get("description", "")),
            when_to_use=str(data.get("when_to_use", "")),
            intent_labels=[str(x) for x in data.get("intent_labels", [])],
            triggers=[str(x) for x in data.get("triggers", [])],
            requires_tools=[str(x) for x in data.get("requires_tools", [])],
            requires_entities=[str(x) for x in data.get("requires_entities", [])],
            environment=dict(data.get("environment") or {}),
            steps=[Step.from_dict(s) for s in data.get("steps", [])],
            parameters=list(data.get("parameters") or []),
            fallback=data.get("fallback"),
            examples=[str(x) for x in data.get("examples", [])],
            success_criteria=data.get("success_criteria"),
            enforcement=data.get("enforcement", "soft"),
            resources=dict(data.get("resources") or {}),
            notes=data.get("notes"),
        )


@dataclass(slots=True)
class Skill:
    skill_id: str
    qualified_name: str
    ns: Namespace
    scope_kind: ScopeKind
    scope_ref: str | None
    status: Status
    tier: Tier
    definition: SkillDefinition
    version: int = 1
    origin_project: str | None = None
    parent_skill_id: str | None = None
    merged_from: list[str] = field(default_factory=list)
    supersedes: list[str] = field(default_factory=list)
    promoted_to: str | None = None
    related_skill_ids: list[str] = field(default_factory=list)
    unaudited: bool = False
    launch_contexts: list[dict[str, Any]] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    published_at: str | None = None
    archived_at: str | None = None

    @property
    def name(self) -> str:
        """Bare skill name (last segment of ``ns:scope:name``)."""
        return self.qualified_name.rsplit(":", 1)[-1]

    @property
    def scope(self) -> ScopeRef:
        return ScopeRef(self.scope_kind, self.scope_ref)

    def summary(self) -> str:
        return self.definition.description

    def to_dict(self) -> dict[str, Any]:
        return {
            "skill_id": self.skill_id,
            "qualified_name": self.qualified_name,
            "scope": self.scope.key(),
            "status": self.status,
            "tier": self.tier,
            "version": self.version,
            "title": self.definition.title,
            "description": self.definition.description,
            "when_to_use": self.definition.when_to_use,
            "intent_labels": self.definition.intent_labels,
            "triggers": self.definition.triggers,
            "requires_tools": self.definition.requires_tools,
            "step_count": len(self.definition.steps),
            "enforcement": self.definition.enforcement,
            "unaudited": self.unaudited,
            "parent_skill_id": self.parent_skill_id,
            "promoted_to": self.promoted_to,
            "updated_at": self.updated_at,
        }


def new_skill_id() -> str:
    return "sk_" + uuid.uuid4().hex[:12]


def qualified(ns: str, scope_kind: str, scope_ref: str | None, name: str) -> str:
    """Namespaced identity: ``user:project:p1:git-commit``."""
    slug = slugify(name)
    where = f"{scope_kind}:{scope_ref}" if scope_ref else scope_kind
    return f"{ns}:{where}:{slug}"


def slugify(name: str) -> str:
    text = (name or "").strip().lower()
    text = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "-", text).strip("-")
    return text or "skill"


def definition_hash(definition: SkillDefinition) -> str:
    return hashlib.sha1(
        definition.search_text().encode("utf-8")
        + "|".join(definition.step_signature()).encode("utf-8")
    ).hexdigest()[:16]


def validate_definition(definition: SkillDefinition) -> list[str]:
    """Structural validation. Returns human-readable problems (empty = valid)."""
    problems: list[str] = []
    if not (definition.title or "").strip():
        problems.append("title is required")
    if not (definition.description or "").strip():
        problems.append("description is required")
    if len(definition.description) > MAX_DESCRIPTION_CHARS * 2:
        problems.append(
            f"description should be <= {MAX_DESCRIPTION_CHARS * 2} characters "
            f"(attention budget), got {len(definition.description)}"
        )
    if not definition.steps:
        problems.append("at least one step is required")
    if len(definition.steps) > 40:
        problems.append("at most 40 steps; split the procedure")
    if definition.enforcement not in ("soft", "hard"):
        problems.append("enforcement must be soft or hard")
    if definition.enforcement == "hard" and not definition.success_criteria:
        problems.append("a hard-enforcement skill must state success_criteria")
    if not definition.triggers and not definition.intent_labels:
        problems.append("at least one trigger or intent label is required")
    for i, step in enumerate(definition.steps, 1):
        if not (step.action or "").strip():
            problems.append(f"step {i} has no action")
    return problems


def coerce_definition(raw: SkillDefinition | dict[str, Any]) -> SkillDefinition:
    definition = raw if isinstance(raw, SkillDefinition) else SkillDefinition.from_dict(raw)
    problems = validate_definition(definition)
    if problems:
        raise ValidationError("; ".join(problems))
    return definition


# ══ attention-budgeted rendering (design §6.5) ══════════════════════════


def render_index_line(skill: Skill, stats: dict[str, Any] | None = None) -> str:
    """Level 1: one line per skill. No steps, no parameters (writing standard)."""
    description = clip_words(skill.definition.description, MAX_DESCRIPTION_CHARS)
    trigger = "|".join(skill.definition.triggers[:2]) or "|".join(skill.definition.intent_labels[:2])
    enforcement = " [强制]" if skill.definition.enforcement == "hard" else ""
    return f"- {skill.qualified_name} · {trigger} · {description}{enforcement}"


def render_detail(skill: Skill, *, max_steps: int = 6) -> str:
    """Level 2: triggers, prerequisites and a step outline. No schemas/examples."""
    d = skill.definition
    lines = [f"## {d.title} ({skill.qualified_name})"]
    lines.append(f"何时使用: {d.when_to_use or d.description}")
    if d.requires_tools:
        lines.append(f"前置工具: {', '.join(d.requires_tools)}")
    if d.requires_entities:
        lines.append(f"前置实体: {', '.join(d.requires_entities)}")
    lines.append("步骤:")
    for i, step in enumerate(d.steps[:max_steps], 1):
        tool = f"[{step.tool}] " if step.tool else ""
        lines.append(f"  {i}. {tool}{step.action}")
    if len(d.steps) > max_steps:
        lines.append(f"  … 共 {len(d.steps)} 步，调用 skill_load 查看完整定义")
    lines.append(f"执行方式: skill_run 记录执行结果，失败时调用 skill_record 说明偏差")
    return "\n".join(lines)


def render_full(skill: Skill) -> str:
    """Level 3: the complete definition."""
    d = skill.definition
    lines = [f"# {d.title}", f"id: {skill.qualified_name} (v{skill.version})", f"作用域: {skill.scope.key()}", ""]
    lines.append(f"## 适用场景\n{d.when_to_use or d.description}")
    if d.intent_labels:
        lines.append(f"intent: {', '.join(d.intent_labels)}")
    if d.triggers:
        lines.append(f"triggers: {', '.join(d.triggers)}")
    if d.requires_tools or d.requires_entities or d.environment:
        lines.append("\n## 前置条件")
        if d.requires_tools:
            lines.append(f"- 工具: {', '.join(d.requires_tools)}")
        if d.requires_entities:
            lines.append(f"- 实体: {', '.join(d.requires_entities)}")
        for key, value in d.environment.items():
            lines.append(f"- {key}: {value}")
    lines.append("\n## 步骤")
    for i, step in enumerate(d.steps, 1):
        tool = f" `{step.tool}`" if step.tool else ""
        critical = " **(关键)**" if step.critical else ""
        lines.append(f"{i}.{tool} {step.action}{critical}")
        if step.args_hint:
            lines.append(f"   - 参数提示: {step.args_hint}")
    if d.parameters:
        lines.append("\n## 参数")
        for p in d.parameters:
            lines.append(
                f"- {p.get('name')} ({p.get('type', 'string')}): {p.get('description', '')}"
                + (" 必填" if p.get("required") else "")
            )
    if d.fallback:
        lines.append(f"\n## 回退\n{d.fallback}")
    if d.success_criteria:
        lines.append(f"\n## 成功标准\n{d.success_criteria}")
    if d.examples:
        lines.append("\n## 示例")
        for ex in d.examples[:2]:
            lines.append(f"- {ex}")
    if skill.unaudited:
        lines.append("\n> 注意：此技能由系统归纳、未经用户审核。执行后请记录结果。")
    return "\n".join(lines)


@dataclass(slots=True)
class Disclosure:
    """The three-level injection a turn receives, with its token accounting."""

    index_lines: list[str] = field(default_factory=list)
    details: list[str] = field(default_factory=list)
    full: list[str] = field(default_factory=list)
    dropped_index: list[str] = field(default_factory=list)
    tokens_index: int = 0
    tokens_detail: int = 0
    tokens_full: int = 0
    soft: list[str] = field(default_factory=list)  # skills the model may consider

    @property
    def tokens_total(self) -> int:
        return self.tokens_index + self.tokens_detail + self.tokens_full

    def render(self) -> str:
        parts: list[str] = []
        if self.index_lines:
            parts.append("## 可用技能（常驻索引）\n" + "\n".join(self.index_lines))
        if self.details:
            parts.append("## 相关技能（建议加载）\n" + "\n\n".join(self.details))
        if self.full:
            parts.append("## 已加载技能\n" + "\n\n".join(self.full))
        return "\n\n".join(parts)

    def to_dict(self) -> dict[str, Any]:
        return {
            "index_lines": self.index_lines,
            "details": self.details,
            "full": self.full,
            "dropped_index": self.dropped_index,
            "soft": self.soft,
            "tokens": {
                "index": self.tokens_index,
                "detail": self.tokens_detail,
                "full": self.tokens_full,
                "total": self.tokens_total,
            },
        }


class BudgetPlanner:
    """Enforces the attention budget by *degrading*, never by overflowing.

    The design's rule is explicit: when the budget is exceeded, lower-priority
    content is dropped (or demoted to a lower level), and the budget itself
    never grows. ``plan`` therefore always returns something that fits.
    """

    def __init__(self, *, index: int, detail: int, definition: int, turn: int) -> None:
        self.index_budget = index
        self.detail_budget = detail
        self.definition_budget = definition
        self.turn_budget = turn

    def plan(
        self,
        *,
        hot: Sequence[Skill],
        matched: Sequence[tuple[Skill, float]],
        loaded: Sequence[Skill] = (),
        detail_max: int = 2,
    ) -> Disclosure:
        disclosure = Disclosure()
        # ── Level 1: hot index, one line each, largest-success first on overflow
        used = 0
        for skill in hot:
            line = render_index_line(skill)
            cost = estimate_tokens(line)
            if used + cost > self.index_budget:
                disclosure.dropped_index.append(skill.qualified_name)
                continue
            disclosure.index_lines.append(line)
            used += cost
        disclosure.tokens_index = used

        # ── Level 2: matched detail, bounded count and tokens
        used = 0
        for skill, _score in list(matched)[:detail_max]:
            body = render_detail(skill)
            cost = estimate_tokens(body)
            if used + cost > self.detail_budget:
                disclosure.dropped_index.append(skill.qualified_name)
                continue
            disclosure.details.append(body)
            disclosure.soft.append(skill.qualified_name)
            used += cost
        disclosure.tokens_detail = used

        # ── Level 3: explicitly loaded definitions
        used = 0
        for skill in loaded:
            body = render_full(skill)
            cost = estimate_tokens(body)
            if cost > self.definition_budget:
                body = clip_words(body, self.definition_budget * 2) + "\n… (已截断)"
                cost = estimate_tokens(body)
            if used + cost > self.definition_budget:
                raise BudgetError(
                    f"loaded skill {skill.qualified_name} exceeds definition budget "
                    f"({self.definition_budget} tokens)"
                )
            disclosure.full.append(body)
            used += cost
        disclosure.tokens_full = used

        # ── Hard turn ceiling: demote the largest blocks until we fit.
        while disclosure.tokens_total > self.turn_budget:
            if disclosure.details:
                disclosure.details.pop()
                disclosure.soft.pop()
                disclosure.tokens_detail = sum(estimate_tokens(d) for d in disclosure.details)
            elif disclosure.index_lines:
                disclosure.dropped_index.append(disclosure.index_lines.pop())
                disclosure.tokens_index = sum(estimate_tokens(l) for l in disclosure.index_lines)
            else:
                raise BudgetError("turn budget exceeded by loaded definitions alone")
        return disclosure


def definition_to_markdown(skill: Skill) -> str:
    """Serialize a skill for git-backed storage/export."""
    return render_full(skill)