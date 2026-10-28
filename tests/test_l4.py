"""L4: scopes, matching, budget, maturity, archive, promotion."""

from __future__ import annotations

import pytest

from memory_system import (
    Disclosure,
    MemorySystem,
    SkillContext,
    SkillDefinition,
    Step,
    TrajectoryStep,
)
from memory_system import project_skills
from memory_system.errors import ValidationError
from memory_system.l4 import BudgetPlanner, ScopeView, render_index_line


def make_definition(**overrides) -> SkillDefinition:
    base = dict(
        title="依赖升级流程",
        description="升级依赖并验证",
        when_to_use="需要升级依赖时",
        intent_labels=["dependency-upgrade"],
        triggers=["升级依赖", "upgrade deps"],
        requires_tools=["run_terminal"],
        steps=[Step(action="检查依赖图", tool="run_terminal"),
               Step(action="升级锁定文件", tool="run_terminal"),
               Step(action="运行全量测试", tool="run_terminal")],
        success_criteria="全量测试通过",
    )
    base.update(overrides)
    return SkillDefinition(**base)


# ── scope algebra ───────────────────────────────────────────────────────


def test_global_scopes_are_file_backed(memory: MemorySystem, project: str):
    """org/sys rows are gone: the store only holds project-scope skills."""
    memory.ensure_project("proj-b", org_id="acme")
    memory.add_skill(project_id=project, definition=make_definition(), name="proj-skill")
    for scope_kind, ns in (("org", "user"), ("sys", "sys")):
        with pytest.raises(ValidationError, match="file-backed"):
            memory.skills.create(
                view=memory.view(project),
                definition=make_definition(),
                name=f"{scope_kind}-skill",
                scope_kind=scope_kind,
                ns=ns,
                status="active",
            )
    assert {s.name for s in memory.skills.visible(memory.view(project))} == {"proj-skill"}
    assert "proj-skill" not in {s.name for s in memory.skills.visible(memory.view("proj-b"))}
    assert memory.store.scalar(
        "SELECT count(*) FROM l4_skills WHERE scope_kind IN ('org', 'sys')"
    ) == 0


def test_global_bundles_are_not_visible_rows(memory: MemorySystem, project: str):
    """A global skill is a SKILL.md bundle, not a row in the visibility graph."""
    bundle = project_skills.create_at(
        project_skills.global_skill_root(),
        make_definition(title="Global 技能"),
        name="global-skill",
        scope="global",
    )
    assert bundle.path.is_file()
    assert bundle.scope == "global"
    assert "global-skill" not in {s.name for s in memory.skills.visible(memory.view(project))}
    assert memory.store.scalar(
        "SELECT count(*) FROM l4_skills WHERE scope_kind IN ('org', 'sys')"
    ) == 0


# ── validation and capacity ─────────────────────────────────────────────


def test_hard_enforcement_requires_success_criteria(memory: MemorySystem, project: str):
    with pytest.raises(ValidationError):
        memory.add_skill(project_id=project,
                         definition=make_definition(enforcement="hard", success_criteria=None),
                         name="bad")


def test_missing_steps_rejected(memory: MemorySystem, project: str):
    with pytest.raises(ValidationError):
        memory.add_skill(project_id=project, definition=make_definition(steps=[]), name="empty")


def test_capacity_ceiling_raises(memory: MemorySystem, project: str):
    from memory_system.errors import MemoryError

    memory.config.l4.max_active_per_project = 2
    memory.skills.cfg.max_active_per_project = 2
    memory.add_skill(project_id=project, definition=make_definition(), name="one")
    memory.add_skill(project_id=project, definition=make_definition(), name="two")
    with pytest.raises(MemoryError):
        memory.add_skill(project_id=project, definition=make_definition(), name="three")


# ── matching ────────────────────────────────────────────────────────────


def test_trigger_match(memory: MemorySystem, project: str):
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    matches = memory.skills.match(
        view=memory.view(project),
        user_text="帮我升级依赖",
        context=SkillContext(tools=frozenset({"run_terminal"})),
    )
    assert matches and matches[0].skill.name == "dep-upgrade"
    assert "trigger" in matches[0].reasons


def test_missing_prerequisite_demotes(memory: MemorySystem, project: str):
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    with_tool = memory.skills.match(
        view=memory.view(project), user_text="升级依赖", context=SkillContext(tools=frozenset({"run_terminal"}))
    )
    without = memory.skills.match(
        view=memory.view(project), user_text="升级依赖", context=SkillContext(tools=frozenset())
    )
    assert with_tool[0].score > (without[0].score if without else 0.0)


def test_irrelevant_query_matches_nothing(memory: MemorySystem, project: str):
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    matches = memory.skills.match(
        view=memory.view(project), user_text="what is the weather", context=SkillContext(tools=frozenset())
    )
    assert matches == []


# ── attention budget ────────────────────────────────────────────────────


def test_budget_never_exceeded(memory: MemorySystem, project: str):
    for i in range(60):
        memory.add_skill(project_id=project, definition=make_definition(title=f"技能 {i}"), name=f"skill-{i}")
    disclosure = memory.prepare_turn(project_id=project, user_text="升级依赖", available_tools=["run_terminal"])
    assert disclosure.tokens_total <= memory.config.l4.turn_budget_tokens
    assert disclosure.dropped_index or len(disclosure.index_lines) < 60


def test_index_line_is_single_line(memory: MemorySystem, project: str):
    skill = memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")["skill"]
    line = render_index_line(memory.skills.get(skill["skill_id"]))
    assert "\n" not in line
    assert "检查依赖图" not in line  # no steps leak into level 1


def test_planner_enforces_turn_ceiling():
    planner = BudgetPlanner(index=100000, detail=100000, definition=100000, turn=30)
    planner.index_budget = planner.detail_budget = 100000


# ── maturity ────────────────────────────────────────────────────────────


def capture_runs(memory: MemorySystem, project: str, n: int = 4, sessions: int = 2, consistent: bool = True):
    base = [
        TrajectoryStep(action="读取失败测试", tool="read"),
        TrajectoryStep(action="运行单个测试定位", tool="run_terminal"),
        TrajectoryStep(action="修改实现文件", tool="edit"),
        TrajectoryStep(action="重跑测试确认通过", tool="run_terminal"),
    ]
    variant = [
        TrajectoryStep(action="读取失败测试", tool="read"),
        TrajectoryStep(action="直接改代码", tool="edit"),
        TrajectoryStep(action="运行全部测试", tool="run_terminal"),
        TrajectoryStep(action="再改一次", tool="edit"),
    ]
    for i in range(n):
        steps = base if (consistent or i % 2 == 0) else variant
        memory.capture_trajectory(
            project_id=project,
            steps=steps,
            session_key=f"s{i % sessions}",
            intent_label="fix failing test",
            preconditions={"tools": ["read", "edit", "run_terminal"]},
        )


def test_single_step_trace_is_not_a_procedure(memory: MemorySystem, project: str):
    assert memory.capture_trajectory(project_id=project, steps=[TrajectoryStep(action="ls", tool="ls")]) is None


def test_maturity_requires_multiple_sessions(memory: MemorySystem, project: str):
    capture_runs(memory, project, n=4, sessions=1)
    evidences = memory.trajectories.evaluate(project)
    assert evidences and not evidences[0].mature
    assert "insufficient_sessions" in evidences[0].failed_checks


def test_maturity_requires_successes(memory: MemorySystem, project: str):
    capture_runs(memory, project, n=2, sessions=2)
    evidences = memory.trajectories.evaluate(project)
    assert "insufficient_successes" in evidences[0].failed_checks



def test_step_consistency_gate_notices_drift(memory: MemorySystem, project: str):
    """Consistency is graded across variants of one signature: the same
    mutating tail with wildly different read-only detours must make the
    step_consistency gate fire instead of answer 1.0 to itself."""
    heavy = [TrajectoryStep(action="翻找上下文", tool="read")] * 9 + [
        TrajectoryStep(action="修改实现文件", tool="edit"),
        TrajectoryStep(action="重跑测试", tool="run_terminal"),
    ]
    light = [
        TrajectoryStep(action="翻找上下文", tool="read"),
        TrajectoryStep(action="修改实现文件", tool="edit"),
        TrajectoryStep(action="重跑测试", tool="run_terminal"),
    ]
    for _ in range(3):
        memory.capture_trajectory(project_id=project, steps=heavy, session_key="s0",
                                  intent_label="fix failing test")
    for _ in range(3):
        memory.capture_trajectory(project_id=project, steps=light, session_key="s1",
                                  intent_label="fix failing test")
    evidences = memory.trajectories.evaluate(project)
    # One graded procedure (same mutating tail -> same signature), visibly
    # inconsistent across variants.
    assert len(evidences) == 1, "variants of one signature grade together"
    assert evidences[0].step_consistency < memory.trajectories.cfg.maturity_min_step_consistency
    assert "step_consistency" in evidences[0].failed_checks


def test_mature_trajectory_becomes_candidate(memory: MemorySystem, project: str):
    capture_runs(memory, project, n=4, sessions=2)
    results = memory.trajectories.mature(project)
    created = [r for r in results if r.get("skill_id")]
    assert created
    skill = memory.skills.get(created[0]["skill_id"])
    assert skill.status == "candidate"
    assert skill.unaudited is True
    assert skill.definition.steps


def test_candidate_not_visible_until_accepted(memory: MemorySystem, project: str):
    capture_runs(memory, project, n=4, sessions=2)
    memory.trajectories.mature(project)
    assert memory.skills.visible(memory.view(project)) == []
    pending = memory.review_candidates(project_id=project)
    memory.accept_candidate(project_id=project, skill_id=pending[0]["skill_id"])
    assert len(memory.skills.visible(memory.view(project))) == 1


def test_run_outcomes_drive_auto_retire(memory: MemorySystem, project: str):
    skill = memory.add_skill(project_id=project, definition=make_definition(), name="flaky")["skill"]
    for _ in range(10):
        memory.record_skill_run(project_id=project, skill=skill["skill_id"], outcome="failure", success=False)
    assert memory.skills.get(skill["skill_id"]).status == "retired"


def test_success_rate_is_smoothed(memory: MemorySystem, project: str):
    skill = memory.add_skill(project_id=project, definition=make_definition(), name="new")["skill"]
    assert memory.skills.success_rate(skill["skill_id"]) == 0.5


# ── archive ─────────────────────────────────────────────────────────────


def test_archive_capture_and_search(memory: MemorySystem, project: str):
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    assert memory.archive.stats().get("active", 0) >= 1
    hits = memory.archive.search(make_definition().search_text())
    assert hits and hits[0].similarity > 0.95


def test_archive_never_enters_matching(memory: MemorySystem, project: str):
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    memory.archive_project(project)
    memory.skills.retire(memory.skills.find("dep-upgrade", memory.view(project)).skill_id)
    matches = memory.skills.match(
        view=memory.view(project), user_text="升级依赖", context=SkillContext(tools=frozenset({"run_terminal"}))
    )
    assert matches == []


def test_reference_reuse_across_projects(memory: MemorySystem, project: str):
    memory.ensure_project("proj-b", org_id="acme")
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    result = memory.add_skill(project_id="proj-b", definition=make_definition(), name="dep-upgrade")
    assert result["archive_verdict"] == "reference"


def test_archive_survives_project_removal(memory: MemorySystem, project: str):
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    report = memory.archive_project(project)
    assert report["snapshot_archive_ids"]
    assert memory.archive.stats().get("orphaned", 0) >= 1


def test_archive_scan_is_atomic_per_skill(memory: MemorySystem, project: str, monkeypatch):
    """Snapshot and retire are one act.

    The snapshot used to commit first, so a failing retire left the skill live
    *and* an archive copy of it; the next scan then snapshotted it again.
    """
    from memory_system.storage import iso_ago

    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    skill = memory.skills.find("dep-upgrade", memory.view(project))
    memory.store.execute(
        "UPDATE l4_skills SET updated_at = ? WHERE skill_id = ?",
        (iso_ago(days=365), skill.skill_id),
    )
    # Drop the snapshot ``add_skill`` took, so the scan's own archive write is
    # observable (the dedup below would otherwise hide it).
    for row in memory.store.query(
        "SELECT archive_id FROM l4_archive WHERE origin_skill_id = ?", (skill.skill_id,)
    ):
        memory.store.execute("DELETE FROM l4_archive WHERE archive_id = ?", (row["archive_id"],))
        memory.store.execute("DELETE FROM l4_archive_fts WHERE archive_id = ?", (row["archive_id"],))

    def boom(*args, **kwargs):
        raise RuntimeError("retire failed")

    monkeypatch.setattr(memory.maintenance.registry, "retire", boom)
    reports = memory.run_maintenance(tasks=["archive_scan"], force=True)
    assert reports[0].error and "retire failed" in reports[0].error

    assert memory.store.scalar(
        "SELECT count(*) FROM l4_archive WHERE origin_skill_id = ?", (skill.skill_id,)
    ) == 0
    assert memory.skills.get(skill.skill_id).status == "active"


def test_snapshot_is_idempotent_for_the_same_archived_version(memory: MemorySystem, project: str):
    """The pool is append-only per version, not per call.

    A retried archive_scan or a second ``archive_project`` used to add an
    identical row plus its vector and FTS entry, and ``search`` then returned
    the same definition several times.
    """
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    skill = memory.skills.find("dep-upgrade", memory.view(project))
    first = memory.archive.snapshot(skill, status="superseded")
    second = memory.archive.snapshot(skill, status="superseded")
    assert first == second
    assert memory.store.scalar(
        "SELECT count(*) FROM l4_archive WHERE origin_skill_id = ? AND status = 'superseded'",
        (skill.skill_id,),
    ) == 1


# ── promotion ───────────────────────────────────────────────────────────


def test_promotion_requires_user_decision(memory: MemorySystem, project: str):
    memory.ensure_project("proj-b", org_id="acme")
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    memory.add_skill(project_id="proj-b", definition=make_definition(), name="dep-upgrade")
    proposals = memory.promotions.propose()
    assert proposals
    root = project_skills.global_skill_root()
    # Nothing moves before a human decides.
    assert project_skills.discover_at(root) == []
    assert memory.store.scalar(
        "SELECT count(*) FROM l4_skills WHERE scope_kind IN ('org', 'sys')"
    ) == 0
    decision = memory.decide_promotion(
        proposals[0].promotion_id, accept=True, project_id=project
    )
    assert decision["skill"]["scope"] == "global"
    # Accepting writes one global bundle, named from the ASCII intent label.
    files = project_skills.discover_at(root)
    assert [s.name for s in files] == ["dependency-upgrade"]
    assert files[0].scope == "global"
    assert files[0].title == "依赖升级流程"
    # The bundle is the source of truth; no global row was created.
    assert memory.store.scalar(
        "SELECT count(*) FROM l4_skills WHERE scope_kind IN ('org', 'sys')"
    ) == 0


def test_rejection_is_remembered(memory: MemorySystem, project: str):
    memory.ensure_project("proj-b", org_id="acme")
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    memory.add_skill(project_id="proj-b", definition=make_definition(), name="dep-upgrade")
    proposals = memory.promotions.propose()
    memory.decide_promotion(proposals[0].promotion_id, accept=False, project_id=project, note="不需要")
    assert memory.promotions.propose() == []
    assert project_skills.discover_at(project_skills.global_skill_root()) == []


def test_rejecting_a_decided_promotion_is_refused(memory: MemorySystem, project: str):
    """A decision is history, not a mutable slot.

    ``reject`` used to UPDATE unconditionally, so rejecting an accepted
    promotion flipped its status to 'rejected' while the global skill it had
    created stayed live -- the record then contradicted the files.
    """
    memory.ensure_project("proj-b", org_id="acme")
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    memory.add_skill(project_id="proj-b", definition=make_definition(), name="dep-upgrade")
    promotion_id = memory.promotions.propose()[0].promotion_id
    memory.decide_promotion(promotion_id, accept=True, project_id=project)

    with pytest.raises(ValidationError):
        memory.promotions.reject(promotion_id, note="too late")
    assert memory.promotions.get(promotion_id).status == "accepted"
    assert len(project_skills.discover_at(project_skills.global_skill_root())) == 1


def test_accept_reuses_a_bundle_written_before_a_failed_decision(memory: MemorySystem, project: str):
    """Accepting is retryable: the file is written first, then the decision.

    A crash between the two leaves the bundle behind with the promotion still
    pending. Retrying must adopt that identical bundle instead of failing with
    "already exists" and leaving the promotion stuck forever.
    """
    memory.ensure_project("proj-b", org_id="acme")
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    memory.add_skill(project_id="proj-b", definition=make_definition(), name="dep-upgrade")
    promotion = memory.promotions.propose()[0]
    root = project_skills.global_skill_root()
    written = project_skills.create_at(
        root, promotion.suggestion, name="dependency-upgrade", scope="global"
    )

    skill = memory.promotions.accept(promotion.promotion_id, view=memory.view(project))

    assert skill.qualified_name == "user:global:dependency-upgrade"
    assert memory.promotions.get(promotion.promotion_id).status == "accepted"
    assert len(project_skills.discover_at(root)) == 1
    assert project_skills.load_at(root, written.name).title == "依赖升级流程"


def test_accept_refuses_a_conflicting_global_bundle(memory: MemorySystem, project: str):
    """A same-named bundle with different content is a collision, not a retry."""
    memory.ensure_project("proj-b", org_id="acme")
    memory.add_skill(project_id=project, definition=make_definition(), name="dep-upgrade")
    memory.add_skill(project_id="proj-b", definition=make_definition(), name="dep-upgrade")
    promotion = memory.promotions.propose()[0]
    root = project_skills.global_skill_root()
    project_skills.create_at(
        root,
        make_definition(title="别的技能", description="完全不同的内容"),
        name="dependency-upgrade",
        scope="global",
    )

    with pytest.raises(ValidationError, match="different content"):
        memory.promotions.accept(promotion.promotion_id, view=memory.view(project))
    assert memory.promotions.get(promotion.promotion_id).status == "pending"


def test_promotion_daily_cap(memory: MemorySystem, project: str):
    memory.ensure_project("proj-b", org_id="acme")
    memory.config.l4.promotion_max_daily = 1
    memory.promotions.cfg.promotion_max_daily = 1
    memory.add_skill(project_id=project, definition=make_definition(), name="a-skill")
    memory.add_skill(project_id="proj-b", definition=make_definition(), name="a-skill")
    memory.add_skill(project_id=project, definition=make_definition(title="other", description="另一件事"), name="b-skill")
    memory.add_skill(project_id="proj-b", definition=make_definition(title="other", description="另一件事"), name="b-skill")
    assert len(memory.promotions.propose()) == 1