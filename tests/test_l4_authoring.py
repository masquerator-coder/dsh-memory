"""L4 authoring: the model saves a procedure as a project-scope skill.

These pin the policy that keeps "let the agent write skills" from turning into
noise: project scope only, near-duplicates fold into the existing skill, and a
ceiling answers with a decision instead of a silent eviction.
"""

from __future__ import annotations

import pytest

from memory_system import MemorySystem, SkillDefinition, Step
from memory_system.errors import ValidationError


def make_definition(**overrides) -> SkillDefinition:
    base = dict(
        title="定位失败的测试",
        description="定位失败测试并验证",
        when_to_use="有测试失败时",
        triggers=["测试失败", "单测失败"],
        requires_tools=["run_terminal"],
        steps=[
            Step(action="运行失败的单个测试", tool="run_terminal"),
            Step(action="修改实现文件", tool="edit"),
            Step(action="重跑测试确认通过", tool="run_terminal"),
        ],
        success_criteria="目标测试通过且相关用例无回归",
    )
    base.update(overrides)
    return SkillDefinition(**base)


# ── the create path ─────────────────────────────────────────────────────


def test_created_skill_is_project_scoped_and_immediately_visible(memory: MemorySystem, project: str):
    result = memory.add_project_skill(project_id=project, definition=make_definition())
    assert result["created"] is True and result["reused"] is False
    skill = memory.skills.get(result["skill"]["skill_id"])
    # The brief: L4 only ever creates project-scope skills from a session.
    assert skill.scope_kind == "project" and skill.scope_ref == project
    assert skill.status == "active"
    # Unaudited is honest bookkeeping: nobody reviewed this procedure.
    assert skill.unaudited is True
    names = {s.name for s in memory.skills.visible(memory.view(project))}
    assert skill.name in names


def test_created_skill_stays_inside_its_project(memory: MemorySystem, project: str):
    memory.ensure_project("proj-b", org_id="acme")
    created = memory.add_project_skill(project_id=project, definition=make_definition())
    other = {s.name for s in memory.skills.visible(memory.view("proj-b"))}
    assert created["skill"]["qualified_name"].rsplit(":", 1)[-1] not in other


def test_identical_procedure_is_reused_instead_of_duplicated(memory: MemorySystem, project: str):
    first = memory.add_project_skill(project_id=project, definition=make_definition())
    second = memory.add_project_skill(
        project_id=project, definition=make_definition(), name="另一个名字"
    )
    assert second["created"] is False and second["reused"] is True
    assert second["skill"]["skill_id"] == first["skill"]["skill_id"]
    assert second["similarity"] >= memory.config.l4.merge_similarity
    assert memory.store.scalar(
        "SELECT count(*) FROM l4_skills WHERE scope_kind = 'project' AND scope_ref = ?", (project,)
    ) == 1


def test_a_different_procedure_is_a_second_skill(memory: MemorySystem, project: str):
    memory.add_project_skill(project_id=project, definition=make_definition())
    other = make_definition(
        title="发布前检查",
        description="发布前的五项检查",
        when_to_use="准备发布时",
        triggers=["发布", "release"],
        steps=[Step(action="运行全量测试", tool="run_terminal"), Step(action="导出变更日志", tool="edit")],
    )
    second = memory.add_project_skill(project_id=project, definition=other)
    assert second["created"] is True
    assert memory.store.scalar(
        "SELECT count(*) FROM l4_skills WHERE scope_kind = 'project' AND scope_ref = ? AND status = 'active'",
        (project,),
    ) == 2


def test_cap_refuses_instead_of_evicting(memory: MemorySystem, project: str):
    """Reaching the ceiling must be a decision, not a silent eviction."""
    memory.add_project_skill(project_id=project, definition=make_definition(), max_active=1)
    with pytest.raises(Exception) as excinfo:
        memory.add_project_skill(
            project_id=project,
            definition=make_definition(
                title="发布前检查",
                description="发布前的五项检查",
                when_to_use="准备发布时",
                triggers=["发布", "release"],
            ),
            max_active=1,
        )
    assert "active 技能" in str(excinfo.value)
    # The first skill is untouched: nothing was retired to make room.
    assert memory.skills.visible(memory.view(project))[0].status == "active"


def test_invalid_definition_is_refused_before_any_write(memory: MemorySystem, project: str):
    with pytest.raises(ValidationError):
        memory.add_project_skill(project_id=project, definition=make_definition(steps=[]))
    assert memory.store.scalar(
        "SELECT count(*) FROM l4_skills WHERE scope_kind = 'project' AND scope_ref = ?", (project,)
    ) == 0


def test_max_active_defaults_to_the_configured_ceiling(memory: MemorySystem, project: str):
    memory.config.l4.max_active_per_project = 2
    memory.skills.cfg.max_active_per_project = 2
    memory.add_project_skill(project_id=project, definition=make_definition())
    memory.add_project_skill(
        project_id=project,
        definition=make_definition(
            title="发布前检查", description="发布前的五项检查", when_to_use="准备发布时", triggers=["发布"]
        ),
    )
    with pytest.raises(Exception):
        memory.add_project_skill(
            project_id=project,
            definition=make_definition(
                title="回滚流程", description="回滚到上一个版本", when_to_use="发布出问题时", triggers=["回滚"]
            ),
        )