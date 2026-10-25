"""The host bridge: one JSON request in, one JSON response out.

The DSH plugin never imports this package into its own JavaScript process.
Instead the host runs ``python -m memory_system <command>``, writes one request
object on stdin and reads one response object on stdout. That boundary is on
purpose:

* **No shared runtime.** The plugin is JavaScript, the memory system is Python;
  a subprocess is the smallest honest interface between them, and it keeps
  :class:`~memory_system.system.MemorySystem` free of any host SDK dependency
  (DESIGN.md §Portability).
* **Serialised access.** SQLite allows one writer. Requests execute one at a
  time against one database, so the single-writer assumption stays true even
  when the UI, a tool call and a debounced capture race each other.
* **Stable contract.** Every command is a plain function taking ``(memory,
  payload)`` and returning a JSON-serialisable dict; ``bridge.py`` is the only
  file the host needs to know about.

Wire format::

    request : {"id": "r1", "command": "digest.commit", "payload": {...}}
    response: {"id": "r1", "ok": true,  "result": {...}}
              {"id": "r1", "ok": false, "error": {"code": "...", "message": "..."}}

``--serve`` reads newline-delimited requests until stdin closes; the host uses
batch mode for one-off calls (``--command X`` with a JSON argument) and serve
mode when latency matters.
"""

from __future__ import annotations

import json
import os
import re
import sys
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from .config import MemoryConfig
from .errors import MemoryError, NotFoundError, ProviderError, ValidationError
from .l2 import summary_hash
from .l3 import FactInput
from .summary import (
    AUTO_MODE,
    DEFAULT_LENGTH,
    LENGTH_MAX,
    LENGTH_MIN,
    LENGTH_PRESETS,
    PROJECT_SUMMARY_FILE,
    PROMPT_VERSION,
    SUMMARY_MAX_CHARS,
    DigestService,
    MemoryNotepad,
    SummarySettings,
    export_markdown,
)
from .system import MemorySystem

BRIDGE_VERSION = 1

# Response envelopes are capped so a 4M-character digest cannot blow up a pipe
# frame; the host truncates for display and offers download for the rest.
MAX_RESPONSE_CHARS = 8_000_000


class BridgeError(Exception):
    """A command failed in a way the host should report verbatim."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ══ project identity ════════════════════════════════════════════════════
#
# A DSH session carries ``cwd`` and no project id. The rule (from
# ``adapters.turns.ProjectResolver``) is: prefer the git remote, because two
# checkouts of one repository must resolve to one project; otherwise use the
# working directory. The resolution is pure so it can be tested without git.


def _git_remote_from_config(directory: Path) -> str | None:
    """Read a remote URL from ``.git/config`` without running git.

    Running ``git`` per turn would add process latency to a hot path and fail
    in environments without git; the config file is the same source of truth
    git itself uses.

    ``origin`` wins when present, but a fork that only has ``upstream`` (or a
    hand-named mirror) must still resolve to the same project, so any other
    remote is better than falling back to the directory path.
    """
    config = directory / ".git" / "config"
    try:
        text = config.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    remotes: dict[str, str] = {}
    current: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            if section.startswith("remote ") and len(section) > 8:
                current = section[7:].strip().strip("\"'")
            else:
                current = None
            continue
        if current is None:
            continue
        # `url = ...` only: a bare `startswith("url")` also matches `urlx`.
        if line.lower().startswith("url"):
            key, sep, value = line.partition("=")
            if not sep or key.strip().lower() != "url":
                continue
            value = value.strip()
            if value:
                remotes.setdefault(current, value)
    if "origin" in remotes:
        return remotes["origin"]
    return next(iter(remotes.values()), None)


def resolve_project_id(cwd: str | None) -> str:
    from .adapters.turns import ProjectResolver

    if not cwd:
        return ProjectResolver().resolve(None)
    directory = Path(cwd)
    remote = None
    probe = directory
    for _ in range(6):  # a worktree may sit a few levels under the repo root
        remote = _git_remote_from_config(probe)
        if remote:
            break
        if probe.parent == probe:
            break
        probe = probe.parent
    return ProjectResolver().resolve(str(directory), git_remote=remote)


def resolve_project_root(cwd: str | None) -> str | None:
    """The directory that owns a project's ``DSH_MEMORY.md``.

    A session may start in a subdirectory, so walk up to the git top level
    when there is one; otherwise the working directory itself is the root.
    """
    if not cwd:
        return None
    try:
        directory = Path(cwd).expanduser().resolve()
    except OSError:
        directory = Path(cwd).expanduser()
    probe = directory
    for _ in range(12):
        if (probe / ".git").exists():
            return str(probe)
        if probe.parent == probe:
            break
        probe = probe.parent
    return str(directory)


# ══ database handle ═════════════════════════════════════════════════════


def default_home() -> Path:
    explicit = os.environ.get("DSH_MEMORY_HOME")
    if explicit:
        return Path(explicit).expanduser()
    dsh_home = os.environ.get("DSH_HOME")
    if dsh_home:
        return Path(dsh_home).expanduser() / "memory"
    return Path.home() / ".dsh" / "memory"


@dataclass(slots=True)
class Scope:
    """Everything one bridge invocation needs to reach the database."""

    home: Path
    embedding_preset: str | None = None
    db_path: Path | None = None
    _cache: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "Scope":
        home = payload.get("home")
        db = payload.get("db_path")
        preset = payload.get("embedding_preset") or None
        return cls(
            home=Path(home).expanduser() if home else default_home(),
            embedding_preset=preset,
            db_path=Path(db).expanduser() if db else None,
        )


# Serving keeps one MemorySystem per scope for the process lifetime.
# One-shot mode (a request handled outside serve) still opens and closes
# per call, as before.
_SERVE_SYSTEMS: dict[tuple[str, str | None, str | None], MemorySystem] | None = None


def _cache_key(scope: Scope) -> tuple[str, str | None, str | None]:
    try:
        home = str(scope.home.resolve())
    except OSError:
        home = str(scope.home)
    db_key = str(Path(scope.db_path).resolve()) if scope.db_path is not None else None
    return (home, db_key, scope.embedding_preset)


def _build_config(scope: Scope) -> MemoryConfig:
    scope.home.mkdir(parents=True, exist_ok=True)
    overrides: dict[str, Any] = {}
    if scope.embedding_preset:
        overrides["embedding_preset"] = scope.embedding_preset
    config = MemoryConfig.for_home(scope.home, **overrides)
    if scope.db_path is not None:
        config = config.with_(db_path=str(scope.db_path))
    return config


@contextmanager
def open_memory(scope: Scope) -> Iterator[MemorySystem]:
    """Open the database for the duration of one request and close it after.

    ``on_unavailable="warn"`` keeps a broken embedding endpoint from turning
    every host call into an exception: the digest and the memory list still
    work, and the degraded probe is reported back with the result.

    While serving, the system is kept open between requests instead: opening
    is not free (the startup probe can hit the embedding endpoint — up to
    seconds on a stalled HTTP host — and sqlite-vec's first-touch warm-up
    costs real latency), and paying it on every turn was the single largest
    fixed cost of the bridge. Keyed by {home, db_path, preset}; the host may
    only change either by sending a different payload scope, which maps to a
    different key. One-shot mode still closes after the request.
    """
    if _SERVE_SYSTEMS is not None:
        key = _cache_key(scope)
        cached = _SERVE_SYSTEMS.get(key)
        if cached is not None:
            yield cached
            return
    config = _build_config(scope)
    memory = MemorySystem(config)
    if _SERVE_SYSTEMS is not None:
        _SERVE_SYSTEMS[_cache_key(scope)] = memory
        try:
            yield memory
        finally:
            pass  # stays open for the next request; serve() closes them all
    else:
        try:
            yield memory
        finally:
            memory.close()


def probe_payload(memory: MemorySystem) -> dict[str, Any]:
    probe = getattr(memory, "probe", None)
    return {
        "ok": bool(getattr(probe, "ok", True)),
        "provider": getattr(probe, "provider", None),
        "dim": getattr(probe, "dim", None),
        "degraded": bool(getattr(probe, "degraded", False)),
        "detail": getattr(probe, "detail", None),
    }


# ══ commands ════════════════════════════════════════════════════════════

Command = Callable[[MemorySystem, dict[str, Any]], dict[str, Any]]
_REGISTRY: dict[str, Command] = {}


def command(name: str) -> Callable[[Command], Command]:
    def register(fn: Command) -> Command:
        _REGISTRY[name] = fn
        return fn

    return register


def commands() -> list[str]:
    return sorted(_REGISTRY)


def _project(payload: dict[str, Any]) -> str:
    project = payload.get("project_id")
    if project:
        return str(project)
    return resolve_project_id(payload.get("cwd"))


def _refresh_project_summary(memory: MemorySystem, project_id: str) -> None:
    """Keep the project's root Markdown in step with a memory edit/write."""
    try:
        DigestService(memory).write_project_summaries(project_id=project_id)
    except Exception:  # noqa: BLE001 - a derived file must never fail a write
        pass


def _bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def _limit(payload: dict[str, Any], key: str, default: int, ceiling: int) -> int:
    try:
        value = int(payload.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(1, min(value, ceiling))


@command("ping")
def _ping(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    """Liveness probe for the host's bridge lifecycle (a no-op read).

    The host uses this to decide whether an unresponsive child must be
    killed and restarted, or is merely slow on one request — so it must be
    the cheapest command in the registry.
    """
    return {"version": BRIDGE_VERSION}


# ── status ──────────────────────────────────────────────────────────────


@command("status")
def cmd_status(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    service = DigestService(memory)
    settings = service.settings()
    project = _project(payload)
    root = resolve_project_root(payload.get("cwd"))
    memory.ensure_project(
        project, display_name=payload.get("display_name"), root_path=root
    )
    if root:
        service.write_project_summaries(project_id=project)
    latest = service.latest(scope="global")
    notepad = MemoryNotepad(memory)
    listing = notepad.list(project_id=project, limit=1)
    stats: dict[str, Any]
    try:
        stats = _jsonable(memory.stats(project))
    except Exception as exc:  # noqa: BLE001 - stats are diagnostics, never fatal
        stats = {"error": str(exc)}
    return {
        "version": BRIDGE_VERSION,
        "prompt_version": PROMPT_VERSION,
        "home": str(memory.config.db_path),
        "project_id": project,
        "projects": [p.project_id for p in memory.list_projects()],
        "settings": settings.to_dict(),
        "digest": latest.to_dict() if latest else None,
        "project_summary": str(Path(root) / PROJECT_SUMMARY_FILE) if root else None,
        "memories": listing["total"],
        "probe": probe_payload(memory),
        "stats": stats,
        "pending_candidates": len(memory.review_candidates(project_id=project)),
    }


@command("projects")
def cmd_projects(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    project = _project(payload)
    root = resolve_project_root(payload.get("cwd"))
    memory.ensure_project(
        project, display_name=payload.get("display_name"), root_path=root
    )
    # First contact with a project is also what creates its root Markdown file.
    if root:
        DigestService(memory).write_project_summaries(project_id=project)
    return {
        "project_id": project,
        "projects": [
            {
                "project_id": p.project_id,
                "display_name": p.display_name,
                "root_path": p.root_path,
                "last_seen_at": p.last_seen_at,
            }
            for p in memory.list_projects()
        ],
    }


# ── settings ────────────────────────────────────────────────────────────


@command("settings.get")
def cmd_settings_get(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    return _settings_payload(DigestService(memory).settings())


@command("settings.set")
def cmd_settings_set(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    service = DigestService(memory)
    settings = service.settings()
    if "length" in payload and payload["length"] is not None:
        settings = service.set_length(payload["length"])
    if "mode" in payload and payload["mode"] is not None:
        settings = service.set_mode(payload["mode"])
    if "profile" in payload and payload["profile"] is not None:
        settings = service.set_profile(str(payload["profile"]))
    return _settings_payload(settings)


def _settings_payload(settings: SummarySettings) -> dict[str, Any]:
    return {
        "settings": settings.to_dict(),
        "presets": list(LENGTH_PRESETS),
        "min": LENGTH_MIN,
        "max": LENGTH_MAX,
        "default": DEFAULT_LENGTH,
        "modes": [AUTO_MODE],
    }


# ── profile ─────────────────────────────────────────────────────────────


@command("profile.read")
def cmd_profile_read(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    service = DigestService(memory)
    settings = service.settings()
    return {
        "content": settings.profile,
        "updated_at": settings.profile_updated_at,
        "max_chars": settings.to_dict()["profile_max_chars"],
    }


@command("profile.write")
def cmd_profile_write(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    service = DigestService(memory)
    # ``content`` is the documented key; ``profile`` is accepted because the
    # settings form submits the whole settings object. A missing key means
    # "empty profile", an explicit ``null`` means the same, never "no change".
    raw = payload["content"] if "content" in payload else payload.get("profile")
    settings = service.set_profile(str(raw or ""))
    return {
        "content": settings.profile,
        "updated_at": settings.profile_updated_at,
        "chars": len(settings.profile),
    }


# ── digest ──────────────────────────────────────────────────────────────


@command("digest.plan")
def cmd_digest_plan(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    project = _project(payload)
    root = resolve_project_root(payload.get("cwd"))
    memory.ensure_project(
        project, display_name=payload.get("display_name"), root_path=root
    )
    request = DigestService(memory).plan(length=payload.get("length"))
    result = request.to_dict()
    result["has_materials"] = request.materials.get("episodes", 0) > 0
    return result


@command("digest.commit")
def cmd_digest_commit(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    project = _project(payload)
    service = DigestService(memory)
    root = resolve_project_root(payload.get("cwd"))
    memory.ensure_project(project, root_path=root)
    record = service.commit(
        text=str(payload.get("text") or ""),
        length=payload.get("target_chars"),
        reason=str(payload.get("reason") or "manual"),
        generator=payload.get("generator"),
        prompt_version=int(payload.get("prompt_version") or PROMPT_VERSION),
        sources=payload.get("sources") or (),
        materials_chars=int(payload.get("material_chars") or payload.get("materials_chars") or 0),
        error=payload.get("error"),
    )
    return {"digest": record.to_dict()}


@command("digest.view")
def cmd_digest_view(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    service = DigestService(memory)
    project = _project(payload)
    digest_id = payload.get("digest_id")
    if digest_id:
        record = service.get(str(digest_id))
        if record is None:
            raise BridgeError("not_found", f"digest {digest_id} not found")
    else:
        record = service.latest(scope="global")
    history = service.history(scope="global", limit=_limit(payload, "history", 20, 100))
    return {
        "digest": record.to_dict() if record else None,
        "history": [d.to_dict() for d in history],
        "scope": "global",
        "project_id": project,
    }


@command("digest.history")
def cmd_digest_history(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    service = DigestService(memory)
    project = _project(payload)
    history = service.history(scope="global", limit=_limit(payload, "limit", 30, 200))
    return {"items": [d.to_dict() for d in history], "scope": "global", "project_id": project}


@command("digest.delete")
def cmd_digest_delete(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    digest_id = str(payload.get("digest_id") or "")
    if not digest_id:
        raise BridgeError("bad_request", "digest_id is required")
    removed = DigestService(memory).delete(digest_id)
    return {"deleted": removed, "digest_id": digest_id}


@command("digest.anchor")
def cmd_digest_anchor(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    anchors = DigestService(memory).anchors(
        include_summary=payload.get("include_summary"),
        include_profile=_bool(payload.get("include_profile", True)),
    )
    return anchors


# ── memories ────────────────────────────────────────────────────────────


@command("memory.list")
def cmd_memory_list(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    project = _project(payload)
    notepad = MemoryNotepad(memory)
    listing = notepad.list(
        project_id=None if _bool(payload.get("all_projects")) else project,
        query=payload.get("query"),
        state=payload.get("state") or None,
        event_type=payload.get("event_type") or None,
        limit=_limit(payload, "limit", 50, 500),
        offset=max(0, int(payload.get("offset") or 0)),
        include_superseded=_bool(payload.get("include_superseded")),
    )
    listing["project_id"] = project
    return listing


@command("memory.get")
def cmd_memory_get(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    return {"memory": MemoryNotepad(memory).get(str(payload.get("memory_id")))}


@command("memory.update")
def cmd_memory_update(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    memory_id = str(payload.get("memory_id") or "")
    patch = payload.get("patch") or {}
    if not isinstance(patch, dict):
        raise BridgeError("bad_request", "patch must be an object")
    updated = MemoryNotepad(memory).update(memory_id, patch)
    _refresh_project_summary(memory, str(updated.get("project_id") or ""))
    return {"memory": updated}


@command("memory.forget")
def cmd_memory_forget(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    memory_id = str(payload.get("memory_id") or "")
    forgotten = MemoryNotepad(memory).forget(memory_id)
    _refresh_project_summary(memory, str(forgotten.get("project_id") or ""))
    return {"memory": forgotten}


@command("memory.restore")
def cmd_memory_restore(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    memory_id = str(payload.get("memory_id") or "")
    restored = MemoryNotepad(memory).restore(memory_id)
    _refresh_project_summary(memory, str(restored.get("project_id") or ""))
    return {"memory": restored}


@command("memory.remember")
def cmd_memory_remember(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    project = _project(payload)
    summary = str(payload.get("summary") or "").strip()
    if not summary:
        raise BridgeError("bad_request", "summary is required")
    facts = []
    for raw in payload.get("facts") or ():
        if not isinstance(raw, dict):
            continue
        try:
            facts.append(
                {
                    "head": str(raw["head"]),
                    "relation": str(raw["relation"]),
                    "tail": str(raw["tail"]),
                    "confidence": float(raw.get("confidence", 0.8)),
                    "valid_from": raw.get("valid_from"),
                }
            )
        except KeyError:
            continue
    result = memory.remember(
        project_id=project,
        summary=summary,
        importance=payload.get("importance"),
        event_type=payload.get("event_type") or "manual",
        participants=payload.get("participants"),
        outcome=payload.get("outcome"),
        session_key=payload.get("session_key"),
        meta={"source": payload.get("source") or "manual"},
        facts=facts,
    )
    _refresh_project_summary(memory, project)
    return {"remembered": _jsonable(result), "project_id": project}


@command("memory.recall")
def cmd_memory_recall(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    project = _project(payload)
    query = str(payload.get("query") or "").strip()
    if not query:
        raise BridgeError("bad_request", "query is required")
    result = memory.recall(
        query,
        project_id=project,
        mode=str(payload.get("mode") or "auto"),  # type: ignore[arg-type]
        k_l2=_limit(payload, "k_l2", 6, 40),
        k_l3=_limit(payload, "k_l3", 8, 40),
        include_dormant=_bool(payload.get("include_dormant")),
        as_of=str(payload["as_of"]) if payload.get("as_of") else None,
    )
    return {"result": _jsonable(result.to_dict()), "project_id": project}


@command("memory.capture")
def cmd_memory_capture(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    """Record one conversation step the host observed.

    Idempotent per ``(session_key, seq)``: a retry, a resumed session, or two
    host instances must not inflate the store by writing the step twice.

    A caller that omits ``seq`` still gets retry protection — the key falls
    back to ``(session_key, text)``, which absorbs a byte-identical replay.
    Callers that omit ``session_key`` too are relying on the write path's
    content dedup; that is not idempotency, so ``dedupe_key`` says which mode
    applied instead of pretending the call was protected.
    """
    project = _project(payload)
    text = str(payload.get("text") or "").strip()
    if not text:
        raise BridgeError("bad_request", "text is required")
    session_key = payload.get("session_key")
    seq = payload.get("seq")
    if session_key and seq is not None:
        dedupe_key = f"dsh.capture:{session_key}:{seq}"
    elif session_key:
        # No sequence number: fall back to the text so an identical replay of
        # the same message in the same session is still absorbed.
        dedupe_key = f"dsh.capture:{session_key}:text:{summary_hash(text)}"
    else:
        dedupe_key = None
    if dedupe_key and memory.store.get_meta(dedupe_key):
        return {
            "captured": None,
            "deduped": True,
            "duplicate": True,
            "dedupe_key": dedupe_key,
            "project_id": project,
        }
    memory.ensure_project(
        project,
        display_name=payload.get("display_name"),
        root_path=resolve_project_root(payload.get("cwd")),
    )
    report: dict[str, Any] = {}
    result = memory.remember(
        project_id=project,
        summary=text,
        importance=payload.get("importance"),
        event_type=str(payload.get("event_type") or "turn"),
        outcome=payload.get("outcome"),
        session_key=session_key,
        meta={
            "source": str(payload.get("source") or "dsh-session"),
            "session_id": payload.get("session_id"),
            "seq": seq,
        },
        report=report,
    )
    if dedupe_key:
        memory.store.set_meta(dedupe_key, "1")
    # ``duplicate`` is the honest signal: it is True when no new row appeared,
    # whether that came from the dedupe key or from the write path merging the
    # text into an existing episode.
    _refresh_project_summary(memory, project)
    return {
        "captured": _jsonable(result),
        "deduped": False,
        "duplicate": bool(report.get("reused")),
        "dedupe_key": dedupe_key,
        "project_id": project,
    }


# ── backup / restore ────────────────────────────────────────────────────


def _backup_target(memory: MemorySystem, payload: dict[str, Any]) -> Path:
    """Where an export that cannot travel inline is written.

    Next to the database it was read from, under ``exports/``: a file the user
    can keep, find again, and hand to ``backup.restore``. A store that is not a
    file (the in-memory database tests use) falls back to the requested home.
    """
    store = Path(str(memory.config.db_path))
    base = Scope.from_payload(payload).home if str(store) == ":memory:" else store.parent
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
    return base / "exports" / f"dsh-memory-backup-{stamp}.md"


def _write_backup(markdown: str, target: Path) -> Path:
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(markdown, encoding="utf-8")
    except OSError as exc:
        # A path the caller chose is caller input, not a bug in the store:
        # report it as one instead of an ``internal`` failure.
        raise BridgeError("bad_request", f"cannot write the backup to {target}: {exc}") from exc
    return target


def _read_backup(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise BridgeError("bad_request", f"cannot read the backup at {path}: {exc}") from exc


def _fits_one_envelope(result: dict[str, Any]) -> bool:
    """Whether ``result`` still fits the serve loop's response cap.

    ``_serve_loop`` replaces an oversized envelope with an error, so the size
    has to be checked here, where the markdown still exists and a fallback can
    take over. The request id is not known at this depth; the placeholder id
    only makes the estimate a few bytes pessimistic.
    """
    probe = {"id": "0" * 64, "ok": True, "result": result}
    return len(json.dumps(probe, ensure_ascii=False)) <= MAX_RESPONSE_CHARS


@command("backup.export")
def cmd_backup_export(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    projects = payload.get("projects")
    if isinstance(projects, str):
        projects = [projects]
    markdown = export_markdown(
        memory,
        projects=list(projects) if projects else None,
        include_digests=_bool(payload.get("include_digests", True)),
        include_profile=_bool(payload.get("include_profile", True)),
        max_episodes=_limit(payload, "max_episodes", 2000, 20000),
    )
    counts = {"chars": len(markdown), "lines": markdown.count("\n")}
    path = payload.get("path")
    if path:
        target = _write_backup(markdown, Path(str(path)).expanduser())
        return {"path": str(target), "inline": False, **counts}
    result = {"markdown": markdown, "inline": True, **counts}
    if _fits_one_envelope(result):
        return result
    # A backup of a large store (up to 20k episodes) can exceed one response
    # envelope, and an oversized envelope is replaced wholesale with an error:
    # the export would fail with "narrow the request" and no way to narrow it.
    # The command already knows how to write a file, so spill it there and let
    # the caller read it back (the plugin does, outside the pipe cap).
    target = _write_backup(markdown, _backup_target(memory, payload))
    return {"path": str(target), "inline": False, **counts}


def parse_backup_markdown(text: str) -> dict[str, Any]:
    """Read what :func:`export_markdown` wrote, tolerantly.

    All four sections are read: profile, digest history, memories and facts.
    Foreign Markdown is accepted too: bullets with ``- <text>`` and no ids are
    imported into the project named in ``default_project``.
    """
    profile_section: list[str] = []
    memories: list[dict[str, Any]] = []
    digests: list[dict[str, Any]] = []
    facts: list[dict[str, Any]] = []
    header: dict[str, Any] = {}
    section = ""
    current: dict[str, Any] | None = None
    project: str | None = None
    for raw in (text or "").splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if stripped.startswith(f"<!--{BACKUP_MARKER_HINT}") and stripped.endswith("-->"):
            start = stripped.find("{")
            end = stripped.rfind("}")
            if 0 <= start < end:
                try:
                    header = json.loads(stripped[start : end + 1])
                except json.JSONDecodeError:
                    header = {}
            continue
        if stripped.startswith("## "):
            title = stripped[3:].strip()
            if section.startswith("记忆摘要") and current is not None and not _is_backup_section(title):
                # Digest bodies are written verbatim, so a summary with its own
                # "## ..." sub-heading must not be mistaken for the next
                # section. Only the exporter's own four titles end a section.
                current["lines"].append(line)
                continue
            section = title
            current = None
            continue
        if stripped.startswith("### "):
            heading = stripped[4:].strip()
            if section.startswith("记忆摘要"):
                match = _DIGEST_HEADING.match(heading)
                if match:
                    digest_id, where, status, chars, created = match.groups()
                    scope = "global" if where == "全局" else "project"
                    current = {
                        "digest_id": digest_id,
                        "scope": scope,
                        "scope_ref": None if scope == "global" else where,
                        "status": status,
                        "chars": int(chars),
                        "created_at": _backup_time(created),
                        "lines": [],
                    }
                    digests.append(current)
                elif current is not None:
                    # A digest body may contain its own "### ..." sub-headings;
                    # only the "摘要 <id>（...）" form starts a new record.
                    current["lines"].append(line)
                continue
            current = None
            if section.startswith("记忆条目"):
                project = _strip_project_heading(heading)
            elif section.startswith("事实"):
                project = _strip_project_heading(heading)
            continue
        if section.startswith("用户画像"):
            profile_section.append(line)
            continue
        if section.startswith("记忆摘要"):
            if current is not None:
                current["lines"].append(line)
            continue
        if section.startswith("事实"):
            match = _FACT_LINE.match(stripped)
            if match:
                edge_id, head, relation, tail, confidence = match.groups()
                facts.append(
                    {
                        "edge_id": edge_id,
                        "project_id": project,
                        "head": head,
                        "relation": relation,
                        "tail": tail,
                        "confidence": float(confidence),
                    }
                )
            continue
        if section.startswith("记忆条目"):
            if stripped.startswith("- [ ] `") or stripped.startswith("- [x] `"):
                current = {"project_id": project}
                memories.append(current)
                rest = stripped[6:]
                if rest.startswith("`"):
                    memory_id, _, rest = rest[1:].partition("`")
                    current["memory_id"] = memory_id
                continue
            if stripped.startswith("- ") and current is not None:
                body = stripped[2:].strip()
                # Strip the label prefix once, then keep the remainder whole: a
                # value that itself contains ":" (an outcome of
                # "错误: 超时") must not be cut down to its last segment.
                if body.startswith("项目:") or body.startswith("项目："):
                    current["project_id"] = _strip_label(body, "项目").strip("`")
                elif body.startswith("结果:") or body.startswith("结果："):
                    current["outcome"] = _strip_label(body, "结果")
                elif not current.get("summary"):
                    current["summary"] = body
                continue
    for digest in digests:
        content = "\n".join(digest.pop("lines")).strip()
        # The exporter writes a placeholder for an empty digest; importing the
        # placeholder as content would turn "no summary" into a fake one.
        digest["content"] = "" if content == "（空）" else content
    profile = "\n".join(profile_section).strip()
    if profile == "（空）":
        profile = ""
    return {"header": header, "profile": profile, "memories": memories, "digests": digests, "facts": facts}


def _backup_time(text: str) -> str | None:
    """Undo the exporter's display timestamp (``YYYY-MM-DD HH:MM:SS``, UTC).

    Storing the display form verbatim would sort every restored digest before
    same-day native ones (``" "`` < ``"T"`` in string order), so history order
    would drift on every restore.
    """
    try:
        ts = datetime.fromisoformat(text.strip().replace(" ", "T"))
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.isoformat()


def _strip_project_heading(heading: str) -> str:
    if heading.startswith("项目"):
        return heading[2:].strip()
    return heading


def _is_backup_section(title: str) -> bool:
    return title.startswith(("用户画像", "记忆摘要", "记忆条目", "事实"))


# ``### 摘要 dg_xxx（全局 · ok · 123 字 · 2026-01-02 03:04:05）``
_DIGEST_HEADING = re.compile(r"^摘要\s+(\S+)（(.+?) · (.+?) · (\d+) 字 · (.+)）$")
# ``- `ed_xxx` head --rel--> tail （置信度 0.82）``
_FACT_LINE = re.compile(r"^- `([^`]*)` (.+?) --(.+?)--> (.+?) （置信度 ([\d.]+)）$")


def _strip_label(body: str, label: str) -> str:
    """Drop a leading ``label:`` / ``label：`` from one backup metadata line.

    The separator is removed once; whatever follows is the value, colons and
    all, so ``结果: 错误: 超时`` yields ``错误: 超时``.
    """
    for sep in (":", "："):
        prefix = f"{label}{sep}"
        if body.startswith(prefix):
            return body[len(prefix) :].strip()
    return body.strip()


BACKUP_MARKER_HINT = "dsh-memory-backup"


@command("backup.restore")
def cmd_backup_restore(memory: MemorySystem, payload: dict[str, Any]) -> dict[str, Any]:
    source = payload.get("path")
    if source:
        text = _read_backup(Path(str(source)).expanduser())
    else:
        text = str(payload.get("markdown") or "")
    if not text.strip():
        raise BridgeError("bad_request", "nothing to restore: pass path or markdown")
    dry_run = _bool(payload.get("dry_run"))
    # ``project_id`` here is only the fallback for items that carry none (a
    # foreign Markdown file). An exported backup records its own project on
    # every item; honouring that is what keeps a restore from dumping every
    # project into whichever one happens to be current.
    default_project = _project(payload)
    parsed = parse_backup_markdown(text)
    imported: list[str] = []
    skipped = 0
    failed: list[dict[str, Any]] = []
    too_long = 0
    limit = SUMMARY_MAX_CHARS
    notepad = MemoryNotepad(memory)
    service = DigestService(memory)
    # No enclosing transaction: ``remember`` opens its own, and an outer BEGIN
    # here would hide every uncommitted episode from the read that builds the
    # returned record, so each import would raise NotFoundError and be dropped
    # while this command still reported it as imported. A restore is
    # append-only, so per-item atomicity is the honest granularity anyway.
    existing_profile = service.get_profile()
    if parsed["profile"] and (_bool(payload.get("restore_profile", True)) or not existing_profile):
        if not dry_run:
            service.set_profile(parsed["profile"])
    for item in parsed["memories"]:
        summary = (item.get("summary") or "").strip()
        if not summary:
            skipped += 1
            continue
        if len(summary) > limit:
            # The editor's ceiling, enforced here so a backup of a row written
            # through another path still restores: a crash on one entry would
            # abort the remaining ones, and silently skipping it loses data.
            too_long += 1
            summary = summary[:limit]
        project = item.get("project_id") or default_project
        if dry_run:
            imported.append(project)
            continue
        try:
            result = memory.remember(
                project_id=project,
                summary=summary,
                event_type=payload.get("event_type") or "restored",
                meta={"source": "backup-restore", "memory_id": item.get("memory_id")},
            )
        except (ValidationError, MemoryError, BridgeError) as exc:
            # Report, never swallow: an entry that did not land must not be
            # counted in ``imported``.
            failed.append({"memory_id": item.get("memory_id"), "error": str(exc)[:200]})
            continue
        memory_id = result["memory_id"]
        if item.get("outcome"):
            try:
                notepad.update(memory_id, {"outcome": item["outcome"]})
            except (ValidationError, BridgeError):
                pass
        imported.append(project)

    # Digest history and the fact graph are part of the same document; a
    # restore that read only the memory bullets silently dropped both, so an
    # export -> restore round trip lost the summaries and every belief.
    digests_planned = 0
    digests_imported = 0
    for item in parsed["digests"]:
        if not item.get("content"):
            continue
        digests_planned += 1
        if dry_run:
            continue
        try:
            service.import_digest(
                scope=item["scope"],
                # A foreign document may have a digest section but no project
                # heading; a project-scoped row without a ref would never be
                # returned by ``latest(scope="project", project_id=...)``.
                project_id=item.get("scope_ref") or default_project,
                content=item["content"],
                created_at=item.get("created_at"),
            )
        except (ValidationError, MemoryError, BridgeError) as exc:
            failed.append({"digest_id": item.get("digest_id"), "error": str(exc)[:200]})
            continue
        digests_imported += 1

    facts_planned = 0
    facts_imported = 0
    for item in parsed["facts"]:
        facts_planned += 1
        if dry_run:
            continue
        project = item.get("project_id") or default_project
        try:
            # ``remember`` registers the project, but a backup can hold facts
            # for a project with no memory bullets at all; without this the
            # graph is restored but the project list never shows it.
            memory.ensure_project(project)
            decision = memory.l3.add_fact(
                project,
                FactInput(
                    head=item["head"],
                    relation=item["relation"],
                    tail=item["tail"],
                    confidence=item["confidence"],
                ),
            )
        except (ValidationError, MemoryError, BridgeError) as exc:
            failed.append({"edge_id": item.get("edge_id"), "error": str(exc)[:200]})
            continue
        if decision.status == "rejected":
            # A relation this database does not know, or a confidence floor:
            # report it instead of counting a fact that never landed.
            failed.append(
                {
                    "edge_id": item.get("edge_id"),
                    "error": f"fact rejected: {decision.reason}",
                }
            )
            continue
        facts_imported += 1

    return {
        "dry_run": dry_run,
        "imported": 0 if dry_run else len(imported),
        "planned": len(imported),
        "projects": sorted(set(imported)),
        "skipped": skipped,
        "truncated": too_long,
        "failed": failed,
        "digests": {"planned": digests_planned, "imported": digests_imported},
        "facts": {"planned": facts_planned, "imported": facts_imported},
        "profile_restored": bool(parsed["profile"]) and not dry_run,
        "header": parsed["header"],
    }


# ══ dispatch ════════════════════════════════════════════════════════════


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if hasattr(value, "to_dict"):
        return _jsonable(value.to_dict())
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _error_payload(exc: BaseException) -> dict[str, Any]:
    if isinstance(exc, BridgeError):
        code = exc.code
    elif isinstance(exc, NotFoundError):
        code = "not_found"
    elif isinstance(exc, ValidationError):
        code = "validation"
    elif isinstance(exc, ProviderError):
        code = "provider"
    elif isinstance(exc, MemoryError):
        code = "memory"
    else:
        code = "internal"
    return {"code": code, "message": f"{type(exc).__name__}: {exc}"}


def handle(request: dict[str, Any]) -> dict[str, Any]:
    """Execute one request in-process. Never raises: returns an envelope."""
    request_id = request.get("id")
    name = request.get("command")
    payload = request.get("payload") or {}
    if not isinstance(payload, dict):
        return {"id": request_id, "ok": False, "error": {"code": "bad_request", "message": "payload must be an object"}}
    handler = _REGISTRY.get(str(name))
    if handler is None:
        return {
            "id": request_id,
            "ok": False,
            "error": {"code": "unknown_command", "message": f"unknown command {name!r}; try {commands()}"},
        }
    # Parsing the scope touches the filesystem (``~`` expansion, an invalid
    # drive), so it belongs inside the guard too: an exception here used to
    # escape `handle` and end the serving process.
    try:
        scope = Scope.from_payload(payload)
        with open_memory(scope) as memory:
            result = handler(memory, payload)
    except Exception as exc:  # noqa: BLE001 - the wire must always answer
        return {"id": request_id, "ok": False, "error": _error_payload(exc)}
    return {"id": request_id, "ok": True, "result": _jsonable(result)}


def _read_line(stream: Any) -> str:
    """Read one UTF-8 line regardless of the interpreter's locale.

    The host always writes UTF-8, but a Windows child may have been started
    with a legacy console code page (``gbk`` here), where ``for line in
    sys.stdin`` silently mojibakes every CJK character. Reading raw bytes and
    decoding explicitly is the only form that is correct on both platforms.
    """
    raw = stream.buffer.readline() if hasattr(stream, "buffer") else stream.readline()
    if raw in (b"", ""):
        return ""
    if isinstance(raw, bytes):
        return raw.decode("utf-8-sig", errors="replace")
    return raw


def _write_line(stream: Any, text: str) -> None:
    data = (text + "\n").encode("utf-8")
    if hasattr(stream, "buffer"):
        stream.buffer.write(data)
        stream.buffer.flush()
        return
    stream.write(text + "\n")
    stream.flush()


def serve(stdin: Any = None, stdout: Any = None) -> int:
    """Newline-delimited JSON loop. Returns a process exit code.

    Systems opened during the loop are cached per scope and closed when the
    loop ends, however it ends (EOF, ``__quit__``, fatal error)."""
    global _SERVE_SYSTEMS
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    _SERVE_SYSTEMS = {}
    try:
        return _serve_loop(stdin, stdout)
    finally:
        systems, _SERVE_SYSTEMS = _SERVE_SYSTEMS, None
        assert systems is not None
        for memory in systems.values():
            try:
                memory.close()
            except Exception:  # noqa: BLE001 - teardown must not mask the cause
                pass


def _serve_loop(stdin: Any, stdout: Any) -> int:
    while True:
        line = _read_line(stdin).strip()
        if not line:
            break  # EOF; an empty line is not a request
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            response = {"id": None, "ok": False, "error": {"code": "bad_json", "message": str(exc)}}
        else:
            if not isinstance(request, dict):
                response = {"id": None, "ok": False, "error": {"code": "bad_request", "message": "request must be an object"}}
            elif request.get("command") == "__quit__":
                return 0
            else:
                # `handle` normally converts MemoryError into an error reply,
                # but anything it does not catch (a path a payload points at,
                # a permission failure, an unexpected internal bug) would escape
                # this loop and end the process, leaving every later request
                # unanswered. Answer with an error instead and keep serving.
                try:
                    response = handle(request)
                except Exception as exc:  # noqa: BLE001 - last-resort guard
                    response = {
                        "id": request.get("id"),
                        "ok": False,
                        "error": {"code": "internal", "message": f"{type(exc).__name__}: {exc}"},
                    }
        text = json.dumps(response, ensure_ascii=False)
        if len(text) > MAX_RESPONSE_CHARS:
            text = json.dumps(
                {
                    "id": response.get("id"),
                    "ok": False,
                    "error": {
                        "code": "response_too_large",
                        "message": f"response exceeded {MAX_RESPONSE_CHARS} characters; narrow the request",
                    },
                },
                ensure_ascii=False,
            )
        _write_line(stdout, text)
    return 0


def run_cli(argv: list[str]) -> int:
    """``python -m memory_system <command> '<json>'`` (one-shot) or ``--serve``."""
    args = list(argv)
    if args and args[0] == "--serve":
        return serve()
    if not args:
        _write_line(sys.stdout, json.dumps({"commands": commands(), "version": BRIDGE_VERSION}, ensure_ascii=False))
        return 0
    if args[0] in ("--list", "list"):
        _write_line(sys.stdout, json.dumps({"commands": commands(), "version": BRIDGE_VERSION}, ensure_ascii=False))
        return 0
    name = args[0]
    if len(args) > 1:
        raw = args[1]
    else:
        # One-shot mode: the payload is the whole stdin, also decoded as UTF-8.
        raw = _read_line(sys.stdin)
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        response = {"id": None, "ok": False, "error": {"code": "bad_json", "message": str(exc)}}
    else:
        if not isinstance(payload, dict):
            response = {"id": None, "ok": False, "error": {"code": "bad_request", "message": "payload must be an object"}}
        else:
            response = handle({"id": "cli", "command": name, "payload": payload})
    _write_line(sys.stdout, json.dumps(response, ensure_ascii=False))
    return 0 if response.get("ok") else 1