"""Files a checkout carries beside its code: its daily work records and rules.

The memory database is machine-wide, but two kinds of project content belong to
the checkout itself, not to one machine's store::

    <projectRoot>/.agents/memory/<YYYY-MM-DD>.md  derived work record, one file per day
    <projectRoot>/.agents/rules/<name>.md         one project rule per file

**The work records are derived.** A day file is rewritten from that day's L2
episodes and never read back as a source of truth; deleting one loses nothing
but the local readable copy. Splitting the record by day keeps it navigable: a
diff names the day that changed, a year of work does not become one unbounded
file, and the prompt path can show the newest days without reading the whole
history. Keeping the files under ``.agents/`` puts them next to the other
agent-facing files (``.agents/skills``) instead of dropping generated files in
the repository root, and a project that wants them versioned or ignored can
choose either without the layout moving again.

The file date is the UTC date of the records it holds — the same date the
timestamps inside it show — so the derived text is identical on every machine
that shares the checkout. A record made at 00:30 local time in UTC+8 therefore
belongs to the previous UTC day; that is deliberate stability, not an accident.

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
from typing import Any, Mapping, Sequence

from .errors import ConflictError, ValidationError
from .project_skills import SKILL_NAME, parse_frontmatter
from .storage import to_iso, utcnow

#: Agent-facing directory shared by the work records, the rules and the skills.
AGENTS_DIR = Path(".agents")
MEMORY_DIR = AGENTS_DIR / "memory"
RULES_DIR = AGENTS_DIR / "rules"

#: One generated work record per day, named after the UTC date of its records.
MEMORY_FILE_SUFFIX = ".md"
_MEMORY_DAY_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.md$")
_MEMORY_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")

#: The marker the writer puts on line 1 of every generated file; it is how a
#: generated record is told apart from a Markdown file a human wrote by hand.
#: Kept identical to the historical ``DSH_MEMORY.md`` marker so old checkouts
#: are recognized.
PROJECT_SUMMARY_MARKER = "<!-- dsh-memory:project-summary -->"

#: The pre-``.agents`` location. Still recognized, never written again.
LEGACY_PROJECT_SUMMARY_FILE = "DSH_MEMORY.md"

#: The one-file-per-project ``.agents`` layout, where ``MEMORY.md`` held every
#: day. Recognized only so the writer can replace it with the date files.
LEGACY_PROJECT_MEMORY_FILE = "MEMORY.md"

#: Forward-slash spellings used in docs, status payloads and tests.
PROJECT_MEMORY_DIR_RELATIVE = MEMORY_DIR.as_posix()
PROJECT_RULES_RELATIVE = RULES_DIR.as_posix()

#: The writer's own header line records the newest record's time.
_UPDATED = re.compile(r"更新于\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
_RULE_HEADING = re.compile(r"^#\s+(.+)$", re.MULTILINE)


# ══ paths ═══════════════════════════════════════════════════════════════


def memory_dir(project_root: Path | str) -> Path:
    """The directory holding this checkout's one-file-per-day work records."""
    return Path(project_root) / MEMORY_DIR


def day_memory_path(project_root: Path | str, day: str) -> Path:
    """The record file for one UTC day, e.g. ``.agents/memory/2026-11-07.md``."""
    return memory_dir(project_root) / f"{day}{MEMORY_FILE_SUFFIX}"


def rules_dir(project_root: Path | str) -> Path:
    """The directory scanned for this checkout's one-file-per-rule Markdown."""
    return Path(project_root) / RULES_DIR


def legacy_memory_path(project_root: Path | str) -> Path:
    """The old root file, kept only so the writer can clean it up."""
    return Path(project_root) / LEGACY_PROJECT_SUMMARY_FILE


def single_file_memory_path(project_root: Path | str) -> Path:
    """The previous ``.agents/memory/MEMORY.md`` layout, kept for migration."""
    return memory_dir(project_root) / LEGACY_PROJECT_MEMORY_FILE


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


def _generated_memory_files(project_root: Path | str) -> list[tuple[str, Path, str]]:
    """This checkout's generated day files as ``(day, path, text)``, newest first.

    Only files named ``YYYY-MM-DD.md`` and carrying the writer's marker are
    returned: ``.agents/memory`` is agent-facing, but a hand-written note that
    happens to be date-named must not be read back as recorded work or deleted
    by the writer. Unreadable files are skipped, exactly as a missing directory
    is: a read-only checkout is not an error.
    """
    base = memory_dir(project_root)
    try:
        entries = sorted(base.iterdir(), key=lambda path: path.name, reverse=True)
    except OSError:
        return []
    found: list[tuple[str, Path, str]] = []
    for path in entries:
        match = _MEMORY_DAY_FILE.match(path.name)
        if match is None or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if not text.lstrip().startswith(PROJECT_SUMMARY_MARKER):
            continue
        found.append((match.group(1), path, text))
    return found


def list_memory_files(project_root: Path | str) -> list[Path]:
    """The generated day files, newest date first (unreadable ones skipped)."""
    return [path for _day, path, _text in _generated_memory_files(project_root)]


def read_project_memory(project_root: Path | str, *, max_chars: int = 1200) -> dict[str, Any]:
    """Read the day records into the shape the prompt renderer consumes.

    The excerpt is built newest day first so a session always sees the most
    recent work; the whole-file ``chars`` (summed over days) lets a host say
    "there is more" without reading the records again. A project that recorded
    nothing — or a read-only checkout — is not an error: ``exists: false`` means
    "no readable record", and the caller falls back to the database.

    A checkout written by the previous single-file layout still yields its
    excerpt until the writer has converted it, so a read-only copy of an old
    project does not lose its context the moment the plugin is upgraded.
    """
    result: dict[str, Any] = {
        "dir": str(memory_dir(project_root)),
        "path": None,
        "exists": False,
        "files": [],
        "days": [],
        "chars": 0,
        "updated": None,
        "excerpt": "",
        "truncated": False,
        "legacy": False,
    }

    files = _generated_memory_files(project_root)
    if files:
        chunks: list[str] = []
        for day, path, text in files:
            result["files"].append(str(path))
            result["days"].append(day)
            result["chars"] += len(text)
            if result["updated"] is None:
                stamp = _UPDATED.search(text)
                if stamp:
                    result["updated"] = stamp.group(1)
            cleaned = _clean_memory_text(text)
            if cleaned:
                chunks.append(cleaned)
        result["exists"] = True
        result["path"] = str(files[0][1])
        excerpt, truncated = _cap_lines("\n".join(chunks), int(max_chars))
        result["excerpt"] = excerpt
        result["truncated"] = truncated
        return result

    # The previous single-file layout. Read-only checkouts keep working until
    # some write can convert the file into per-day records.
    legacy = single_file_memory_path(project_root)
    try:
        text = legacy.read_text(encoding="utf-8")
    except OSError:
        return result
    if not text.strip():
        return result
    result["exists"] = True
    result["legacy"] = True
    result["path"] = str(legacy)
    result["chars"] = len(text)
    stamp = _UPDATED.search(text)
    result["updated"] = stamp.group(1) if stamp else None
    excerpt, truncated = _cap_lines(_clean_memory_text(text), int(max_chars))
    result["excerpt"] = excerpt
    result["truncated"] = truncated
    return result


# ══ writing the derived day records ═════════════════════════════════════


def render_memory_day(
    *,
    project_id: str,
    display_name: str | None,
    day: str,
    updated: str,
    entries: Sequence[str],
) -> str:
    """One day's record file: marker, title, provenance block, date and lines.

    ``entries`` are already-rendered ``- ...`` lines; separating the formatting
    from the database query keeps this module free of storage imports. The
    per-day ``## day`` heading is kept even though the file name carries the
    date: the prompt concatenates several day excerpts, and a heading is what
    keeps the boundary readable there.
    """
    display = display_name or project_id
    lines = [
        PROJECT_SUMMARY_MARKER,
        f"# 项目摘要：{display} · {day}",
        "",
        f"> 项目 ID：`{project_id}` · 由 dsh-memory 自动维护 · 更新于 {updated}",
        f"> 本文件只记录 {day} 已做过的工作；经验教训与偏好不在此文件中。",
        "> 用户对项目的约定、规则、限制在 `.agents/rules/`（一条规则一份 markdown）。",
        "",
        f"## {day}",
        "",
        *entries,
        "",
    ]
    return "\n".join(lines).rstrip() + "\n"


def write_memory_files(
    project_root: Path | str,
    days: Mapping[str, str],
    *,
    known_days: Sequence[str] | None = None,
) -> list[str]:
    """Reconcile ``.agents/memory`` with the derived per-day records.

    Each changed day is written atomically (temp file + ``os.replace``) with
    LF endings; a day whose file already holds the exact text is left alone, so
    a digest commit that records nothing new touches no file.

    ``known_days`` is every day this project has ever had a record on, whatever
    its later state. A generated day file is deleted only when its day is in
    ``known_days`` but no longer in ``days`` (all its records were forgotten or
    superseded). A file whose day the project never knew is left alone on
    purpose: project identity can drift (a git remote added later turns a
    path-based id into a remote-based one), and a checkout shared by two ids
    must not lose the other id's record to a reconcile. Files without the
    writer's marker are never deleted: a hand-written note there is not
    provably ours. The single-file ``MEMORY.md`` and the older root
    ``DSH_MEMORY.md`` are removed once they carry the marker and there are
    records to replace them, which is what finishes the two layout migrations.
    OSError is left to the caller, which contains it per project so a read-only
    checkout cannot fail digest generation.
    """
    root = Path(project_root)
    base = memory_dir(root)
    wanted = {
        str(day): str(text)
        for day, text in days.items()
        if _MEMORY_DAY.match(str(day)) and str(text).strip()
    }
    if wanted:
        base.mkdir(parents=True, exist_ok=True)

    written: list[str] = []
    for day in sorted(wanted, reverse=True):
        target = day_memory_path(root, day)
        text = wanted[day]
        if target.is_file():
            try:
                if target.read_text(encoding="utf-8") == text:
                    continue
            except OSError:
                pass
        temporary = target.with_name(target.name + ".tmp")
        with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary, target)
        written.append(str(target))

    known = set(known_days or ())
    for day, path, _text in _generated_memory_files(root):
        if day in wanted:
            continue
        if day not in known:
            continue
        try:
            path.unlink()
        except OSError:
            # Cleanup is best effort: the new records have already been
            # written, and a vanished/locked old file is not a write failure.
            pass

    if wanted:
        for legacy in (single_file_memory_path(root), legacy_memory_path(root)):
            try:
                if legacy.is_file() and legacy.read_text(
                    encoding="utf-8"
                ).lstrip().startswith(PROJECT_SUMMARY_MARKER):
                    legacy.unlink()
            except OSError:
                pass
    return written


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
