"""Memory digest and user profile — the text a host injects into a system prompt.

The digest is the *only* thing a host reads on the prompt path, so it has to be
short, bounded and stable between generations. Three ideas make that work:

**Generation is a pure function of the prompt.** :class:`DigestPlanner` turns a
selection of memories into a *request* (system + user message, prompt version,
hash). The host runs that request with whatever model it owns and hands the
text back to :meth:`DigestService.commit`. Nothing here calls a model, imports a
host SDK, or schedules work; that keeps this module testable with a fake
generator and keeps the model choice where it belongs (the host).

**Length is a budget, not a guess.** The slider values (100k / 300k / 500k /
800k, or a custom number) are *characters* of digest. Materials are selected
newest-first, bounded per project, and committed output is clipped to the
budget line-by-line rather than mid-codepoint. ``estimated_tokens`` is reported
alongside so a host can decide whether the block is affordable.

**Context anchors stay small.** A context anchor is an eight-line block
(``@@dsh-memory ... @@``) that tells the model the digest exists, how to refresh
it and how to look at the user profile. It never contains the digest body or
profile body; it only contains counts and commands. It is rendered from the
*current* state every turn, so it can never go stale.

Everything persistent lives in ``meta`` (small key/value post-its) and one
append-only ``memory_digests`` table whose schema is created lazily by
:func:`ensure_schema`. That keeps :class:`~memory_system.storage.Store`'s own
schema untouched: the core does not grow a table because a host wanted a
notepad.

Prompt versions: bump :data:`PROMPT_VERSION` whenever the instructions change,
because a digest generated under different instructions is not a valid cache of
the current configuration.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from .errors import ValidationError
from .storage import Store, to_iso, utcnow
from .system import MemorySystem
from .text import estimate_tokens, fts_index_text

# ══ constants ═══════════════════════════════════════════════════════════

PROMPT_VERSION = 1
LENGTH_PRESETS: tuple[int, ...] = (300, 500, 800, 1_000, 1_500, 2_000, 3_000)
LENGTH_MIN = LENGTH_PRESETS[0]
LENGTH_MAX = LENGTH_PRESETS[-1]
DEFAULT_LENGTH = 1_000
PROFILE_MAX_CHARS = 100_000
# Ceiling for one memory's summary text, shared by the editor and the restore
# path so a backup written by another host still round-trips.
SUMMARY_MAX_CHARS = 8_000

LENGTH_REPLACE = "replace"
LENGTH_APPEND = "append"

# Automatic summary generation always runs when the host is idle; there is no
# user-facing switch, so the stored mode is a single fixed value.
AUTO_MODE = "idle"
SCOPES: tuple[str, ...] = ("project", "global")

_TABLE = """
CREATE TABLE IF NOT EXISTS memory_digests (
    digest_id        TEXT PRIMARY KEY,
    scope            TEXT NOT NULL,             -- 'project' | 'global'
    scope_ref        TEXT,                      -- project_id, NULL for global
    status           TEXT NOT NULL,             -- ok | truncated | empty | error
    content          TEXT NOT NULL,
    requested_chars  INTEGER NOT NULL,
    actual_chars     INTEGER NOT NULL,
    estimated_tokens INTEGER NOT NULL DEFAULT 0,
    sources          TEXT NOT NULL DEFAULT '[]',-- memory ids used
    materials_chars  INTEGER NOT NULL DEFAULT 0,
    prompt_version   INTEGER NOT NULL DEFAULT 1,
    generator        TEXT,
    reason           TEXT,                      -- manual | auto-debounced | auto-idle | ...
    error            TEXT,
    created_at       TEXT NOT NULL
);
"""
_INDEX = """
CREATE INDEX IF NOT EXISTS memory_digests_scope
    ON memory_digests(scope, scope_ref, created_at DESC);
"""


def ensure_schema(store: Store) -> None:
    """Create this module's tables. Idempotent; the core schema is untouched."""
    with store.transaction():
        store.execute(_TABLE)
        store.execute(_INDEX)


# ══ small helpers ═══════════════════════════════════════════════════════


def _iso_now() -> str:
    raw = to_iso(utcnow())
    return _normalize_iso(raw)


def _normalize_iso(raw: str) -> str:
    """``to_iso`` may emit a ``Z`` suffix; SQLite string comparison needs one form."""
    return raw.replace("Z", "+00:00") if raw.endswith("Z") else raw


def parse_iso(raw: str | None) -> datetime | None:
    if not raw:
        return None
    text = raw.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        ts = datetime.fromisoformat(text)
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts


def coerce_length(value: Any) -> int:
    """Validate a summary-length budget. Raises :class:`ValidationError`.

    Any integer inside ``[LENGTH_MIN, LENGTH_MAX]`` is accepted, not only the
    presets, so a previously stored custom value keeps working.
    """
    if isinstance(value, bool) or value is None:
        raise ValidationError(f"summary length must be an integer, got {value!r}")
    try:
        n = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"summary length must be an integer, got {value!r}") from exc
    if n < LENGTH_MIN or n > LENGTH_MAX:
        raise ValidationError(
            f"summary length {n} out of range [{LENGTH_MIN}, {LENGTH_MAX}]"
        )
    return n


def nearest_preset(n: int) -> int:
    """Clamp an arbitrary budget onto the preset grid the slider exposes.

    Used to migrate values stored before the presets shrank to characters
    (e.g. a 100_000-character budget), instead of silently resetting them.
    """
    return min(LENGTH_PRESETS, key=lambda preset: (abs(preset - n), preset))


def coerce_mode(value: Any) -> str:
    """Return the fixed auto mode, whatever legacy value was stored.

    Older stores may hold "off" or "debounced" from when the mode was
    selectable. Those are no longer meaningful, so they read as AUTO_MODE
    instead of raising — an upgrade must not break on old state.
    """
    return AUTO_MODE


def coerce_scope(value: Any) -> str:
    scope = str(value or "project").strip().lower()
    if scope not in SCOPES:
        raise ValidationError(f"unknown scope {value!r}; expected one of {SCOPES}")
    return scope


def clip_to_budget(text: str, limit: int) -> tuple[str, bool]:
    """Trim ``text`` to at most ``limit`` characters on line boundaries.

    Returns ``(text, truncated)``. A single overlong line is clipped at the
    character boundary as a last resort, never in the middle of a surrogate
    pair (Python strings do not split there, but U+2028/LF handling still
    matters to Markdown consumers).
    """
    text = text or ""
    if limit <= 0:
        return "", bool(text.strip())
    if len(text) <= limit:
        return text, False
    window = text[:limit]
    cut = window.rfind("\n")
    if cut >= max(0, limit // 2):
        window = window[:cut]
    marker = "\n\n…（已按预算截断）"
    if len(window) + len(marker) <= limit:
        window += marker
    # The marker itself may not fit (a very small custom budget): hard-trim.
    # The trailing newline is part of the result, so reserve room for it.
    body = window.rstrip()
    return body[: max(1, limit - 1)].rstrip() + "\n", True


def normalize_summary(text: str) -> str:
    """Strip wrappers a model likes to add around a Markdown answer."""
    text = (text or "").strip()
    text = re.sub(r"^```(?:markdown|md)?\s*\n", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\n```\s*$", "", text)
    return text.strip()


# ══ configuration (stored in ``meta``, so it survives without a migration) ═

META_LENGTH = "memory.summary.length"
META_MODE = "memory.summary.auto"
META_UPDATED = "memory.summary.updated_at"
META_PROFILE = "memory.user_profile"
META_PROFILE_UPDATED = "memory.user_profile.updated_at"


@dataclass(slots=True)
class SummarySettings:
    """Everything the host's settings page persists for the memory feature."""

    length: int = DEFAULT_LENGTH
    mode: str = AUTO_MODE  # fixed: summaries generate when the host is idle
    updated_at: str | None = None
    profile: str = ""
    profile_updated_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "length": self.length,
            "presets": list(LENGTH_PRESETS),
            "min": LENGTH_MIN,
            "max": LENGTH_MAX,
            "mode": self.mode,
            "updated_at": self.updated_at,
            "profile": self.profile,
            "profile_updated_at": self.profile_updated_at,
            "profile_max_chars": PROFILE_MAX_CHARS,
        }


def load_settings(store: Store) -> SummarySettings:
    length = DEFAULT_LENGTH
    raw_len = store.get_meta(META_LENGTH)
    if raw_len:
        try:
            length = coerce_length(raw_len)
        except ValidationError:
            # A budget stored under an older, much larger preset grid: snap it
            # onto the current presets rather than dropping the user's choice.
            try:
                length = nearest_preset(int(raw_len))
            except (TypeError, ValueError):
                length = DEFAULT_LENGTH
    mode = coerce_mode(store.get_meta(META_MODE))
    return SummarySettings(
        length=length,
        mode=mode,
        updated_at=store.get_meta(META_UPDATED),
        profile=store.get_meta(META_PROFILE) or "",
        profile_updated_at=store.get_meta(META_PROFILE_UPDATED),
    )


# ══ materials ═══════════════════════════════════════════════════════════


@dataclass(slots=True)
class Materials:
    """What the model is allowed to read when writing one digest."""

    scope: str
    project_ids: list[str]
    episodes: list[dict[str, Any]]
    facts: list[dict[str, Any]]
    profile: str
    user_texts: list[str]
    chars: int = 0

    def render(self, *, max_chars: int) -> str:
        """One Markdown block, trimmed *within* sections to fit ``max_chars``.

        Trimming happens per line, not per section: dropping a whole section
        when the total overshoots by one character turns "34 memories" into
        "the memory store is empty", and the digest is then generated from
        nothing. Sections are emitted in priority order (requests, facts,
        events, profile) and each one takes the space it needs until the
        budget runs out; the profile is reserved first because it is the
        shortest section and the only one the user wrote by hand.
        """
        budget = max_chars
        if budget <= 0:
            return ""
        sections: list[tuple[str, list[str]]] = []
        if self.user_texts:
            sections.append(
                ("## 用户最近的请求", [f"- {_one_line(t, 240)}" for t in self.user_texts[:10]])
            )
        if self.facts:
            sections.append(
                (
                    "## 已确认的事实",
                    [
                        f"- {f['head']} --{f['relation']}--> {f['tail']}"
                        f"（{f['project_id']}，置信度 {f['confidence']:.2f}）"
                        for f in self.facts
                    ],
                )
            )
        if self.episodes:
            sections.append(
                (
                    "## 事件（由新到旧）",
                    [
                        f"- [{e['created_at'][:16]}]（{e['project_id']}，"
                        f"{e.get('event_type') or 'event'}，重要度 {e['importance']:.2f}）"
                        f"{_one_line(e['summary'], 400)}"
                        for e in self.episodes
                    ],
                )
            )
        profile = self.profile.strip()
        if profile:
            sections.append(("## 用户画像（已由用户确认）", [profile]))

        # Reserve the profile first, then spend what is left in priority order.
        reserve = 0
        if profile:
            reserve = min(len(profile) + len(sections[-1][0]) + 2, budget)
        remaining = budget - reserve
        out: list[str] = []
        for title, lines in sections:
            if title.startswith("## 用户画像"):
                out.append(f"{title}\n{profile}")
                continue
            if remaining <= len(title) + 2:
                continue
            keep: list[str] = []
            used = len(title) + 1
            for line in lines:
                cost = len(line) + 1
                if used + cost > remaining:
                    break
                keep.append(line)
                used += cost
            if keep:
                out.append(f"{title}\n" + "\n".join(keep))
                remaining -= used
            if remaining <= 0:
                break
        text = "\n\n".join(out)
        if len(text) > budget:
            text = text[:budget]
        return text


def _one_line(text: str | None, limit: int) -> str:
    collapsed = " ".join((text or "").split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1] + "…"


def collect_materials(
    memory: MemorySystem,
    *,
    scope: str,
    project_id: str | None,
    material_char_budget: int,
    episodes_per_project: int = 160,
    facts_per_project: int = 120,
) -> Materials:
    """Gather episodes, current facts and the user profile for one digest."""
    scope = coerce_scope(scope)
    project_ids: list[str] = []
    if scope == "project":
        if not project_id:
            raise ValidationError("scope='project' requires project_id")
        project_ids = [project_id]
    else:
        project_ids = [p.project_id for p in memory.list_projects()]

    store = memory.store
    episodes: list[dict[str, Any]] = []
    for pid in project_ids:
        rows = store.query(
            "SELECT memory_id, project_id, summary, importance, event_type, outcome, "
            "created_at, state FROM l2_episodes WHERE project_id = ? AND superseded_by IS NULL "
            "ORDER BY created_at DESC LIMIT ?",
            (pid, episodes_per_project),
        )
        for row in rows:
            episodes.append(
                {
                    "memory_id": row["memory_id"],
                    "project_id": row["project_id"],
                    "summary": row["summary"],
                    "importance": float(row["importance"]),
                    "event_type": row["event_type"],
                    "outcome": row["outcome"],
                    "created_at": _normalize_iso(row["created_at"]),
                    "state": row["state"],
                }
            )
    episodes.sort(key=lambda e: e["created_at"], reverse=True)

    facts: list[dict[str, Any]] = []
    for pid in project_ids:
        rows = store.query(
            "SELECT e.edge_id, e.relation, e.confidence, h.name AS head_name, t.name AS tail_name "
            "FROM l3_edges e JOIN l3_entities h ON h.entity_id = e.head_id "
            "JOIN l3_entities t ON t.entity_id = e.tail_id "
            "WHERE e.project_id = ? AND e.valid_to IS NULL ORDER BY e.confidence DESC, e.rowid DESC "
            "LIMIT ?",
            (pid, facts_per_project),
        )
        for row in rows:
            facts.append(
                {
                    "edge_id": row["edge_id"],
                    "project_id": pid,
                    "head": row["head_name"],
                    "relation": row["relation"],
                    "tail": row["tail_name"],
                    "confidence": float(row["confidence"]),
                }
            )

    profile = store.get_meta(META_PROFILE) or ""
    user_texts: list[str] = []
    if project_ids:
        marks = ",".join("?" * len(project_ids))
        rows = store.query(
            f"SELECT user_text FROM l4_launches WHERE project_id IN ({marks}) "
            "AND user_text IS NOT NULL AND user_text != '' ORDER BY created_at DESC LIMIT 12",
            project_ids,
        )
        user_texts = [row["user_text"] for row in rows]

    materials = Materials(
        scope=scope,
        project_ids=project_ids,
        episodes=episodes,
        facts=facts,
        profile=profile,
        user_texts=user_texts,
    )
    materials.chars = sum(len(e["summary"]) for e in episodes) + len(profile)
    return materials


# ══ prompts ═════════════════════════════════════════════════════════════

SYSTEM_PROMPT = """你是「DSH 记忆系统」的记忆摘要生成器。输入是从记忆库中检索出的原始材料：用户最近的请求、已确认的事实、按时间排列的事件，以及用户自己维护的用户画像。

你的任务：把它们写成分层、可快速浏览的记忆摘要，供编码 Agent 注入系统提示词时参考。

要求：
1. 直接输出 Markdown，不要任何前言、解释、或代码块围栏。
2. 先写高层结论，再写细节；信息按"现在仍然成立"优先排列。
3. 合并同类项：同一主题的多次事件写成一条，保留关键的时间、文件、命令、决策与失败原因。
4. 明确区分事实、决策与未解决的问题；推测必须标注为推测。
5. 过时或被取代的信息要写出它被什么取代，不要直接删除历史。
6. 不要编造材料里没有的信息；材料不足时宁可写短。
7. 中文材料用中文写，英文材料保留原文关键词（标识符、路径、命令不要翻译）。
8. 建议结构：## 项目状态 / ## 关键决策与事实 / ## 未完成与遗留问题 / ## 用户偏好。没有内容的小节直接省略。

长度：目标不超过约 {target_chars} 个字符（这是预算，不是必须写满的指标）。"""

USER_TEMPLATE = """记忆范围：{scope_label}
生成时间：{now}

# 原始材料

{materials}"""


@dataclass(slots=True)
class DigestRequest:
    """One LLM call the host performs. Serializable, so it can cross a process."""

    scope: str
    scope_ref: str | None
    target_chars: int
    system: str
    user: str
    prompt_version: int
    prompt_hash: str
    material_chars: int
    sources: list[str] = field(default_factory=list)
    materials: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "scope_ref": self.scope_ref,
            "target_chars": self.target_chars,
            "system": self.system,
            "user": self.user,
            "prompt_version": self.prompt_version,
            "prompt_hash": self.prompt_hash,
            "material_chars": self.material_chars,
            "sources": list(self.sources),
            "materials": dict(self.materials),
        }

    @property
    def has_materials(self) -> bool:
        return bool(self.user.strip()) and not self.user.rstrip().endswith("# 原始材料")


@dataclass(slots=True)
class DigestRecord:
    digest_id: str
    scope: str
    scope_ref: str | None
    status: str
    content: str
    requested_chars: int
    actual_chars: int
    estimated_tokens: int
    sources: list[str]
    materials_chars: int
    prompt_version: int
    generator: str | None
    reason: str | None
    error: str | None
    created_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "digest_id": self.digest_id,
            "scope": self.scope,
            "scope_ref": self.scope_ref,
            "status": self.status,
            "content": self.content,
            "requested_chars": self.requested_chars,
            "actual_chars": self.actual_chars,
            "estimated_tokens": self.estimated_tokens,
            "sources": list(self.sources),
            "materials_chars": self.materials_chars,
            "prompt_version": self.prompt_version,
            "generator": self.generator,
            "reason": self.reason,
            "error": self.error,
            "created_at": self.created_at,
        }

    @classmethod
    def from_row(cls, row: Any) -> "DigestRecord":
        return cls(
            digest_id=row["digest_id"],
            scope=row["scope"],
            scope_ref=row["scope_ref"],
            status=row["status"],
            content=row["content"],
            requested_chars=int(row["requested_chars"]),
            actual_chars=int(row["actual_chars"]),
            estimated_tokens=int(row["estimated_tokens"]),
            sources=json.loads(row["sources"] or "[]"),
            materials_chars=int(row["materials_chars"]),
            prompt_version=int(row["prompt_version"]),
            generator=row["generator"],
            reason=row["reason"],
            error=row["error"],
            created_at=row["created_at"],
        )


def _scope_predicate(scope: str, project_id: str | None) -> tuple[str, list[Any]]:
    scope = coerce_scope(scope)
    if scope == "project":
        if not project_id:
            raise ValidationError("scope='project' requires project_id")
        return "scope = 'project' AND scope_ref = ?", [project_id]
    return "scope = 'global'", []


class DigestService:
    """Digest + profile storage and planning. Owns no model.

    ``memory`` may be a :class:`MemorySystem` (preferred) or a bare
    :class:`Store`; the latter is enough for every method except materials
    collection, which needs a project list.
    """

    def __init__(self, memory: MemorySystem | Store) -> None:
        self.store = memory.store if isinstance(memory, MemorySystem) else memory
        self._memory = memory if isinstance(memory, MemorySystem) else None
        ensure_schema(self.store)

    # ── settings ───────────────────────────────────────────────────────
    def settings(self) -> SummarySettings:
        return load_settings(self.store)

    def set_length(self, length: Any) -> SummarySettings:
        value = coerce_length(length)
        with self.store.transaction():
            self.store.set_meta(META_LENGTH, str(value))
            self.store.set_meta(META_UPDATED, _iso_now())
        return self.settings()

    def set_mode(self, mode: Any) -> SummarySettings:
        """Record the fixed auto mode; kept so old callers keep working."""
        value = coerce_mode(mode)
        with self.store.transaction():
            self.store.set_meta(META_MODE, value)
            self.store.set_meta(META_UPDATED, _iso_now())
        return self.settings()

    # ── profile ────────────────────────────────────────────────────────
    def get_profile(self) -> str:
        return self.store.get_meta(META_PROFILE) or ""

    def set_profile(self, text: str) -> SummarySettings:
        text = text or ""
        if len(text) > PROFILE_MAX_CHARS:
            raise ValidationError(
                f"profile is {len(text)} chars; limit is {PROFILE_MAX_CHARS}"
            )
        with self.store.transaction():
            self.store.set_meta(META_PROFILE, text)
            self.store.set_meta(META_PROFILE_UPDATED, _iso_now())
        return self.settings()

    # ── plans ──────────────────────────────────────────────────────────
    def plan(
        self,
        *,
        scope: str = "project",
        project_id: str | None = None,
        project_label: str | None = None,
        length: int | None = None,
        include_profile: bool = True,
    ) -> DigestRequest:
        """Build the LLM request; the host runs it and calls :meth:`commit`."""
        scope = coerce_scope(scope)
        settings = self.settings()
        target = coerce_length(length if length is not None else settings.length)
        if scope == "project" and not project_id:
            raise ValidationError("scope='project' requires project_id")
        # Materials are capped so a 4M-character digest request can never turn
        # into a 400k-token prompt: the model reads a bounded digest of the
        # corpus and the budget is a ceiling on its *output*.
        material_budget = min(120_000, max(8_000, target // 4))
        materials = self._materials(
            scope=scope,
            project_id=project_id,
            material_char_budget=material_budget,
            include_profile=include_profile,
        )
        body = materials.render(max_chars=material_budget)
        scope_label = (
            "全局（所有项目）" if scope == "global" else f"项目 {project_label or project_id}"
        )
        system = SYSTEM_PROMPT.format(target_chars=target)
        user = USER_TEMPLATE.format(
            scope_label=scope_label,
            now=_iso_now(),
            materials=body or "（记忆库为空：请输出一句说明，不要编造内容）",
        )
        digest_hash = hashlib.sha1(
            f"{PROMPT_VERSION}\x00{target}\x00{scope}\x00{project_id}\x00{body}".encode("utf-8")
        ).hexdigest()
        return DigestRequest(
            scope=scope,
            scope_ref=project_id if scope == "project" else None,
            target_chars=target,
            system=system,
            user=user,
            prompt_version=PROMPT_VERSION,
            prompt_hash=digest_hash,
            material_chars=len(body),
            sources=[e["memory_id"] for e in materials.episodes],
            materials={
                "episodes": len(materials.episodes),
                "facts": len(materials.facts),
                "profile_chars": len(materials.profile),
                "projects": len(materials.project_ids),
            },
        )

    def _materials(
        self,
        *,
        scope: str,
        project_id: str | None,
        material_char_budget: int,
        include_profile: bool,
    ) -> Materials:
        if self._memory is not None:
            materials = collect_materials(
                self._memory,
                scope=scope,
                project_id=project_id,
                material_char_budget=material_char_budget,
            )
        else:  # pragma: no cover - Store-only path is for tests of settings only
            materials = Materials(
                scope=scope,
                project_ids=[project_id] if project_id else [],
                episodes=[],
                facts=[],
                profile=self.get_profile() or "",
                user_texts=[],
            )
        if not include_profile:
            materials.profile = ""
        return materials

    # ── commit / read ──────────────────────────────────────────────────
    def commit(
        self,
        *,
        scope: str,
        project_id: str | None,
        text: str,
        length: int | None = None,
        reason: str = "manual",
        generator: str | None = None,
        prompt_version: int = PROMPT_VERSION,
        sources: Sequence[str] = (),
        materials_chars: int = 0,
        error: str | None = None,
    ) -> DigestRecord:
        """Store model output, clipped to the configured budget."""
        scope = coerce_scope(scope)
        script = self.settings()
        target = coerce_length(length if length is not None else script.length)
        cleaned = normalize_summary(text or "")
        status = "ok"
        if error:
            status = "error"
            cleaned = cleaned or ""
        elif not cleaned:
            status = "empty"
        if isinstance(sources, (str, bytes)):
            sources = [sources]
        content, truncated = clip_to_budget(cleaned or "", target)
        if status == "ok" and truncated:
            status = "truncated"
        record = DigestRecord(
            digest_id="dg_" + uuid.uuid4().hex[:16],
            scope=scope,
            scope_ref=project_id if scope == "project" else None,
            status=status,
            content=content,
            requested_chars=target,
            actual_chars=len(content),
            estimated_tokens=estimate_tokens(content),
            sources=list(str(s) for s in sources),
            materials_chars=int(materials_chars or 0),
            prompt_version=int(prompt_version or PROMPT_VERSION),
            generator=generator,
            reason=reason,
            error=error,
            created_at=_iso_now(),
        )
        with self.store.transaction():
            self.store.execute(
                """INSERT INTO memory_digests
                   (digest_id, scope, scope_ref, status, content, requested_chars, actual_chars,
                    estimated_tokens, sources, materials_chars, prompt_version, generator, reason,
                    error, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    record.digest_id,
                    record.scope,
                    record.scope_ref,
                    record.status,
                    record.content,
                    record.requested_chars,
                    record.actual_chars,
                    record.estimated_tokens,
                    json.dumps(record.sources, ensure_ascii=False),
                    record.materials_chars,
                    record.prompt_version,
                    record.generator,
                    record.reason,
                    record.error,
                    record.created_at,
                ),
            )
            self.store.set_meta(META_UPDATED, record.created_at)
        return record

    def latest(
        self, *, scope: str = "project", project_id: str | None = None
    ) -> DigestRecord | None:
        clause, params = _scope_predicate(scope, project_id)
        row = self.store.query_one(
            f"SELECT * FROM memory_digests WHERE {clause} AND status IN ('ok','truncated') "
            "ORDER BY created_at DESC LIMIT 1",
            params,
        )
        return DigestRecord.from_row(row) if row else None

    def history(
        self, *, scope: str = "project", project_id: str | None = None, limit: int = 20
    ) -> list[DigestRecord]:
        clause, params = _scope_predicate(scope, project_id)
        rows = self.store.query(
            f"SELECT * FROM memory_digests WHERE {clause} ORDER BY created_at DESC LIMIT ?",
            (*params, max(1, min(int(limit or 20), 200))),
        )
        return [DigestRecord.from_row(r) for r in rows]

    def get(self, digest_id: str) -> DigestRecord | None:
        row = self.store.query_one(
            "SELECT * FROM memory_digests WHERE digest_id = ?", (digest_id,)
        )
        return DigestRecord.from_row(row) if row else None

    def delete(self, digest_id: str) -> bool:
        row = self.store.query_one(
            "SELECT digest_id FROM memory_digests WHERE digest_id = ?", (digest_id,)
        )
        if row is None:
            return False
        with self.store.transaction():
            self.store.execute("DELETE FROM memory_digests WHERE digest_id = ?", (digest_id,))
        return True

    # ── prompt anchors ─────────────────────────────────────────────────
    def anchors(
        self,
        *,
        project_id: str | None = None,
        include_summary: bool | None = None,
        include_profile: bool = True,
        scope: str = "project",
    ) -> dict[str, Any]:
        """What the host should tell the model about memory, this turn.

        Returns ``{"summary": {...}|None, "profile": {...}|None, "text": "..."}``.
        The rendered ``text`` is the context anchor block; it is empty when
        there is nothing worth saying.
        """
        # Nothing ever persisted this flag, so it was always the default: an
        # anchor carries the digest unless the caller says otherwise.
        want_summary = True if include_summary is None else include_summary
        blocks: list[str] = []
        summary_line = None
        profile_line = None

        if want_summary:
            latest = self.latest(scope=scope, project_id=project_id)
            # A global anchor with no global digest yet must not hide the
            # project digest: the model would lose the memory context it had
            # before anyone asked for a global one.
            if latest is None and scope == "global" and project_id:
                latest = self.latest(scope="project", project_id=project_id)
            if latest is not None and latest.content.strip():
                updated = latest.created_at[:16].replace("T", " ")
                stale = _age_days(latest.created_at) >= 7
                summary_line = {
                    "digest_id": latest.digest_id,
                    "created_at": latest.created_at,
                    "chars": latest.actual_chars,
                    "estimated_tokens": latest.estimated_tokens,
                    "scope": latest.scope,
                    "stale": stale,
                }

        profile = self.get_profile().strip() if include_profile else ""
        if profile:
            updated = (self.store.get_meta(META_PROFILE_UPDATED) or "")[:16].replace("T", " ")
            profile_line = {"chars": len(profile), "updated_at": updated}

        if summary_line is None and profile_line is None:
            return {"summary": None, "profile": None, "text": ""}

        lines = ["@@dsh-memory 1", "记忆系统已启用。"]
        if summary_line is not None:
            lines.append(
                f"- 记忆摘要：{summary_line['chars']} 字（约 {summary_line['estimated_tokens']} tokens），"
                f"生成于 {summary_line['created_at'][:16].replace('T', ' ')}"
                + ("，可能已过时" if summary_line["stale"] else "")
            )
            lines.append("- 需要摘要全文时调用 memory_digest_read（source=\"summary\"）；需要最新内容时调用 memory_digest_generate。")
        if profile_line is not None:
            lines.append(
                f"- 用户画像：{profile_line['chars']} 字，用户自行维护"
                + (f"，更新于 {profile_line['updated_at']}" if profile_line["updated_at"] else "")
            )
            lines.append("- 涉及用户偏好、习惯、技术栈或协作方式时，调用 memory_profile_read 读取完整画像。")
        lines.append("提示：记忆是与当前工作目录对应的项目记忆，引用它时请说明来源。")
        lines.append("@@")
        return {"summary": summary_line, "profile": profile_line, "text": "\n".join(lines)}


def _age_days(raw: str) -> float:
    ts = parse_iso(raw)
    if ts is None:
        return 0.0
    return max(0.0, (datetime.now(timezone.utc) - ts).total_seconds() / 86400.0)


# ══ Markdown export (digest + profile + memories) ═══════════════════════


def _md_escape(value: str | None) -> str:
    return " ".join((value or "").split())


@dataclass(slots=True)
class MemoryView:
    """One editable memory row as the UI sees it."""

    memory_id: str
    project_id: str
    summary: str
    importance: float
    event_type: str | None
    outcome: str | None
    state: str
    created_at: str
    last_access: str
    access_count: int
    participants: list[str]
    anchor_id: str | None
    session_key: str | None
    retention: float
    tags: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "memory_id": self.memory_id,
            "project_id": self.project_id,
            "summary": self.summary,
            "importance": round(self.importance, 3),
            "event_type": self.event_type,
            "outcome": self.outcome,
            "state": self.state,
            "created_at": self.created_at,
            "last_access": self.last_access,
            "access_count": self.access_count,
            "participants": list(self.participants),
            "anchor_id": self.anchor_id,
            "session_key": self.session_key,
            "retention": round(self.retention, 4),
            "tags": list(self.tags),
        }


class MemoryNotepad:
    """Host-facing editing surface over L2 episodes and the sticky notes.

    Editing is deliberately narrow: an episode's text, importance, type,
    outcome and tags can change, and an episode can be *forgotten* (excluded
    from retrieval) or restored. Nothing is physically deleted, which is the
    same rule the decay layer follows (DESIGN.md §L2: 降权，永不物理删除).
    """

    TAGS = "memory.tags"

    def __init__(self, memory: MemorySystem) -> None:
        self.memory = memory
        self.store = memory.store
        ensure_schema(self.store)

    # ── tags (stored in meta as {memory_id: [tags]}) ───────────────────
    def _tags(self) -> dict[str, list[str]]:
        raw = self.store.get_meta(self.TAGS)
        if not raw:
            return {}
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return {str(k): [str(t) for t in v] for k, v in data.items() if isinstance(v, list)}

    def tags_for(self, memory_id: str) -> list[str]:
        return self._tags().get(memory_id, [])

    def set_tags(self, memory_id: str, tags: Iterable[str]) -> list[str]:
        clean: list[str] = []
        for tag in tags or ():
            value = " ".join(str(tag).split())[:40]
            if value and value not in clean:
                clean.append(value)
        mapping = self._tags()
        if clean:
            mapping[memory_id] = clean
        else:
            mapping.pop(memory_id, None)
        with self.store.transaction():
            self.store.set_meta(self.TAGS, json.dumps(mapping, ensure_ascii=False))
        return clean

    # ── listing ────────────────────────────────────────────────────────
    def list(
        self,
        *,
        project_id: str | None = None,
        query: str | None = None,
        state: str | None = None,
        event_type: str | None = None,
        limit: int = 50,
        offset: int = 0,
        include_superseded: bool = False,
    ) -> dict[str, Any]:
        where: list[str] = []
        params: list[Any] = []
        if project_id:
            where.append("project_id = ?")
            params.append(project_id)
        if query:
            where.append("(summary LIKE ? OR event_type LIKE ?)")
            like = f"%{query.strip()}%"
            params.extend([like, like])
        if state:
            where.append("state = ?")
            params.append(state)
        else:
            # "No state filter" means "the memories that are still in play", not
            # "everything ever written": the default listing feeds the entry
            # counter in the UI, which must not count what the user asked to
            # forget. Pass ``state="archived"`` to see those.
            where.append("state != 'archived'")
        if event_type:
            where.append("event_type = ?")
            params.append(event_type)
        if not include_superseded:
            where.append("superseded_by IS NULL")
        clause = " AND ".join(where) if where else "1=1"
        total = int(self.store.scalar(f"SELECT count(*) FROM l2_episodes WHERE {clause}", params, 0) or 0)
        rows = self.store.query(
            f"SELECT * FROM l2_episodes WHERE {clause} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (*params, max(1, min(int(limit), 500)), max(0, int(offset))),
        )
        tag_map = self._tags()
        items = [self._view(row, tag_map).to_dict() for row in rows]
        return {"total": total, "items": items, "limit": limit, "offset": offset}

    def get(self, memory_id: str) -> dict[str, Any]:
        row = self.store.query_one("SELECT * FROM l2_episodes WHERE memory_id = ?", (memory_id,))
        if row is None:
            raise ValidationError(f"memory {memory_id} not found")
        return self._view(row, self._tags()).to_dict()

    def _view(self, row: Any, tag_map: dict[str, list[str]]) -> MemoryView:
        from .l2 import Episode

        episode = Episode.from_row(row)
        retention = self.memory.l2.compute(episode).retention
        return MemoryView(
            memory_id=episode.memory_id,
            project_id=episode.project_id,
            summary=episode.summary,
            importance=episode.importance,
            event_type=episode.event_type,
            outcome=episode.outcome,
            state=episode.state,
            created_at=_normalize_iso(episode.created_at),
            last_access=_normalize_iso(episode.last_access),
            access_count=episode.access_count,
            participants=list(episode.participants),
            anchor_id=episode.anchor_id,
            session_key=episode.session_key,
            retention=retention,
            tags=tag_map.get(episode.memory_id, []),
        )

    # ── edits ──────────────────────────────────────────────────────────
    def update(self, memory_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        row = self.store.query_one("SELECT * FROM l2_episodes WHERE memory_id = ?", (memory_id,))
        if row is None:
            raise ValidationError(f"memory {memory_id} not found")
        sets: list[str] = []
        params: list[Any] = []
        if "summary" in patch:
            summary = " ".join(str(patch["summary"] or "").split())
            if not summary:
                raise ValidationError("summary must be non-empty")
            if len(summary) > SUMMARY_MAX_CHARS:
                raise ValidationError(f"summary is longer than {SUMMARY_MAX_CHARS} characters")
            sets += ["summary = ?", "summary_hash = ?"]
            from .l2 import summary_hash

            params += [summary, summary_hash(summary)]
        if "importance" in patch:
            try:
                importance = float(patch["importance"])
            except (TypeError, ValueError) as exc:
                raise ValidationError("importance must be a number in [0, 1]") from exc
            if not 0.0 <= importance <= 1.0:
                raise ValidationError("importance must be a number in [0, 1]")
            sets.append("importance = ?")
            params.append(importance)
        if "event_type" in patch:
            value = (str(patch["event_type"]).strip() or None) if patch["event_type"] is not None else None
            sets.append("event_type = ?")
            params.append(value)
        if "outcome" in patch:
            value = str(patch["outcome"]).strip() if patch.get("outcome") is not None else None
            sets.append("outcome = ?")
            params.append(value or None)
        if "state" in patch:
            state = str(patch["state"]).lower()
            if state not in ("active", "dormant", "archived"):
                raise ValidationError("state must be active | dormant | archived")
            sets.append("state = ?")
            params.append(state)
        # `tags` is not a column: it lives in a meta blob and is written through
        # set_tags below. A patch that only touches tags is still a real edit,
        # so it must not trip the empty-patch guard.
        has_tags = "tags" in patch
        if not sets and not has_tags:
            raise ValidationError("nothing to update")
        if sets:
            sets.append("updated_at = ?")
            params.append(_iso_now())
            params.append(memory_id)
        with self.store.transaction():
            if sets:
                self.store.execute(f"UPDATE l2_episodes SET {', '.join(sets)} WHERE memory_id = ?", params)
            # Keep the lexical index in step with the text. The body goes through
            # the same segmentation the write path uses, or an edited row would
            # silently drop out of Chinese lexical recall.
            if "summary" in patch:
                current = self.store.query_one(
                    "SELECT * FROM l2_episodes WHERE memory_id = ?", (memory_id,)
                )
                self.store.execute("DELETE FROM l2_fts WHERE memory_id = ?", (memory_id,))
                self.store.execute(
                    "INSERT INTO l2_fts(memory_id, body) VALUES (?, ?)",
                    (
                        memory_id,
                        fts_index_text(
                            f"{current['summary']} {current['event_type'] or ''}",
                            tokenizer=self.memory.config.lexical.tokenizer,
                        ),
                    ),
                )
            # Tags live in a meta blob, so they are written through their own
            # helper. Keep it inside this transaction: otherwise a failure
            # leaves the fields updated but the tags silently stale.
            if "tags" in patch:
                self.set_tags(memory_id, patch.get("tags") or ())
        return self.get(memory_id)

    def forget(self, memory_id: str) -> dict[str, Any]:
        """Soft-delete: archived, and marked so recall will not resurface it.

        The ``forgotten_at`` marker travels outside ``state`` on purpose — decay
        also writes ``state='archived'``, and only an explicit user instruction
        should pin an item out of recall regardless of the retention window.
        """
        return self._mark_forgotten(memory_id, forgotten=True)

    def restore(self, memory_id: str) -> dict[str, Any]:
        return self._mark_forgotten(memory_id, forgotten=False)

    def _mark_forgotten(self, memory_id: str, *, forgotten: bool) -> dict[str, Any]:
        updated = self.update(memory_id, {"state": "archived" if forgotten else "active"})
        with self.store.transaction():
            if forgotten:
                self.store.execute(
                    "UPDATE l2_episodes SET meta = json_set(meta, '$.forgotten_at', ?) WHERE memory_id = ?",
                    (_iso_now(), memory_id),
                )
            else:
                self.store.execute(
                    "UPDATE l2_episodes SET meta = json_remove(meta, '$.forgotten_at') WHERE memory_id = ?",
                    (memory_id,),
                )
        return self.get(memory_id)


# ══ Markdown export ═════════════════════════════════════════════════════

BACKUP_MARKER = "dsh-memory-backup"


def export_markdown(
    memory: MemorySystem,
    *,
    projects: Sequence[str] | None = None,
    include_digests: bool = True,
    include_profile: bool = True,
    max_episodes: int = 2000,
) -> str:
    """One Markdown document: header JSON, profile, digests, memories, facts."""
    service = DigestService(memory)
    notepad = MemoryNotepad(memory)
    all_projects = [p.project_id for p in memory.list_projects()]
    selected = [p for p in all_projects if not projects or p in projects]
    header = {
        "format": BACKUP_MARKER,
        "version": 1,
        "exported_at": _iso_now(),
        "projects": selected,
        "prompt_version": PROMPT_VERSION,
    }
    out: list[str] = [
        "# DSH 记忆备份",
        "",
        f"> 由 DSH 记忆系统导出 · {header['exported_at'][:19].replace('T', ' ')} · "
        f"项目：{', '.join(selected) if selected else '（无）'}",
        "",
        f"<!--{BACKUP_MARKER}:{json.dumps(header, ensure_ascii=False)}-->",
        "",
    ]

    if include_profile:
        profile = service.get_profile()
        out += ["## 用户画像", "", profile.strip() or "（空）", ""]

    if include_digests:
        digests = service.history(scope="global", limit=5)
        for pid in selected:
            digests += service.history(scope="project", project_id=pid, limit=3)
        digests.sort(key=lambda d: d.created_at, reverse=True)
        if digests:
            out += ["## 记忆摘要", ""]
            for digest in digests:
                where = "全局" if digest.scope == "global" else digest.scope_ref
                out += [
                    f"### 摘要 {digest.digest_id}（{where} · {digest.status} · "
                    f"{digest.actual_chars} 字 · {digest.created_at[:19].replace('T', ' ')}）",
                    "",
                    digest.content.strip() or "（空）",
                    "",
                ]

    out += ["## 记忆条目", ""]
    exported = 0
    for pid in selected:
        if exported >= max_episodes:
            break
        # Explicit state so the cap is honoured and archived rows stay out of
        # the default backup; without ``state`` the listing would fall back to
        # its "everything still in play" default.
        listing = notepad.list(
            project_id=pid,
            limit=max(1, max_episodes - exported),
            include_superseded=True,
            state="active",
        )
        if not listing["items"]:
            continue
        out += [f"### 项目 {pid}", ""]
        for item in listing["items"]:
            if exported >= max_episodes:
                break
            exported += 1
            out += [
                f"- [ ] `{item['memory_id']}` `{item['state']}` `{item['event_type'] or 'event'}` "
                f"重要度 {item['importance']:.2f} · {item['created_at'][:19].replace('T', ' ')}"
                + (f" · 标签：{', '.join(item['tags'])}" if item["tags"] else ""),
                f"  - {_md_escape(item['summary'])}",
                f"  - 项目: `{item['project_id']}`",
            ]
            if item.get("outcome"):
                out.append(f"  - 结果: {_md_escape(item['outcome'])}")

    out += ["", "## 事实（知识图谱）", ""]
    for pid in selected:
        edges = memory.edges(pid, current_only=True)
        if not edges:
            continue
        names = {e.entity_id: e.name for e in memory.entities(pid)}
        out += [f"### 项目 {pid}", ""]
        for edge in edges:
            out.append(
                f"- `{edge.edge_id}` {names.get(edge.head_id, edge.head_id)} --"
                f"{edge.relation}--> {names.get(edge.tail_id, edge.tail_id)} "
                f"（置信度 {edge.confidence:.2f}）"
            )
        out.append("")
    return "\n".join(out).rstrip() + "\n"