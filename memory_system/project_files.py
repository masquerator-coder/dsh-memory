"""Files a checkout carries beside its code: its work summary and its rules.

The memory database is machine-wide, but two kinds of project content belong to
the checkout itself, not to one machine's store::

    <projectRoot>/.agents/memory/MEMORY.md    derived work summary (an L2 view)
    <projectRoot>/.agents/rules/<name>.md     one project rule per file

**The memory file is derived.** It is rewritten from the newest L2 episodes and
never read back as a source of truth; deleting it loses nothing but the local
readable copy. Keeping it under ``.agents/`` puts it next to the other
agent-facing files (``.agents/skills``) instead of dropping a generated file in
the repository root, and a project that wants it versioned or ignored can
choose either without the layout moving again.

**The rules are authored content.** A rule is a constraint the user places on
the project ("comments are Chinese", "never write to the release branch"), so
it must be reviewable in the repository and readable by a human. The model
writes one file per rule through ``rule_add`` / ``rule.write``; the plugin reads
them back for the system prompt. Rules do not enter L2, L3 or the digest: they
are requirements, not work that was done.

Why a single markdown per rule instead of one big file: a diff then names the
rule that changed, two authors rarely edit the same rule, and a retired rule is
a file deletion instead of an in-place edit that loses its history. The YAML
frontmatter mirrors the skill convention (``name`` / ``description`` plus
``metadata``), parsed with the same small subset implemented in
:mod:`memory_system.project_skills` — deliberately not a second YAML dialect.

The module takes a resolved project root and never walks the tree: locating the
root is the bridge's job, exactly as with :mod:`memory_system.project_skills`.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .errors import ConflictError, ValidationError
from .project_skills import SKILL_NAME, parse_frontmatter
from .storage import to_iso, utcnow

#: Agent-facing directory shared by the memory file, the rules and the skills.
AGENTS_DIR = Path(".agents")
MEMORY_DIR = AGENTS_DIR / "memory"
RULES_DIR = AGENTS_DIR / "rules"
MEMORY_FILE = "MEMORY.md"

#: The marker the writer puts on line 1; it is how a legacy root file is told
#: apart from a Markdown file the user wrote by hand. Kept identical to the
#: historical ``DSH_MEMORY.md`` marker so old checkouts are recognized.
PROJECT_SUMMARY_MARKER = "<!-- dsh-memory:project-summary -->"

#: The pre-``.agents`` location. Still recognized, never written again.
LEGACY_PROJECT_SUMMARY_FILE = "DSH_MEMORY.md"

#: Forward-slash spelling used in docs, status payloads and tests.
PROJECT_MEMORY_RELATIVE = MEMORY_DIR.as_posix() + "/" + MEMORY_FILE
PROJECT_RULES_RELATIVE = RULES_DIR.as_posix()

#: The writer's own header line records the newest record's time.
_UPDATED = re.compile(r"更新于\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
_RULE_HEADING = re.compile(r"^#\s+(.+)$", re.MULTILINE)


# ══ paths ═══════════════════════════════════════════════════════════════


def memory_path(project_root: Path | str) -> Path:
    """Where this checkout's derived work summary lives."""
    return Path(project_root) / MEMORY_DIR / MEMORY_FILE


def rules_dir(project_root: Path | str) -> Path:
    """The directory scanned for this checkout's one-file-per-rule Markdown."""
    return Path(project_root) / RULES_DIR


def legacy_memory_path(project_root: Path | str) -> Path:
    """The old root file, kept only so the writer can clean it up."""
    return Path(project_root) / LEGACY_PROJECT_SUMMARY_FILE


# ══ the derived work summary ════════════════════════════════════════════


def _clean_memory_text(text: str) -> str:
    """Drop the file's own chrome and keep the content worth injecting.

    The prompt does not need the marker comment, the ``# 项目摘要`` title or
    the ``> 项目 ID …`` blockquote: those are metadata for a human opening the
    file. What a session needs is the day headings and the work lines. A file
    with none of those (a project that has recorded nothing yet) yields an
    empty excerpt, and the caller omits the block instead of injecting
    "nothing has been done" into every request.
    """
    kept: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line == PROJECT_SUMMARY_MARKER or line.startswith("# "):
            continue
        if line.startswith(">"):
            continue
        if line.startswith("## ") or line.startswith("- "):
            kept.append(line)
    return "\n".join(kept)


def _cap_lines(text: str, max_chars: int) -> tuple[str, bool]:
    """Cut ``text`` to at most ``max_chars`` on a line boundary when possible."""
    if max_chars <= 0:
        return "", bool(text)
    if len(text) <= max_chars:
        return text, False
    out: list[str] = []
    used = 0
    for line in text.splitlines():
        room = max_chars - used
        if room <= 0:
            break
        if len(line) + 1 <= room:
            out.append(line)
            used += len(line) + 1
            continue
        out.append(line[:room])
        used = max_chars
        break
    excerpt = "\n".join(out).rstrip("\n")
    return excerpt, True


def read_project_memory(project_root: Path | str, *, max_chars: int = 1200) -> dict[str, Any]:
    """Read the work summary into the shape the prompt renderer consumes.

    A missing or unreadable file is not an error: ``exists: false`` is a
    project that has not recorded work yet (or a read-only checkout), and the
    caller falls back to the database. ``chars`` is the whole file, so a host
    can say "there is more" without reading it again.
    """
    path = memory_path(project_root)
    result: dict[str, Any] = {
        "path": str(path),
        "exists": False,
        "chars": 0,
        "updated": None,
        "excerpt": "",
        "truncated": False,
    }
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return result
    result["exists"] = True
    result["chars"] = len(text)
    stamp = _UPDATED.search(text)
    result["updated"] = stamp.group(1) if stamp else None
    excerpt, truncated = _cap_lines(_clean_memory_text(text), int(max_chars))
    result["excerpt"] = excerpt
    result["truncated"] = truncated
    return result


# ══ project rules (one Markdown per rule) ═══════════════════════════════


def _rule_body(body: str) -> str:
    """The rule text without the duplicated ``# title`` heading."""
    lines = body.strip().splitlines()
    if lines and lines[0].lstrip().startswith("# "):
        lines = lines[1:]
    return "\n".join(lines).strip()


def _rule_title(data: dict[str, Any], body: str, fallback: str) -> str:
    meta = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    title = str(meta.get("title") or meta.get("name") or "").strip()
    if title:
        return title
    heading = _RULE_HEADING.search(body)
    if heading:
        return heading.group(1).strip()
    return str(data.get("title") or fallback).strip() or fallback


def read_rules(
    project_root: Path | str, *, max_rules: int = 12, max_chars: int = 2400
) -> tuple[list[dict[str, Any]], bool]:
    """Read ``.agents/rules/*.md`` into prompt-sized records.

    Sorted by file name so the injected order is stable across assemblies (a
    system prompt that reorders itself defeats prefix caching). The caps are a
    budget, not a filter: the newest rules are not ordered by time, so the
    caller is told ``truncated`` instead of silently losing files.
    """
    root = rules_dir(project_root)
    try:
        entries = sorted(
            (p for p in root.iterdir() if p.is_file() and p.suffix.lower() == ".md" and not p.name.startswith(".")),
            key=lambda p: p.name,
        )
    except OSError:
        return [], False

    rules: list[dict[str, Any]] = []
    used = 0
    truncated = False
    for path in entries:
        if len(rules) >= max_rules:
            truncated = True
            break
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            truncated = True
            continue
        data, body = parse_frontmatter(text)
        content = _rule_body(body)
        if not content:
            # A file with no body carries no instruction; skipping it is more
            # honest than injecting an empty heading into every request.
            continue
        name = str(data.get("name") or path.stem).strip() or path.stem
        title = _rule_title(data, body, name)
        description = str(data.get("description") or "").strip()
        overhead = len(title) + len(name) + 16
        room = max_chars - used - overhead
        if room <= 0 or (rules and room < 120):
            truncated = True
            break
        if len(content) + overhead > max_chars - used:
            # A rule longer than the whole budget would otherwise evict every
            # other rule. Keep a readable prefix and tell the model where the
            # whole rule is, instead of injecting a silently partial rule.
            visible = max(60, room - 40)
            content = content[:visible].rstrip() + f"\n…（规则过长，完整内容见 {path}）"
            truncated = True
        rules.append(
            {
                "name": name,
                "title": title,
                "description": description,
                "path": str(path),
                "chars": len(content),
                "content": content,
            }
        )
        used += len(content) + overhead
    return rules, truncated


def validate_rule_name(name: str) -> str:
    """Keep rule file names to the same kebab-case shape as skill names.

    The rules directory is not scanned by DSH, but a stable name is what lets
    the model and a human refer to the same file, and it keeps the path safe:
    no ``..``, no separators, no case surprises on Windows.
    """
    text = str(name or "").strip()
    if not text:
        raise ValidationError("name is required: a kebab-case ASCII name, e.g. memory-file-location")
    if not SKILL_NAME.match(text):
        raise ValidationError(
            f"name {text!r} must be kebab-case ASCII ([a-z0-9] words joined by '-'); "
            "keep the Chinese title in `title`"
        )
    return text


def _emit(value: str) -> str:
    """Write a plain YAML scalar when unambiguous, JSON-quote it otherwise.

    The same subset :mod:`memory_system.project_skills` writes, so the rules
    and skill frontmatter stay readable in the same way. JSON double quotes are
    valid YAML, which is what makes the fallback safe.
    """
    text = str(value)
    needs_quotes = (
        text == ""
        or text != text.strip()
        or "\n" in text
        or any(ch in text for ch in ':#[]{},"\'')
        or text[0] in "-*&!|>%@`"
    )
    return json.dumps(text, ensure_ascii=False) if needs_quotes else text


def render_rule(
    *, name: str, title: str, description: str, content: str, created_at: str
) -> str:
    """The one-file-per-rule Markdown text."""
    return "\n".join(
        [
            "---",
            f"name: {_emit(name)}",
            f"description: {_emit(description)}",
            "metadata:",
            "  origin: dsh-memory",
            f"  title: {_emit(title)}",
            f"  created-at: {created_at}",
            "---",
            "",
            f"# {title}",
            "",
            content.rstrip(),
            "",
        ]
    )


def create_rule(
    project_root: Path | str,
    *,
    name: str,
    title: str,
    description: str,
    content: str,
    created_at: str | None = None,
) -> Path:
    """Write one rule file atomically and return its path.

    Nothing is overwritten: a second rule with the same name is a conflict the
    caller must resolve by editing the existing file. That is the same
    "duplicate means look first" rule the skill authoring path follows, and it
    keeps a rule's history in the file instead of silently replacing it.
    """
    clean_name = validate_rule_name(name)
    clean_title = " ".join(str(title or "").split())
    if not clean_title:
        raise ValidationError("title is required: a short Chinese title for the rule")
    clean_description = " ".join(str(description or "").split())
    if not clean_description:
        raise ValidationError("description is required: one line saying what the rule constrains")
    body = str(content or "").strip()
    if not body:
        raise ValidationError("content is required: the rule text (must/must-not, scope, exceptions)")
    # A rule is authored text that travels with the checkout: normalize its line
    # endings so the same text does not become a whole-file diff when written on
    # a different platform.
    body = body.replace("\r\n", "\n").replace("\r", "\n")

    path = rules_dir(project_root) / f"{clean_name}.md"
    if path.exists():
        raise ConflictError(
            f"rule {clean_name} already exists at {path}; read it and edit that file "
            "instead of creating a duplicate"
        )
    stamp = created_at or to_iso(utcnow())
    text = render_rule(
        name=clean_name,
        title=clean_title,
        description=clean_description,
        content=body,
        created_at=stamp,
    )
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise ValidationError(f"cannot create {path.parent}: {error}") from error
    temporary = path.with_name(path.name + ".tmp")
    try:
        # ``newline="\\n"`` keeps the file LF on every platform, like the
        # generated project memory file: a Windows-only CRLF rewrite would make
        # a one-line rule a whole-file diff in version control.
        with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary, path)
    except OSError as error:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise ValidationError(f"cannot write rule {path}: {error}") from error
    return path
