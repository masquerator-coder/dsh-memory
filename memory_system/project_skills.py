"""L4 — procedural skills kept as files.

Procedural memory is knowledge about how to *do* something, so it belongs in
the skill directories instead of inside the machine-wide database::

    <projectRoot>/.agents/skills/<name>/SKILL.md   project-local skills
    <home>/.agents/skills/<name>/SKILL.md          user-wide (global) skills
    <root>/.agents/skills/.retired/<name>/         retired bundles

The locations are not arbitrary. DSH's own ``skill-filesystem`` provider scans
``<projectRoot>/.dsh/skills`` (rank 100), ``<projectRoot>/.agents/skills``
(rank 200) and ``<home>/.agents/skills``, turning each ``<name>/SKILL.md`` into
a session skill: the agent loads one with the native ``skill`` tool, and a
human — or another tool that understands the same convention — reads the very
same file. Discovery is one level deep, so a retired bundle parked under
``.retired/`` is invisible without being deleted.

The database keeps only a lightweight creation record (see
:func:`memory_system.bridge.record_skill_created`); the definition itself is
the file.

Frontmatter is the contract with that provider: ``name`` (kebab-case),
``description``, optional ``whenToUse``. Everything else this system tracks —
the Chinese title, trigger words, prerequisites, timestamps — rides inside
``metadata``, a free-form mapping DSH carries but never interprets.

Run evidence stays out of the repository: one line per run would leave
``git status`` permanently dirty, so it goes to
``<memoryHome>/l4_runs/<project_id>/<name>.jsonl``.

The module takes a resolved ``project_root`` / ``memory_home`` and never walks
the tree itself; locating the project root is the bridge's job, and keeping it
there is what avoids a second, subtly different ``.git`` rule.
"""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Iterable

from .errors import MemoryError, NotFoundError, ValidationError
from .l4 import SkillDefinition, Step, validate_definition
from .storage import to_iso, utcnow

SKILL_DIR = Path(".agents") / "skills"
RETIRED_DIR = ".retired"
SKILL_FILE = "SKILL.md"
LEDGER_DIR = "l4_runs"
#: Overrides the user-wide root in tests and non-default installations.
GLOBAL_SKILLS_ENV = "DSH_MEMORY_GLOBAL_SKILLS"

#: Project skills the authoring path will keep. Advice, not a hard store limit:
#: every skill costs one line in the model's catalog.
DEFAULT_LIMIT = 24

#: Mirrors ``dsh-skill``'s ``SKILL_NAME`` exactly. A name that fails this is
#: silently dropped by the provider, so it must fail here instead.
SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


@dataclass(slots=True)
class ProjectSkill:
    """One skill bundle on disk, parsed."""

    name: str
    title: str
    description: str
    when_to_use: str = ""
    triggers: list[str] = field(default_factory=list)
    requires_tools: list[str] = field(default_factory=list)
    steps: list[dict[str, Any]] = field(default_factory=list)
    success_criteria: str | None = None
    fallback: str | None = None
    scope: str = "project"
    created_at: str | None = None
    updated_at: str | None = None
    bundle: Path = Path()
    path: Path = Path()
    body: str = ""
    step_count: int = 0
    problem: str | None = None

    def to_skill(self, *, scope_kind: str = "global", ns: str = "user", status: str = "active") -> Any:
        """Build the runtime :class:`~memory_system.l4.Skill` for this bundle.

        Used by the user-facing promotion path, which materializes a global
        bundle and returns the same ``Skill`` shape the store-backed API uses.
        """
        from .l4 import Skill

        return Skill(
            skill_id=f"file:global:{self.name}",
            qualified_name=f"user:global:{self.name}",
            ns=ns,
            scope_kind=scope_kind,
            scope_ref=None,
            status=status,
            tier="file",
            definition=SkillDefinition(
                title=self.title,
                description=self.description,
                when_to_use=self.when_to_use,
                triggers=list(self.triggers),
                requires_tools=list(self.requires_tools),
                steps=[Step.from_dict(step) for step in self.steps],
                success_criteria=self.success_criteria,
                fallback=self.fallback,
            ),
            created_at=self.created_at or "",
            updated_at=self.updated_at or "",
        )

    def to_dict(self, *, project_id: str | None = None, scope: str | None = None) -> dict[str, Any]:
        """The shape ``skill.list`` / ``skill.get`` hand to the host."""
        scope = scope or self.scope or "project"
        if scope == "global":
            skill_id = f"file:global:{self.name}"
            qualified_name = f"user:global:{self.name}"
        else:
            skill_id = f"file:{project_id}:{self.name}"
            qualified_name = f"user:project:{project_id}:{self.name}"
        return {
            "skill_id": skill_id,
            "qualified_name": qualified_name,
            "name": self.name,
            "scope": scope,
            "scope_kind": scope,
            "status": "active",
            "tier": "file",
            "title": self.title,
            "description": self.description,
            "when_to_use": self.when_to_use,
            "triggers": list(self.triggers),
            "requires_tools": list(self.requires_tools),
            "steps": [f"{s['tool']}: {s['action']}" if s.get("tool") else s["action"] for s in self.steps],
            "step_count": self.step_count,
            "success_criteria": self.success_criteria,
            "fallback": self.fallback,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "source": "file",
            "path": str(self.path),
            "problem": self.problem,
        }


# ══ paths ═══════════════════════════════════════════════════════════════


def skill_root(project_root: Path | str) -> Path:
    """The scanned root that holds this project's skill bundles."""
    return Path(project_root) / SKILL_DIR


def global_skill_root(home: Path | str | None = None) -> Path:
    """The user-wide root shared by every project on this machine.

    ``~/.agents/skills`` is what DSH's skill provider scans for global skills.
    Tests (and unusual installs) can point ``DSH_MEMORY_GLOBAL_SKILLS`` at a
    scratch directory; an explicit ``home`` wins over the environment.
    """
    if home is not None:
        return Path(home).expanduser() / SKILL_DIR
    override = os.environ.get(GLOBAL_SKILLS_ENV)
    if override:
        return Path(override).expanduser()
    return Path.home() / SKILL_DIR


def retired_root(project_root: Path | str, *, scope: str = "project") -> Path:
    return _root(project_root, scope) / RETIRED_DIR


def _root(project_root: Path | str, scope: str) -> Path:
    """The scanned root for one scope; ``project_root`` is a repo or user home."""
    if scope == "global":
        return global_skill_root(project_root)
    return skill_root(project_root)


def ledger_path(memory_home: Path | str, project_id: str, name: str) -> Path:
    """Where one skill's run records are appended."""
    return Path(memory_home) / LEDGER_DIR / _slug(project_id) / f"{_slug(name)}.jsonl"


def _slug(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value)).strip("-.")
    return cleaned or "skill"


# ══ names ═══════════════════════════════════════════════════════════════


def validate_name(name: str) -> str:
    """Reject anything the provider would silently ignore."""
    text = str(name or "").strip()
    if not text:
        raise ValidationError("name is required: a kebab-case ASCII name, e.g. locate-failing-test")
    if not SKILL_NAME.match(text):
        raise ValidationError(
            f"name {text!r} must be kebab-case ASCII ([a-z0-9] words joined by '-'); "
            "the skill catalog drops other spellings, so keep the Chinese title in `title`"
        )
    return text


# ══ frontmatter ═════════════════════════════════════════════════════════


def _scalar(value: str) -> Any:
    """Parse one frontmatter value: JSON string, flow list, or plain text."""
    text = value.strip()
    if not text:
        return ""
    if text.startswith("[") and text.endswith("]"):
        return _flow_list(text)
    if text.startswith('"'):
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text.strip('"')
    if text.startswith("'") and text.endswith("'") and len(text) > 1:
        return text[1:-1].replace("''", "'")
    return text


def _flow_list(text: str) -> list[str]:
    inner = text[1:-1].strip()
    if not inner:
        return []
    items: list[str] = []
    buffer = ""
    quote: str | None = None
    escaped = False
    for char in inner:
        if escaped:
            buffer += char
            escaped = False
        elif char == "\\" and quote == '"':
            buffer += char
            escaped = True
        elif quote is not None:
            buffer += char
            if char == quote:
                quote = None
        elif char in ('"', "'"):
            buffer += char
            quote = char
        elif char == ",":
            items.append(buffer)
            buffer = ""
        else:
            buffer += char
    if buffer.strip():
        items.append(buffer)
    out: list[str] = []
    for item in items:
        parsed = _scalar(item)
        text_item = str(parsed).strip()
        if text_item:
            out.append(text_item)
    return out


def _emit_scalar(value: str) -> str:
    """Write a plain scalar when it is unambiguous, JSON-quote it otherwise.

    Chinese text stays readable; a value with a colon, a bracket or a leading
    quote is quoted so the provider's YAML parser cannot read it differently.
    """
    text = str(value)
    needs_quotes = (
        text == ""
        or text != text.strip()
        or "\n" in text
        or any(ch in text for ch in ':#[]{},"\'')
        or text[0] in "-*&!|>%@`"
    )
    if needs_quotes:
        return json.dumps(text, ensure_ascii=False)
    return text


def _emit_list(values: Iterable[str]) -> str:
    items = [json.dumps(str(v), ensure_ascii=False) for v in values if str(v).strip()]
    return "[" + ", ".join(items) + "]"


def _split_frontmatter(text: str) -> tuple[str, str] | None:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            return "\n".join(lines[1:index]), "\n".join(lines[index + 1 :])
    return None


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Parse the YAML subset this module writes (plus hand-written variants).

    Deliberately not a YAML implementation: the provider owns real YAML, and a
    dependency here would buy nothing but a second dialect to keep in sync.
    """
    split = _split_frontmatter(text)
    if split is None:
        return {}, text
    block, body = split
    data: dict[str, Any] = {}
    meta: dict[str, Any] = {}
    current: str | None = None
    for raw in block.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indented = raw[:1] in (" ", "\t")
        key, sep, value = raw.strip().partition(":")
        if not sep:
            continue
        key = key.strip()
        if indented and current == "metadata":
            meta[key] = _scalar(value)
            continue
        if key == "metadata" and not value.strip():
            current = "metadata"
            continue
        current = None
        data[key] = _scalar(value)
    if meta:
        data["metadata"] = meta
    return data, body


# ══ rendering ═══════════════════════════════════════════════════════════


def render_skill(
    definition: SkillDefinition,
    *,
    name: str,
    created_at: str,
    updated_at: str,
    scope: str = "project",
) -> str:
    """The SKILL.md text for one definition."""
    lines = [
        "---",
        f"name: {_emit_scalar(name)}",
        f"description: {_emit_scalar(definition.description)}",
    ]
    when = (definition.when_to_use or "").strip()
    if when:
        lines.append(f"whenToUse: {_emit_scalar(when)}")
    lines.append("metadata:")
    lines.append("  origin: dsh-memory")
    lines.append(f"  scope: {_emit_scalar(scope)}")
    lines.append(f"  title: {_emit_scalar(definition.title)}")
    if definition.triggers:
        lines.append(f"  triggers: {_emit_list(definition.triggers)}")
    if definition.requires_tools:
        lines.append(f"  requires-tools: {_emit_list(definition.requires_tools)}")
    lines.append(f"  created-at: {created_at}")
    lines.append(f"  updated-at: {updated_at}")
    lines.append("---")
    lines.append("")
    lines.append(f"# {definition.title}")
    if when:
        lines += ["", "## 适用场景", when]
    if definition.triggers:
        lines += ["", f"触发词：{'、'.join(definition.triggers)}"]
    if definition.requires_tools:
        lines += ["", f"前置工具：{', '.join(definition.requires_tools)}"]
    lines += ["", "## 步骤"]
    for index, step in enumerate(definition.steps, 1):
        tool = f"`{step.tool}` " if step.tool else ""
        critical = " **(关键)**" if step.critical else ""
        lines.append(f"{index}. {tool}{step.action}{critical}")
        if step.args_hint:
            lines.append(f"   - 参数提示: {step.args_hint}")
    if definition.success_criteria:
        lines += ["", "## 成功标准", definition.success_criteria]
    if definition.fallback:
        lines += ["", "## 回退", definition.fallback]
    return "\n".join(lines).rstrip() + "\n"


def _count_steps(body: str) -> int:
    """Numbered lines under ``## 步骤`` — enough to show a size hint in a list."""
    inside = False
    total = 0
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            inside = stripped.lstrip("#").strip() == "步骤"
            continue
        if inside and re.match(r"^\d+[.、]\s*\S", stripped):
            total += 1
    return total


def _to_skill(path: Path, data: dict[str, Any], body: str) -> ProjectSkill:
    meta = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    triggers = data.get("triggers") if isinstance(data.get("triggers"), list) else meta.get("triggers")
    requires = (
        data.get("requires_tools")
        if isinstance(data.get("requires_tools"), list)
        else meta.get("requires-tools")
    )
    return ProjectSkill(
        name=str(data.get("name") or path.parent.name),
        title=str(meta.get("title") or data.get("name") or path.parent.name),
        description=str(data.get("description") or ""),
        when_to_use=str(data.get("whenToUse") or meta.get("when-to-use") or ""),
        triggers=[str(t) for t in (triggers or []) if str(t).strip()],
        requires_tools=[str(t) for t in (requires or []) if str(t).strip()],
        scope=str(meta.get("scope") or data.get("scope") or "project"),
        success_criteria=meta.get("success-criteria"),
        fallback=meta.get("fallback"),
        created_at=meta.get("created-at"),
        updated_at=meta.get("updated-at"),
        bundle=path.parent,
        path=path,
        body=body.strip(),
        step_count=_count_steps(body),
    )


# ══ discovery ═══════════════════════════════════════════════════════════


def discover(project_root: Path | str) -> list[ProjectSkill]:
    """Every active bundle under ``<project>/.agents/skills``, sorted by name."""
    return discover_at(skill_root(project_root))


def discover_at(root: Path | str) -> list[ProjectSkill]:
    """Every active bundle under one already-resolved skill root.

    A bundle whose frontmatter cannot be read is returned with ``problem`` set
    instead of disappearing: the model can then say "this file is broken"
    rather than "there is no such skill".
    """
    root = Path(root)
    if not root.is_dir():
        return []
    found: list[ProjectSkill] = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        if entry.name.startswith(".") or not entry.is_dir():
            continue
        path = entry / SKILL_FILE
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:  # pragma: no cover - permission/IO fault
            found.append(
                ProjectSkill(
                    name=entry.name,
                    title=entry.name,
                    description="",
                    bundle=entry,
                    path=path,
                    problem=f"read failed: {error}",
                )
            )
            continue
        data, body = parse_frontmatter(text)
        skill = _to_skill(path, data, body)
        if not skill.description and skill.problem is None:
            skill.problem = "frontmatter requires name and description"
        found.append(skill)
    return found


def resolve(skills: Iterable[ProjectSkill], text: str, *, project_id: str | None = None) -> ProjectSkill | None:
    """Find one skill by name, qualified name, bundle directory or file path."""
    wanted = str(text or "").strip()
    if not wanted:
        return None
    for skill in skills:
        candidates = {
            skill.name,
            skill.title,
            str(skill.bundle),
            str(skill.path),
        }
        if skill.scope == "global":
            candidates.add(f"user:global:{skill.name}")
            candidates.add(f"file:global:{skill.name}")
        if project_id:
            candidates.add(f"user:project:{project_id}:{skill.name}")
            candidates.add(f"file:{project_id}:{skill.name}")
        if wanted in candidates:
            return skill
    return None


# ══ write / read / retire ═══════════════════════════════════════════════


def _atomic_write(path: Path, text: str) -> None:
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(text, encoding="utf-8")
    try:
        os.replace(temp, path)
    except OSError:
        temp.unlink(missing_ok=True)
        raise


def create(
    project_root: Path | str,
    definition: SkillDefinition,
    *,
    name: str,
    limit: int = DEFAULT_LIMIT,
    overwrite: bool = False,
    scope: str = "project",
) -> ProjectSkill:
    """Write one bundle. Raises instead of overwriting or evicting.

    ``project_root`` is the checkout for a project skill, or the user's home
    directory for a global one (``~/.agents/skills``).
    """
    return create_at(
        _root(project_root, scope),
        definition,
        name=name,
        limit=limit,
        overwrite=overwrite,
        scope=scope,
    )


def create_at(
    root: Path | str,
    definition: SkillDefinition,
    *,
    name: str,
    limit: int = DEFAULT_LIMIT,
    overwrite: bool = False,
    scope: str = "project",
) -> ProjectSkill:
    """Write one bundle directly under an already-resolved skill root."""
    name = validate_name(name)
    problems = validate_definition(definition)
    if problems:
        raise ValidationError("; ".join(problems))
    root = Path(root)
    skills = discover_at(root)
    existing = next((s for s in skills if s.name == name), None)
    if existing is not None and not overwrite:
        raise ValidationError(
            f"技能 {name} 已存在：{existing.path}（先 skill_get 看它；确需替换先 skill_retire）"
        )
    if existing is None and len(skills) >= limit:
        where = "公共技能目录" if scope == "global" else "本项目"
        raise ValidationError(
            f"{where}已有 {len(skills)} 个 active 技能，达到上限 {limit}；先 skill_retire 或合并，再新建"
        )
    now = to_iso(utcnow())
    text = render_skill(
        definition,
        name=name,
        created_at=existing.created_at if existing and existing.created_at else now,
        updated_at=now,
        scope=scope,
    )
    bundle = root / name
    created_dir = not bundle.exists()
    bundle.mkdir(parents=True, exist_ok=True)
    try:
        _atomic_write(bundle / SKILL_FILE, text)
    except OSError as error:
        if created_dir:
            try:
                bundle.rmdir()
            except OSError:  # pragma: no cover - directory already has files
                pass
        raise MemoryError(f"无法写入技能文件 {bundle / SKILL_FILE}: {error}") from error
    loaded = load_at(root, name)
    if loaded is None:  # pragma: no cover - the file was written a moment ago
        raise MemoryError(f"技能文件写入后无法读回：{bundle / SKILL_FILE}")
    return loaded


def load(project_root: Path | str, name: str, *, scope: str = "project") -> ProjectSkill | None:
    """Read one bundle by directory name."""
    return load_at(_root(project_root, scope), name)


def load_at(root: Path | str, name: str) -> ProjectSkill | None:
    """Read one bundle directly under an already-resolved skill root."""
    return resolve(discover_at(root), name)


def retire(project_root: Path | str, name: str, *, scope: str = "project") -> ProjectSkill:
    """Move a bundle out of the scanned root; the files are kept, not deleted."""
    return retire_at(_root(project_root, scope), name, scope=scope)


def retire_at(root: Path | str, name: str, *, scope: str = "project") -> ProjectSkill:
    """Retire one bundle directly under an already-resolved skill root."""
    skill = resolve(discover_at(root), name)
    if skill is None:
        where = "global skill" if scope == "global" else "project skill"
        raise NotFoundError(f"{where} {name!r} not found")
    target = Path(root) / RETIRED_DIR / skill.name
    if target.exists():
        stamp = re.sub(r"[^0-9]", "", to_iso(utcnow()))[:14]
        target = Path(root) / RETIRED_DIR / f"{skill.name}-{stamp}"
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(skill.bundle, target)
    return replace(skill, bundle=target, path=target / SKILL_FILE)


# ══ run ledger ══════════════════════════════════════════════════════════


def append_run(
    memory_home: Path | str,
    project_id: str,
    name: str,
    *,
    outcome: str,
    success: bool,
    error: str | None = None,
    deviation: str | None = None,
    window: int = 10,
) -> dict[str, Any]:
    """Append one execution record and report the rolling success rate."""
    path = ledger_path(memory_home, project_id, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "run_id": uuid.uuid4().hex[:12],
        "skill": name,
        "project_id": project_id,
        "outcome": outcome,
        "success": bool(success),
        "error": error,
        "deviation": deviation,
        "at": to_iso(utcnow()),
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return {
        "run_id": record["run_id"],
        "success": record["success"],
        **run_stats(memory_home, project_id, name, window=window),
    }


def import_runs(
    memory_home: Path | str,
    project_id: str,
    name: str,
    records: Iterable[dict[str, Any]],
    *,
    window: int = 10,
) -> dict[str, Any]:
    """Append historical run records — used when a store row becomes a bundle.

    Timestamps are kept: the ledger is evidence, and stamping a migration with
    "now" would make three old failures look like three new ones.
    """
    path = ledger_path(memory_home, project_id, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with path.open("a", encoding="utf-8") as handle:
        for record in records:
            entry = {
                "run_id": str(record.get("run_id") or uuid.uuid4().hex[:12]),
                "skill": name,
                "project_id": project_id,
                "outcome": str(record.get("outcome") or "success"),
                "success": bool(record.get("success")),
                "error": record.get("error"),
                "deviation": record.get("deviation"),
                "at": record.get("at") or to_iso(utcnow()),
                "imported": True,
            }
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
            written += 1
    return {"imported": written, **run_stats(memory_home, project_id, name, window=window)}


def run_stats(memory_home: Path | str, project_id: str, name: str, *, window: int = 10) -> dict[str, Any]:
    """Runs recorded so far and the success rate over the last ``window``."""
    path = ledger_path(memory_home, project_id, name)
    records: list[dict[str, Any]] = []
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                records.append(parsed)
    recent = records[-window:] if window > 0 else records
    rate = (
        round(sum(1 for record in recent if record.get("success")) / len(recent), 3)
        if recent
        else None
    )
    return {
        "runs": len(records),
        "window": len(recent),
        "success_rate": rate,
        "last_run_at": records[-1].get("at") if records else None,
        "ledger": str(path),
    }
