"""Memory digest and user profile — the text a host injects into a system prompt.

The digest is a **single global work log across every project**. Its job is to
tell a later model what has already been done, so it deliberately excludes
lessons, preferences, speculation and future plans. Each project also gets a
Markdown summary file at its repository root (``DSH_MEMORY.md``) so the project
itself carries a readable record of its work.

**Generation is a pure function of the prompt.** :class:`DigestService` turns a
selection of memories into a *request* (system + user message, prompt version,
hash). The host runs that request with whatever model it owns and hands the
text back to :meth:`DigestService.commit`. Nothing here calls a model, imports a
host SDK, or schedules work; that keeps this module testable with a fake
generator and keeps the model choice where it belongs (the host).

**Length is a budget, not a clip.** The slider value is a *character* target
that is passed to the model, together with explicit instructions for how much
detail each band should carry. The committed text is stored exactly as the
model wrote it: a budget is a generation instruction, not a pair of scissors.

**Context anchors stay small.** A context anchor is an eight-line block
(``@@dsh-memory ... @@``) that tells the model the digest exists, how to refresh
it and how to look at the user profile. It never contains the digest body or
profile body; it only contains counts and commands. It is rendered from the
*current* state every turn, so it can never go stale.

Everything persistent lives in ``meta`` (small key/value post-its) and one
append-only ``memory_digests`` table whose schema is created lazily by
:func:`ensure_schema`. Project Markdown files are derived artifacts: they are
rewritten from L2 episodes and never read back as the source of truth.

Prompt versions: bump :data:`PROMPT_VERSION` whenever the instructions change,
because a digest generated under different instructions is not a valid cache of
the current configuration.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from .errors import ConflictError, NotFoundError, ValidationError
from .storage import Store, to_iso, utcnow
from .system import MemorySystem
from .text import estimate_tokens

# ══ constants ═══════════════════════════════════════════════════════════

PROMPT_VERSION = 3
LENGTH_PRESETS: tuple[int, ...] = (300, 500, 800, 1_000, 1_500, 2_000, 3_000)
LENGTH_MIN = LENGTH_PRESETS[0]
LENGTH_MAX = LENGTH_PRESETS[-1]
DEFAULT_LENGTH = 1_000
PROFILE_MAX_CHARS = 100_000
# The standing instruction rides in every request as a system-prompt section,
# so it is paid for on every turn. 4000 characters fits a real "soul.md"
# without letting one paste quietly multiply the resident prefix cost.
INSTRUCTION_MAX_CHARS = 4_000
# Ceiling for one memory's summary text, shared by the editor and the restore
# path so a backup written by another host still round-trips.
SUMMARY_MAX_CHARS = 8_000

LENGTH_REPLACE = "replace"
LENGTH_APPEND = "append"

# Automatic summary generation always runs when the host is idle; there is no
# user-facing switch, so the stored mode is a single fixed value.
AUTO_MODE = "idle"
# Only one digest is generated: a cross-project work log. "project" survives
# solely as a legacy storage value so old rows/backups can still be read; it is
# never generated again.
SCOPES: tuple[str, ...] = ("global",)
LEGACY_SCOPES: tuple[str, ...] = ("project",)

# Each project owns a human-readable work summary at its repository root.
PROJECT_SUMMARY_FILE = "DSH_MEMORY.md"
PROJECT_SUMMARY_MARKER = "<!-- dsh-memory:project-summary -->"
PROJECT_SUMMARY_MAX_ITEMS = 300
# A work log names a project by its label, not by its checkout path: the
# headings are fixed overhead against the digest budget, and a Windows path
# slug runs to ~50 characters on its own.
DIGEST_PROJECT_LABEL_MAX = 24
# A path-shaped project name repeats the checkout prefix (``c-users-fuqia-
# documents-aiworkspace-blender``), so keeping only the tail would still read as
# a prefix and make every project look alike. The distinguishing part sits at
# the end of the name, which is why the short label is the head-and-tail form.
DIGEST_LABEL_HEAD_CHARS = 6
# Preferences and raw user messages are not "work done"; the user profile and
# recall already cover them. Keeping them out of the work log also keeps the
# model from turning the global digest into a list of lessons.
NON_WORK_EVENT_TYPES = ("preference", "user_message")

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


def coerce_scope(value: Any, *, allow_legacy: bool = False) -> str:
    scope = str(value or "global").strip().lower()
    allowed = SCOPES + (LEGACY_SCOPES if allow_legacy else ())
    if scope not in allowed:
        raise ValidationError(f"unknown scope {value!r}; expected one of {allowed}")
    return scope


def normalize_summary(text: str) -> str:
    """Strip wrappers a model likes to add around a Markdown answer.

    Only fences and outer whitespace go; the length is never touched. The
    character budget is an instruction to the generator (see the module
    docstring), so a digest that overshoots it is stored as written.
    """
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
# The user-authored standing instruction (a "soul.md" the user maintains from
# the settings page). Two keys, not one: the text and whether it is injected
# are independent, so switching the section off must not destroy what was
# written — the page only stops carrying it into the prompt.
META_INSTRUCTION = "memory.instruction"
META_INSTRUCTION_UPDATED = "memory.instruction.updated_at"
META_INSTRUCTION_ENABLED = "memory.instruction.enabled"


@dataclass(slots=True)
class SummarySettings:
    """Everything the host's settings page persists for the memory feature."""

    length: int = DEFAULT_LENGTH
    mode: str = AUTO_MODE  # fixed: summaries generate when the host is idle
    updated_at: str | None = None
    profile: str = ""
    profile_updated_at: str | None = None
    instruction: str = ""
    instruction_updated_at: str | None = None
    instruction_enabled: bool = False

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
            "instruction": self.instruction,
            "instruction_updated_at": self.instruction_updated_at,
            "instruction_enabled": self.instruction_enabled,
            "instruction_max_chars": INSTRUCTION_MAX_CHARS,
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
        instruction=store.get_meta(META_INSTRUCTION) or "",
        instruction_updated_at=store.get_meta(META_INSTRUCTION_UPDATED),
        # Absent means "never switched on", which is off: the section is
        # resident in every request, so it must be an explicit choice.
        instruction_enabled=(store.get_meta(META_INSTRUCTION_ENABLED) or "") == "1",
    )


# ══ materials ═══════════════════════════════════════════════════════════


@dataclass(slots=True)
class Materials:
    """The work records the model may read when writing the global digest.

    Only L2 episodes are collected: the global digest is a work log, so facts,
    the user profile and recent requests would only tempt the model to write
    lessons or preferences the digest must not contain.
    """

    project_ids: list[str]
    episodes: list[dict[str, Any]]
    project_names: dict[str, str] = field(default_factory=dict)
    chars: int = 0

    def render(self, *, max_chars: int) -> str:
        """Render episodes grouped by project, fairly sharing ``max_chars``.

        One project must not eat the whole prompt: each project gets an equal
        share of what remains, and unused space rolls over to the projects
        after it. Lines (never projects) are dropped when a share is exhausted.
        """
        budget = max_chars
        if budget <= 0 or not self.episodes:
            return ""
        groups: dict[str, list[dict[str, Any]]] = {}
        for episode in self.episodes:
            groups.setdefault(episode["project_id"], []).append(episode)
        order = [pid for pid in self.project_ids if pid in groups]
        order += [pid for pid in groups if pid not in order]

        out: list[str] = []
        remaining = budget
        left = len(order)
        for pid in order:
            if left <= 0 or remaining <= 0:
                break
            label = _digest_label(self.project_names.get(pid) or pid)
            title = f"## 项目：{label}（`{pid}`）"
            share = remaining // left
            keep: list[str] = []
            used = len(title) + 1
            for episode in groups[pid]:
                line = _work_line(episode)
                cost = len(line) + 1
                if used + cost > share:
                    break
                keep.append(line)
                used += cost
            if keep:
                out.append(f"{title}\n" + "\n".join(keep))
                remaining -= used
            left -= 1
        return "\n\n".join(out)


def _digest_label(name: str) -> str:
    """A short project label for the digest heading's fixed overhead.

    A project is usually named after its path (``c-users-fuqia-documents-...``),
    which makes the heading longer than the work under it. A name that already
    fits is kept verbatim, including its last path segment. A longer one keeps
    the *end* of its last segment, which is the distinguishing part, behind a
    bounded head: dropping only the tail would leave a shared prefix and make
    different projects render under the same label.
    """
    last = [part for part in name.replace("\\", "/").split("/") if part]
    label = last[-1].strip() if last else name.strip()
    if len(label) <= DIGEST_PROJECT_LABEL_MAX:
        return label
    keep = DIGEST_PROJECT_LABEL_MAX - DIGEST_LABEL_HEAD_CHARS - 1
    return f"{label[:DIGEST_LABEL_HEAD_CHARS]}…{label[-keep:]}"


def _work_line(episode: dict[str, Any]) -> str:
    stamp = episode["created_at"][:16].replace("T", " ")
    kind = episode.get("event_type") or "work"
    outcome = episode.get("outcome")
    suffix = f" · 结果：{_one_line(outcome, 80)}" if outcome else ""
    return f"- [{stamp}]（{kind}{suffix}）{_one_line(episode['summary'], 500)}"


def _one_line(text: str | None, limit: int) -> str:
    collapsed = " ".join((text or "").split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1] + "…"


def collect_materials(
    memory: MemorySystem,
    *,
    material_char_budget: int,
    episodes_per_project: int = 160,
) -> Materials:
    """Gather every project's work episodes for the one global digest."""
    projects = memory.list_projects()
    project_ids = [p.project_id for p in projects]
    project_names = {p.project_id: (p.display_name or p.project_id) for p in projects}

    store = memory.store
    excluded = ",".join("?" * len(NON_WORK_EVENT_TYPES))
    episodes: list[dict[str, Any]] = []
    for pid in project_ids:
        rows = store.query(
            "SELECT memory_id, project_id, summary, importance, event_type, outcome, "
            "created_at, state FROM l2_episodes WHERE project_id = ? AND superseded_by IS NULL "
            "AND json_extract(meta, '$.forgotten_at') IS NULL "
            f"AND COALESCE(event_type, '') NOT IN ({excluded}) "
            "ORDER BY created_at DESC LIMIT ?",
            (pid, *NON_WORK_EVENT_TYPES, episodes_per_project),
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

    materials = Materials(
        project_ids=project_ids,
        episodes=episodes,
        project_names=project_names,
    )
    materials.chars = sum(len(e["summary"]) for e in episodes)
    return materials


# ══ prompts ═════════════════════════════════════════════════════════════

SYSTEM_PROMPT = """你是「DSH 记忆系统」的全局工作摘要生成器。输入是来自所有项目的工作记录（L2 事件）。

你的任务：写一份跨项目的全局工作摘要，唯一目的是让后来的编码 Agent 快速知道“以前做过什么工作”。

要求：
1. 直接输出 Markdown，不要任何前言、解释或代码块围栏。
2. 按项目组织，每个项目一个小节；材料里的 `## 项目：...` 标题原样保留，不要合并项目。
3. 只记录已经发生的工作：实现了什么、修复了什么、修改了哪些文件/模块、执行了什么命令、完成了什么迁移或部署、做出了什么决定并已落地。
4. 不要写经验教训、最佳实践、操作规则、用户偏好、风险提醒、未来计划或未完成建议；这些不属于本摘要。
5. 合并同一主题的多次动作，保留关键时间、文件/模块、命令与结果；按时间从新到旧排列。
6. 不要编造材料里没有的信息；材料少时宁可写短。
7. 中文材料用中文写；标识符、路径、命令保留原文，不要翻译。
8. 建议结构：每个项目下用 `-` 列出工作项；没有工作记录的项目直接省略。

长度预算：约 {target_chars} 个字符，这是**全文总字数**，不是每个项目的字数。项目标题也计入预算。
按预算决定每个项目保留多少条：
- 预算小（≤800 字）：项目多时每个项目只写 1 条最重要的工作；写不下就只保留项目标题，甚至省略该项目。
- 预算中等（≤2000 字）：每个项目写 1-4 条，保留关键文件/模块/命令/结果。
- 预算大（>2000 字）：可以展开到更多工作项和细节。
先计算固定开销（项目数 × 标题长度），剩余字数再分给各项目的条目。不要为了填满预算而编造，也不要超出预算；材料多时按“最近 + 重要”取舍。"""

USER_TEMPLATE = """记忆范围：全部项目
生成时间：{now}

# 工作记录

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
    scope = coerce_scope(scope, allow_legacy=True)
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

    # ── standing instruction ───────────────────────────────────────────
    def get_instruction(self) -> str:
        return self.store.get_meta(META_INSTRUCTION) or ""

    def instruction_enabled(self) -> bool:
        return (self.store.get_meta(META_INSTRUCTION_ENABLED) or "") == "1"

    def set_instruction(
        self,
        text: str | None = None,
        *,
        enabled: bool | None = None,
    ) -> SummarySettings:
        """Store the user's standing instruction and/or its on-off switch.

        The two are independent on purpose: switching the section off leaves
        the text on disk, so turning it back on restores exactly what the user
        wrote instead of an empty box they have to retype. ``None`` means
        "leave this field alone", which is what the page sends when it only
        flips the switch.
        """
        with self.store.transaction():
            if text is not None:
                # Surrounding whitespace is dropped because the section is
                # rendered as-is: leading blank lines would shift the prompt
                # prefix on a keystroke without changing what the model reads.
                text = str(text).strip()
                if len(text) > INSTRUCTION_MAX_CHARS:
                    raise ValidationError(
                        f"instruction is {len(text)} chars; limit is {INSTRUCTION_MAX_CHARS}"
                    )
                self.store.set_meta(META_INSTRUCTION, text)
                self.store.set_meta(META_INSTRUCTION_UPDATED, _iso_now())
            if enabled is not None:
                self.store.set_meta(META_INSTRUCTION_ENABLED, "1" if enabled else "0")
        return self.settings()

    # ── plans ──────────────────────────────────────────────────────────
    def plan(self, *, length: int | None = None) -> DigestRequest:
        """Build the global-digest LLM request; the host runs it and commits."""
        settings = self.settings()
        target = coerce_length(length if length is not None else settings.length)
        # The material window scales with the output budget: a detailed digest
        # needs more source work than a one-line-per-project summary.
        material_budget = min(200_000, max(20_000, target * 8))
        materials = self._materials(material_char_budget=material_budget)
        body = materials.render(max_chars=material_budget)
        system = SYSTEM_PROMPT.format(target_chars=target)
        user = USER_TEMPLATE.format(
            now=_iso_now(),
            materials=body or "（记忆库为空：请输出一句说明，不要编造内容）",
        )
        digest_hash = hashlib.sha1(
            f"{PROMPT_VERSION}\x00{target}\x00global\x00{body}".encode("utf-8")
        ).hexdigest()
        return DigestRequest(
            scope="global",
            scope_ref=None,
            target_chars=target,
            system=system,
            user=user,
            prompt_version=PROMPT_VERSION,
            prompt_hash=digest_hash,
            material_chars=len(body),
            sources=[e["memory_id"] for e in materials.episodes],
            materials={
                "episodes": len(materials.episodes),
                "projects": len(materials.project_ids),
            },
        )

    def _materials(self, *, material_char_budget: int) -> Materials:
        if self._memory is not None:
            return collect_materials(
                self._memory,
                material_char_budget=material_char_budget,
            )
        # pragma: no cover - Store-only path is for tests of settings only
        return Materials(project_ids=[], episodes=[])

    # ── commit / read ──────────────────────────────────────────────────
    def commit(
        self,
        *,
        text: str,
        scope: str = "global",
        project_id: str | None = None,
        length: int | None = None,
        reason: str = "manual",
        generator: str | None = None,
        prompt_version: int = PROMPT_VERSION,
        sources: Sequence[str] = (),
        materials_chars: int = 0,
        error: str | None = None,
    ) -> DigestRecord:
        """Store model output exactly as written — a budget never clips it."""
        scope = coerce_scope(scope)
        settings = self.settings()
        target = coerce_length(length if length is not None else settings.length)
        cleaned = normalize_summary(text or "")
        status = "ok"
        if error:
            status = "error"
        elif not cleaned:
            status = "empty"
        if isinstance(sources, (str, bytes)):
            sources = [sources]
        content = cleaned or ""
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
            self._insert_digest(record)
            # Only a digest that became the visible one may move the marker.
            # An error row (a failed model call) or an empty one is kept for
            # history, but stamping "updated" for content the prompt does not
            # show made the settings page and `/health` claim a digest was
            # regenerated when the attempt had actually failed.
            if status == "ok":
                self.store.set_meta(META_UPDATED, record.created_at)
        # Project files are derived from L2, not from the digest text, so they
        # stay useful even when model generation failed.
        self.write_project_summaries()
        return record

    def write_project_summaries(self, *, project_id: str | None = None) -> list[str]:
        """Refresh the Markdown work summary at each project's root."""
        if self._memory is None:
            return []
        return write_project_summaries(self._memory, project_id=project_id)

    def import_digest(
        self,
        *,
        scope: str,
        project_id: str | None,
        content: str,
        created_at: str | None = None,
    ) -> DigestRecord:
        """Store a digest produced elsewhere (a Markdown backup).

        Two things differ from :meth:`commit`: the timestamp is the one the
        source recorded (history order must survive a restore), and the
        "digest updated" marker is left alone -- re-importing an old summary
        must not make the host believe the current one was just regenerated.
        Legacy ``project`` scopes are accepted so old backups still restore.

        ``requested_chars`` is recorded as the larger of the import floor and
        the text length. Unlike :meth:`commit`, the text being restored had no
        generation budget to honour, so claiming the saved budget as its target
        would make a short foreign digest look permanently under-target.
        """
        scope = coerce_scope(scope, allow_legacy=True)
        cleaned = normalize_summary(content or "")
        target = max(LENGTH_MIN, len(cleaned))
        record = DigestRecord(
            digest_id="dg_" + uuid.uuid4().hex[:16],
            scope=scope,
            scope_ref=project_id if scope == "project" else None,
            status="ok" if cleaned else "empty",
            content=cleaned,
            requested_chars=target,
            actual_chars=len(cleaned),
            estimated_tokens=estimate_tokens(cleaned),
            sources=[],
            materials_chars=0,
            prompt_version=PROMPT_VERSION,
            generator=None,
            reason="backup-restore",
            error=None,
            created_at=_normalize_iso(created_at) if created_at else _iso_now(),
        )
        with self.store.transaction():
            self._insert_digest(record)
        return record

    def _insert_digest(self, record: DigestRecord) -> None:
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

    def latest(
        self, *, scope: str = "global", project_id: str | None = None
    ) -> DigestRecord | None:
        clause, params = _scope_predicate(scope, project_id)
        row = self.store.query_one(
            f"SELECT * FROM memory_digests WHERE {clause} AND status IN ('ok','truncated') "
            "ORDER BY created_at DESC LIMIT 1",
            params,
        )
        return DigestRecord.from_row(row) if row else None

    def history(
        self, *, scope: str = "global", project_id: str | None = None, limit: int = 20
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
        include_summary: bool | None = None,
        include_profile: bool = True,
    ) -> dict[str, Any]:
        """What the host should tell the model about memory, this turn.

        Only the one global digest is advertised. Legacy project digests are
        deliberately ignored: project-level detail now lives in that project's
        ``DSH_MEMORY.md`` file instead of the prompt path.
        """
        # Nothing ever persisted this flag, so it was always the default: an
        # anchor carries the digest unless the caller says otherwise.
        want_summary = True if include_summary is None else include_summary
        summary_line = None
        profile_line = None

        if want_summary:
            latest = self.latest(scope="global")
            if latest is not None and latest.content.strip():
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
                f"- 全局记忆摘要：{summary_line['chars']} 字（约 {summary_line['estimated_tokens']} tokens），"
                f"生成于 {summary_line['created_at'][:16].replace('T', ' ')}"
                + ("，可能已过时" if summary_line["stale"] else "")
            )
            lines.append("- 需要摘要全文时调用 memory_digest_read；需要最新内容时调用 memory_digest_generate。")
        if profile_line is not None:
            lines.append(
                f"- 用户画像：{profile_line['chars']} 字，用户自行维护"
                + (f"，更新于 {profile_line['updated_at']}" if profile_line["updated_at"] else "")
            )
            lines.append("- 涉及用户偏好、习惯、技术栈或协作方式时，调用 memory_profile_read 读取完整画像。")
        lines.append("提示：摘要覆盖所有项目的已做工作；每个项目根目录另有 DSH_MEMORY.md 记录该项目的工作摘要。")
        lines.append("@@")
        return {"summary": summary_line, "profile": profile_line, "text": "\n".join(lines)}


def _age_days(raw: str) -> float:
    ts = parse_iso(raw)
    if ts is None:
        return 0.0
    return max(0.0, (datetime.now(timezone.utc) - ts).total_seconds() / 86400.0)


# ══ per-project Markdown summary ════════════════════════════════════════


def write_project_summaries(
    memory: MemorySystem, *, project_id: str | None = None
) -> list[str]:
    """Write a readable work summary into every project's root directory.

    The file is a *derived* view of L2: it never feeds back into recall or the
    global digest. A project without a registered ``root_path`` is skipped, as
    is a root that no longer exists. Failures are contained per project so a
    read-only checkout cannot break digest generation.
    """
    if project_id:
        try:
            projects = [memory.get_project(project_id)]
        except NotFoundError:
            return []
    else:
        projects = memory.list_projects()

    written: list[str] = []
    for project in projects:
        if not project.root_path:
            continue
        root = Path(project.root_path).expanduser()
        if not root.is_dir():
            continue
        text = _project_summary_markdown(memory, project)
        target = root / PROJECT_SUMMARY_FILE
        try:
            if target.is_file() and target.read_text(encoding="utf-8") == text:
                continue
            temporary = target.with_name(target.name + ".tmp")
            with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(text)
            os.replace(temporary, target)
        except OSError:
            # A read-only or vanished checkout must not fail the digest call.
            continue
        written.append(str(target))
    return written


def _project_summary_markdown(memory: MemorySystem, project: Any) -> str:
    excluded = ",".join("?" * len(NON_WORK_EVENT_TYPES))
    rows = memory.store.query(
        "SELECT summary, event_type, outcome, created_at FROM l2_episodes "
        "WHERE project_id = ? AND superseded_by IS NULL "
        "AND json_extract(meta, '$.forgotten_at') IS NULL "
        f"AND COALESCE(event_type, '') NOT IN ({excluded}) "
        "ORDER BY created_at DESC LIMIT ?",
        (project.project_id, *NON_WORK_EVENT_TYPES, PROJECT_SUMMARY_MAX_ITEMS),
    )
    display = project.display_name or project.project_id
    # The stamp describes the newest work record, not the moment this function
    # ran: with a wall-clock stamp every ``digest.commit`` rewrote the file even
    # when no memory had changed, and the "unchanged -> skip" guard below could
    # never fire.
    updated = (
        _normalize_iso(str(rows[0]["created_at"]))[:19].replace("T", " ") if rows else "（无）"
    )
    lines = [
        PROJECT_SUMMARY_MARKER,
        f"# 项目摘要：{display}",
        "",
        f"> 项目 ID：`{project.project_id}` · 由 dsh-memory 自动维护 · 更新于 {updated}",
        "> 只记录已做过的工作；经验教训与偏好不在此文件中。",
        "",
    ]
    if not rows:
        lines += ["（还没有记录任何工作。）", ""]
        return "\n".join(lines).rstrip() + "\n"

    current_day = ""
    for row in rows:
        created = _normalize_iso(str(row["created_at"]))
        day = created[:10]
        if day != current_day:
            lines += [f"## {day}", ""]
            current_day = day
        stamp = created[11:16]
        kind = row["event_type"] or "work"
        outcome = row["outcome"]
        detail = f"（{kind}"
        if outcome:
            detail += f" · 结果：{_one_line(outcome, 80)}"
        detail += "）"
        lines.append(f"- `{stamp}` {detail} {_one_line(row['summary'], 500)}")
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


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
            raise NotFoundError(f"memory {memory_id} not found")
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
            raise NotFoundError(f"memory {memory_id} not found")
        sets: list[str] = []
        params: list[Any] = []
        if "summary" in patch:
            summary = " ".join(str(patch["summary"] or "").split())
            if not summary:
                raise ValidationError("summary must be non-empty")
            if len(summary) > SUMMARY_MAX_CHARS:
                raise ValidationError(f"summary is longer than {SUMMARY_MAX_CHARS} characters")
            # An edit may land on the text of another row. ``summary_hash`` is
            # what the write path dedups on, so two rows sharing it makes a
            # later ``remember`` merge into whichever one ``LIMIT 1`` returns
            # and makes recall show the same sentence twice. Refuse instead of
            # silently creating a second copy of one memory.
            clash = self.memory.l2.find_duplicate(row["project_id"], summary)
            if clash is not None and clash.memory_id != memory_id:
                raise ConflictError(
                    f"another memory in this project already has this text: {clash.memory_id}"
                )
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
        # The vector, like the FTS body, is derived from the text: leaving it
        # alone after a summary edit means semantic recall keeps matching the
        # old wording forever, and a duplicate of the *new* text no longer
        # dedupes against this row on the vector side. Embed before opening the
        # transaction -- a provider call can be slow or remote and must not hold
        # the store's write lock (``EpisodicMemory.add`` does the same).
        vector = self.memory.l2.embed_summary(summary) if "summary" in patch else None
        with self.store.transaction():
            if sets:
                self.store.execute(f"UPDATE l2_episodes SET {', '.join(sets)} WHERE memory_id = ?", params)
            # Keep the lexical index in step with the text. The body covers
            # summary, event_type and participants, so *any* of those edits
            # must rebuild all of it from the stored row -- gating on
            # ``summary`` left an event_type edit searchable under its old
            # value, and rebuilding from the summary alone dropped the
            # participant names.
            if "summary" in patch or "event_type" in patch:
                self.memory.l2.reindex_text(memory_id)
            # Same transaction, same reason: the row's text and the vector that
            # stands for it must never disagree.
            if vector is not None:
                self.memory.l2.reembed(memory_id, vector)
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
        # State and marker must commit together — visibility splits between
        # them (search/_adjacency read the marker, state feeds lists/stats),
        # so "archived without marker" resurfaces as decay junk and "active
        # with marker" is unfindable. _Txn composes via savepoints: update()'s
        # own transaction folds into this one and both writes commit or roll
        # back as a unit.
        with self.store.transaction():
            updated = self.update(memory_id, {"state": "archived" if forgotten else "active"})
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
        return updated


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
    # ``notepad.list`` clamps one page at 500 rows, so asking for ``max_episodes``
    # in one call silently capped a backup at 500 per project. Page instead.
    page_size = 500
    for pid in selected:
        if exported >= max_episodes:
            break
        # ``state=None`` is the notepad's "still in play" set: active and dormant
        # rows, archived ones excluded. Exporting only ``active`` dropped every
        # memory that had merely decayed below the recall threshold -- still real
        # data, and unrecoverable if the backup was the only copy.
        items: list[dict[str, Any]] = []
        offset = 0
        while exported + len(items) < max_episodes:
            request = min(page_size, max_episodes - exported - len(items))
            listing = notepad.list(
                project_id=pid,
                limit=request,
                offset=offset,
                include_superseded=True,
                state=None,
            )
            page = listing["items"]
            items.extend(page)
            offset += len(page)
            if len(page) < request or offset >= listing["total"]:
                break
        if not items:
            continue
        out += [f"### 项目 {pid}", ""]
        for item in items:
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
            # Four decimals, not two: a restored edge must keep the confidence
            # it was exported with. ``:.2f`` turned every value below 0.005 into
            # 0.00 and everything at or above 0.995 into 1.00, so a round trip
            # silently rewrote the graph's certainty.
            out.append(
                f"- `{edge.edge_id}` {names.get(edge.head_id, edge.head_id)} --"
                f"{edge.relation}--> {names.get(edge.tail_id, edge.tail_id)} "
                f"（置信度 {edge.confidence:.4f}）"
            )
        out.append("")
    return "\n".join(out).rstrip() + "\n"