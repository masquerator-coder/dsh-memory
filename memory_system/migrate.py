"""Migrating a database: embedding-model rebuilds, and moving project skills out.

Vectors from two models live in incomparable spaces, so a model change is a
*rebuild*, not a config edit: every stored vector must be recomputed in the new
space. This module performs that rebuild in place, and refuses when the new
dimension differs from the on-disk one unless the caller explicitly allows a
destructive re-dimension (vec0 tables are fixed-width).

It also owns the one-way door for procedural memory: project-scope skills used
to be rows in ``l4_skills`` and are now bundles in the checkout
(``.agents/skills``), so :func:`export_project_skills` writes the bundle, moves
the run history into the ledger beside the memory home, and only then removes
the row — in that order, because a half-finished export must still be able to
keep the row.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from .embedding import EmbeddingProvider
from .errors import MemoryError, ProviderError, ValidationError
from .storage import Store, VEC_TABLES, json_loads


@dataclass(slots=True)
class Reprogress:
    """Progress of a re-embedding run."""

    kind: str
    done: int = 0
    total: int = 0
    error: str | None = None


@dataclass(slots=True)
class ReembedReport:
    previous_fingerprint: str | None = None
    new_fingerprint: str = ""
    previous_dim: int | None = None
    new_dim: int = 0
    reembedded: dict[str, int] = field(default_factory=dict)
    dropped: dict[str, int] = field(default_factory=dict)
    redimensioned: bool = False
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "previous_fingerprint": self.previous_fingerprint,
            "new_fingerprint": self.new_fingerprint,
            "previous_dim": self.previous_dim,
            "new_dim": self.new_dim,
            "reembedded": self.reembedded,
            "dropped": self.dropped,
            "redimensioned": self.redimensioned,
            "errors": self.errors,
        }


def _l2_text(row: sqlite3.Row) -> str:
    return row["summary"]


def _l3_entity_text(row: sqlite3.Row) -> str:
    from .l3 import SemanticMemory

    aliases = json_loads(row["aliases"], []) or []
    return SemanticMemory._entity_text(row["name"], row["entity_type"], aliases)


def _l4_skill_text(row: sqlite3.Row) -> str:
    from .l4 import SkillDefinition

    definition = json_loads(row["definition"], None)
    if definition is None:  # corrupt slot — keep the raw dump rather than skip
        return _text_of(row["definition"])
    return SkillDefinition.from_dict(definition).search_text()


def _l4_archive_text(row: sqlite3.Row) -> str:
    text = row["search_text"]
    if text:
        return text
    # Legacy rows predating the search_text column: rebuild it from the
    # structured definition, exactly what snapshot() did at write time.
    from .l4 import SkillDefinition

    definition = json_loads(row["definition"], None)
    if definition is None:
        return ""
    return SkillDefinition.from_dict(definition).search_text()


# (kind, source table, text source columns, rowid column, text builder).
#
# The builders above must produce EXACTLY the text the layer's write path
# embeds, so a re-embedded vector is indistinguishable from a freshly
# written one — otherwise recall compares a query against a different text
# than the row actually represents. These were SQL expressions once, which
# could not honor the writers: l3's write path folds entity_type and the
# *parsed* alias list into the text (`SemanticMemory._entity_text`), not
# the raw JSON-dumped aliases column; l4_skill's is
# `SkillDefinition.search_text()` over the structured definition, not the
# dumped JSON; and l4_archive rows already carry the exact embedded text
# in their own `search_text` column.
#
# l3/l4 imports stay inside the builders to avoid an import cycle
# (system -> migrate lazily too).
_SOURCES = [
    ("l2", "l2_episodes", "summary", "ord", _l2_text),
    ("l3_entity", "l3_entities", "name, type AS entity_type, aliases", "ord", _l3_entity_text),
    ("l4_skill", "l4_skills", "definition", "ord", _l4_skill_text),
    ("l4_archive", "l4_archive", "search_text, definition", "ord", _l4_archive_text),
]


def needs_reembed(store: Store, provider: EmbeddingProvider) -> bool:
    """True when stored vectors were made by a different provider identity."""
    stored = store.get_meta("embedding_fingerprint")
    if not stored:
        return False
    return stored != provider.fingerprint


def reembed(
    store: Store,
    provider: EmbeddingProvider,
    *,
    allow_redimension: bool = False,
    batch: int = 256,
    progress: Callable[[Reprogress], None] | None = None,
) -> ReembedReport:
    """Recompute every stored vector with ``provider``.

    ``allow_redimension=True`` destroys the vector index and rebuilds it at the
    new width (rows are re-embedded, not lost). Without it, a dimension change
    raises: on-disk vec0 tables are fixed-width and silently mixing widths
    would corrupt similarity rather than fail loudly.
    """
    report = ReembedReport(
        previous_fingerprint=store.get_meta("embedding_fingerprint"),
        new_fingerprint=provider.fingerprint,
        previous_dim=store.vectors.dim,
        new_dim=provider.dim,
    )
    if provider.dim != store.vectors.dim:
        if not allow_redimension:
            raise MemoryError(
                f"database holds {store.vectors.dim}-dim vectors, new model produces "
                f"{provider.dim}; pass allow_redimension=True to rebuild the index"
            )
        _rebuild_vector_tables(store, provider.dim)
        report.redimensioned = True

    for kind, table, cols, rowid_col, build_text in _SOURCES:
        rows = store.query(
            f"SELECT {rowid_col} AS rid, {cols} FROM {table}"
        )
        done = 0
        for start in range(0, len(rows), batch):
            chunk = rows[start : start + batch]
            texts = [_text_of(build_text(r)) for r in chunk]
            try:
                vectors = provider.embed(texts)
            except ProviderError as exc:
                report.errors.append(f"{kind}: {exc}")
                break
            with store.transaction():
                for row, vector in zip(chunk, vectors):
                    store.vectors.upsert(kind, int(row["rid"]), vector)
            done += len(chunk)
            if progress is not None:
                progress(Reprogress(kind=kind, done=done, total=len(rows)))
        report.reembedded[kind] = done

    # The fingerprint is the *claim* that every stored vector lives in the new
    # model's space. After a partial failure that claim is false on disk, and
    # writing it would silence `needs_reembed()` forever — the exact silent
    # similarity distortion DESIGN §6.1 warns about. Leave it unclaimed so a
    # retry finishes the job; the dim stays claimed because the physical index
    # was rebuilt (or unchanged), which VectorIndex reflects one way or the other.
    if not report.errors:
        store.set_meta("embedding_fingerprint", provider.fingerprint)
    store.set_meta("embedding_dim", str(provider.dim))
    return report


def _text_of(value: object) -> str:
    return value if isinstance(value, str) else ("" if value is None else str(value))


def _rebuild_vector_tables(store: Store, dim: int) -> None:
    """Drop and recreate every vector table at a new width."""
    from .vectors import VectorIndex

    backend = store.vectors.backend
    with store.transaction():
        for table in VEC_TABLES.values():
            store.execute(f"DROP TABLE IF EXISTS {table}")
        store.execute("DELETE FROM meta WHERE key = 'embedding_dim'")
    store.vectors = VectorIndex(store.conn, dim, enabled=backend == "sqlite-vec")


# ══ project skills: store rows → checkout bundles ═══════════════════════


@dataclass(slots=True)
class ExportedSkill:
    """One project-scope row considered by the export."""

    skill_id: str
    name: str | None = None
    path: str | None = None
    runs_imported: int = 0
    deleted: bool = False
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "skill_id": self.skill_id,
            "name": self.name,
            "path": self.path,
            "runs_imported": self.runs_imported,
            "deleted": self.deleted,
            "reason": self.reason,
        }


@dataclass(slots=True)
class ExportReport:
    """What the export did — and, on ``dry_run``, what it would do."""

    project_root: str = ""
    dry_run: bool = False
    items: list[ExportedSkill] = field(default_factory=list)

    @property
    def exported(self) -> int:
        return sum(1 for item in self.items if item.deleted)

    def to_dict(self) -> dict[str, Any]:
        return {
            "project_root": self.project_root,
            "dry_run": self.dry_run,
            "exported": self.exported,
            "left_alone": sum(1 for item in self.items if not item.deleted),
            "items": [item.to_dict() for item in self.items],
        }


def export_project_skills(
    memory: Any,
    project_root: Path | str,
    *,
    names: Mapping[str, str] | None = None,
    dry_run: bool = False,
    memory_home: Path | str | None = None,
) -> ExportReport:
    """Move project-scope skills out of the store into ``.agents/skills``.

    Each active project row becomes ``<projectRoot>/.agents/skills/<name>/
    SKILL.md``, its run history becomes lines in ``<memoryHome>/l4_runs``, and
    only after both succeed are the row, its FTS entry, its vector and its run
    rows removed.

    ``names`` maps a row to the kebab-case name its bundle must have, keyed by
    ``skill_id``, qualified name or title. A Chinese title cannot be turned
    into a legal name mechanically, and inventing one would rename a skill
    behind its owner's back, so an unmapped row is reported and left in place
    rather than guessed at.
    """
    from . import project_skills
    from .l4 import SkillDefinition

    report = ExportReport(project_root=str(project_root), dry_run=dry_run)
    # The ledger lives beside the database. An in-memory store has no such
    # directory, so its runs are simply not carried over — the caller passes
    # `memory_home` when it knows where the file-based store lives.
    db_path = str(memory.config.db_path)
    if memory_home is not None:
        home: Path | None = Path(memory_home)
    else:
        home = None if db_path in ("", ":memory:") else Path(db_path).parent
    mapping = dict(names or {})
    rows = memory.store.query("SELECT * FROM l4_skills WHERE scope_kind = 'project' ORDER BY ord")
    for row in rows:
        item = ExportedSkill(skill_id=str(row["skill_id"]))
        raw = json_loads(row["definition"], None)
        name = (
            mapping.get(item.skill_id)
            or mapping.get(str(row["qualified_name"]))
            or mapping.get(str(row["title"]))
        )
        if not isinstance(raw, dict):
            item.reason = "definition is not a JSON object"
            report.items.append(item)
            continue
        if not name:
            item.reason = "name required: pass names={skill_id: kebab-case-name}"
            report.items.append(item)
            continue
        item.name = str(name)
        item.path = str(project_skills.skill_root(project_root) / item.name / "SKILL.md")
        if dry_run:
            item.reason = "dry run"
            report.items.append(item)
            continue
        try:
            project_skills.create(project_root, SkillDefinition.from_dict(raw), name=item.name)
        except (ValidationError, MemoryError) as exc:
            item.reason = str(exc)
            report.items.append(item)
            continue

        run_rows = memory.store.query("SELECT * FROM l4_runs WHERE skill_id = ?", (item.skill_id,))
        imported = 0
        if home is not None and run_rows:
            stats = project_skills.import_runs(
                home,
                str(row["scope_ref"] or ""),
                item.name,
                [
                    {
                        "run_id": run["run_id"],
                        "outcome": run["outcome"],
                        "success": bool(run["success"]),
                        "error": run["error"],
                        "deviation": run["deviation"],
                        "at": run["started_at"],
                    }
                    for run in run_rows
                ],
            )
            imported = int(stats.get("imported", 0))
        item.runs_imported = imported
        with memory.store.transaction():
            memory.store.execute("DELETE FROM l4_fts WHERE skill_id = ?", (item.skill_id,))
            memory.store.vectors.delete("l4_skill", int(row["ord"]))
            memory.store.execute("DELETE FROM l4_runs WHERE skill_id = ?", (item.skill_id,))
            memory.store.execute("DELETE FROM l4_skills WHERE skill_id = ?", (item.skill_id,))
        item.deleted = True
        report.items.append(item)
    return report
