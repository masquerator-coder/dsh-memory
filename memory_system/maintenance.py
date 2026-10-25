"""Background maintenance: the *offline* half of the design.

Nothing here runs on the request path. Each task is idempotent, bounded, and
safe to run concurrently with reads (one SQLite writer at a time is enforced by
the store's transaction lock).

Tasks and their cadence (``MaintenanceConfig``):

* ``decay``          — recompute L2 retention states
* ``consolidate``    — mine trajectories into candidate skills
* ``communities``    — refresh L3 community summaries
* ``archive_scan``   — retire long-unused skills into the backup archive
* ``promotions``     — book at most N promotion recommendations per day

``run_once`` is driven by a host tick (a cron job, a plugin timer, or a manual
call). The system deliberately does not own a thread: an embedded agent
process should decide its own scheduling policy.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable

from .communities import CommunityIndex
from .config import MaintenanceConfig, MemoryConfig
from .governance import PromotionService, SkillArchive
from .l2 import EpisodicMemory
from .maturity import TrajectoryStore
from .skills import SkillRegistry
from .storage import Store, json_dumps, to_iso, utcnow
from .l3 import SemanticMemory


@dataclass(slots=True)
class TaskReport:
    name: str
    ran: bool
    duration_ms: float = 0.0
    detail: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "ran": self.ran,
            "duration_ms": round(self.duration_ms, 2),
            "detail": self.detail,
            "error": self.error,
        }


class Maintenance:
    def __init__(
        self,
        store: Store,
        config: MemoryConfig,
        *,
        episodic: EpisodicMemory,
        semantic: SemanticMemory,
        registry: SkillRegistry,
        trajectories: TrajectoryStore,
        communities: CommunityIndex,
        archive: SkillArchive,
        promotions: PromotionService,
    ) -> None:
        self.store = store
        self.config = config
        self.cfg: MaintenanceConfig = config.maintenance
        self.episodic = episodic
        self.semantic = semantic
        self.registry = registry
        self.trajectories = trajectories
        self.communities = communities
        self.archive = archive
        self.promotions = promotions

    # ── schedule ────────────────────────────────────────────────────────
    def _last_run(self, name: str) -> float:
        raw = self.store.get_meta(f"maint:{name}:at")
        try:
            return float(raw) if raw else 0.0
        except ValueError:
            return 0.0

    def _mark_run(self, name: str) -> None:
        self.store.set_meta(f"maint:{name}:at", str(time.time()))

    def due(self) -> list[str]:
        now = time.time()
        schedule = {
            "decay": self.cfg.decay_interval_s,
            "consolidate": self.cfg.consolidation_interval_s,
            "communities": self.cfg.community_interval_s,
            "archive_scan": self.cfg.archive_scan_interval_s,
            "promotions": self.cfg.promotion_scan_interval_s,
        }
        return [name for name, interval in schedule.items() if now - self._last_run(name) >= interval]

    # ── entry point ─────────────────────────────────────────────────────
    def run_once(
        self,
        *,
        project_ids: list[str] | None = None,
        tasks: list[str] | None = None,
        force: bool = False,
    ) -> list[TaskReport]:
        """Run the due tasks (or the named ones; ``force`` ignores cadence)."""
        reports: list[TaskReport] = []
        handlers: dict[str, Callable[..., dict[str, Any]]] = {
            "decay": self._decay,
            "consolidate": lambda **kw: self._consolidate(project_ids=project_ids),
            "communities": lambda **kw: self._communities(project_ids=project_ids),
            "archive_scan": lambda **kw: self._archive_scan(project_ids=project_ids),
            "promotions": lambda **kw: self._promotions(),
        }
        # ``force`` has to widen the candidate set, not just the guard below:
        # deriving ``wanted`` from ``due()`` first made a forced run on a fresh
        # database a no-op (nothing was due yet), which is the opposite of what
        # every caller asking for ``force=True`` means.
        if tasks:
            wanted = list(tasks)
        elif force:
            wanted = list(handlers)
        else:
            wanted = self.due()
        for name in wanted:
            handler = handlers.get(name)
            if handler is None:
                continue
            if not force and name not in self.due():
                reports.append(TaskReport(name=name, ran=False, detail={"reason": "not_due"}))
                continue
            started = time.perf_counter()
            try:
                detail = handler()
                self._mark_run(name)
                reports.append(
                    TaskReport(
                        name=name,
                        ran=True,
                        duration_ms=(time.perf_counter() - started) * 1000,
                        detail=detail,
                    )
                )
            except Exception as exc:  # noqa: BLE001 - maintenance must not crash the host
                reports.append(
                    TaskReport(
                        name=name,
                        ran=False,
                        duration_ms=(time.perf_counter() - started) * 1000,
                        error=f"{type(exc).__name__}: {exc}",
                    )
                )
                self.store.execute(
                    "INSERT INTO events(event_id, kind, layer, project_id, detail, created_at) "
                    "VALUES (lower(hex(randomblob(8))), 'maintenance.failed', ?, NULL, ?, ?)",
                    (name, json_dumps({"error": str(exc)}), to_iso(utcnow())),
                )
        return reports

    # ── tasks ───────────────────────────────────────────────────────────
    def _decay(self) -> dict[str, Any]:
        return self.episodic.refresh_states(limit=self.config.l2.candidate_limit * 200)

    def _consolidate(self, *, project_ids: list[str] | None) -> dict[str, Any]:
        projects = project_ids or self._project_ids_with_trajectories()
        drafted: list[dict[str, Any]] = []
        for project_id in projects:
            drafted.extend(self.trajectories.mature(project_id))
        created = [d for d in drafted if d.get("skill_id")]
        return {"projects": len(projects), "drafted": len(created), "results": drafted[:20]}

    def _communities(self, *, project_ids: list[str] | None) -> dict[str, Any]:
        projects = project_ids or [
            r["project_id"] for r in self.store.query("SELECT DISTINCT project_id FROM l3_entities")
        ]
        rebuilt = {}
        for project_id in projects:
            rebuilt[project_id] = len(self.communities.rebuild(project_id))
        return {"projects": len(projects), "communities": rebuilt}

    def _archive_scan(self, *, project_ids: list[str] | None) -> dict[str, Any]:
        """Retire skills that have gone unused past the window (design §6.3)."""
        from .storage import iso_ago

        cutoff = iso_ago(days=self.registry.cfg.retire_unused_days)
        rows = self.store.query(
            "SELECT skill_id FROM l4_skills s WHERE status='active' AND ("
            "  NOT EXISTS (SELECT 1 FROM l4_runs r WHERE r.skill_id = s.skill_id) "
            "  OR (SELECT max(r.started_at) FROM l4_runs r WHERE r.skill_id = s.skill_id) < ?"
            ") AND updated_at < ?",
            (cutoff, cutoff),
        )
        archived = 0
        for row in rows:
            skill_id = row["skill_id"]
            try:
                skill = self.registry.get(skill_id)
            except Exception:  # noqa: BLE001
                continue
            # Snapshot and retire are one act. Committing the snapshot first
            # meant a failed retire left the skill live *and* an archive copy
            # of it, which the next scan snapshotted again. One transaction per
            # skill keeps the two in step without holding the lock for the
            # whole batch.
            with self.store.transaction():
                self.archive.snapshot(skill, status="active")
                self.registry.retire(skill_id, reason="unused_past_window")
            archived += 1
        return {"archived": archived}

    def _promotions(self) -> dict[str, Any]:
        proposals = self.promotions.propose()
        expired = self.promotions.expire_old()
        return {
            "proposed": len(proposals),
            "ids": [p.promotion_id for p in proposals],
            "expired": expired,
        }

    def _project_ids_with_trajectories(self) -> list[str]:
        return [
            r["project_id"]
            for r in self.store.query(
                "SELECT DISTINCT project_id FROM l4_trajectories WHERE derived_skill IS NULL"
            )
        ]

    def status(self) -> dict[str, Any]:
        return {
            "due": self.due(),
            "last_run": {
                name: self._last_run(name)
                for name in ("decay", "consolidate", "communities", "archive_scan", "promotions")
            },
        }