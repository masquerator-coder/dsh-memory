"""Bridge commands for L4: project-scope skills from a session.

The wire is where the policy has to hold, because that is the only door the
model has. These pin the three rules the design cannot afford to lose:
project scope only, no near-duplicate creation, and no silent eviction.
"""

from __future__ import annotations

import pytest

from memory_system.bridge import handle
from memory_system.l4 import SkillDefinition

DEFINITION = {
    "title": "定位失败的测试",
    "description": "定位失败测试并验证",
    "when_to_use": "有测试失败时",
    "triggers": ["测试失败"],
    "requires_tools": ["run_terminal"],
    "steps": [
        {"action": "运行失败的单个测试", "tool": "run_terminal"},
        {"action": "修改实现文件", "tool": "edit"},
        {"action": "重跑测试确认通过", "tool": "run_terminal"},
    ],
    "success_criteria": "目标测试通过",
}

OTHER = {
    "title": "发布前检查",
    "description": "发布前的五项检查",
    "when_to_use": "准备发布时",
    "triggers": ["发布", "release"],
    "steps": [{"action": "运行全量测试", "tool": "run_terminal"}, {"action": "导出变更日志", "tool": "edit"}],
}


@pytest.fixture()
def home(tmp_path):
    return str(tmp_path / "memory")


def call(home: str, command: str, **payload) -> dict:
    reply = handle(
        {"id": "t", "command": command, "payload": {"home": home, "project_id": "proj-a", **payload}}
    )
    assert reply["ok"], reply.get("error")
    return reply["result"]


def fail(home: str, command: str, **payload) -> dict:
    reply = handle(
        {"id": "t", "command": command, "payload": {"home": home, "project_id": "proj-a", **payload}}
    )
    assert reply["ok"] is False, reply
    return reply["error"]


# ── create ──────────────────────────────────────────────────────────────


def test_model_authored_skill_is_created_active_and_listed(home):
    created = call(home, "skill.create", model_authored=True, definition=DEFINITION)
    assert created["created"] is True and created["reused"] is False
    assert created["actor"] == "model"
    skill = created["skill"]
    assert skill["scope"] == "project:proj-a"
    assert skill["status"] == "active" and skill["unaudited"] is True

    listed = call(home, "skill.list")
    names = [item["qualified_name"] for item in listed["items"]]
    assert skill["qualified_name"] in names
    # The list carries what a caller needs to choose, not just ids.
    assert listed["items"][0]["steps"]


def test_second_identical_create_reuses_the_first(home):
    first = call(home, "skill.create", model_authored=True, definition=DEFINITION)
    again = call(home, "skill.create", model_authored=True, definition=DEFINITION, name="另一个名字")
    assert again["created"] is False and again["reused"] is True
    assert again["skill"]["skill_id"] == first["skill"]["skill_id"]


def test_org_and_sys_scopes_are_refused(home):
    for scope in ("org", "sys"):
        error = fail(home, "skill.create", model_authored=True, definition=DEFINITION, scope_kind=scope)
        assert error["code"] == "bad_request"
        assert "org/sys promotion stays a user decision" in error["message"]
    assert call(home, "skill.list")["items"] == []


def test_definition_must_be_an_object_with_steps(home):
    assert fail(home, "skill.create", model_authored=True)["code"] == "bad_request"
    assert fail(home, "skill.create", definition=["nope"])["code"] == "bad_request"
    no_steps = {k: v for k, v in DEFINITION.items() if k != "steps"}
    assert fail(home, "skill.create", definition=no_steps)["code"] == "bad_request"


def test_invalid_definition_reports_validation(home):
    too_long = {**DEFINITION, "description": "x" * 40}
    error = fail(home, "skill.create", model_authored=True, definition=too_long)
    assert error["code"] == "validation"
    assert "30 characters" in error["message"]


def test_model_cap_answers_with_a_decision(home):
    call(home, "skill.create", model_authored=True, definition=DEFINITION, max_active=1)
    error = fail(home, "skill.create", model_authored=True, definition=OTHER, max_active=1)
    assert error["code"] == "memory"
    assert "先退役或合并" in error["message"]
    # Nothing was evicted to make room.
    assert len(call(home, "skill.list")["items"]) == 1


def test_user_authored_skill_keeps_the_review_path(home):
    created = call(home, "skill.create", definition=DEFINITION)
    assert created["actor"] == "user"
    assert created["skill"]["status"] == "candidate"
    # A candidate is review material: the model is not offered it as an
    # available procedure, and the list does not pretend it is usable.
    assert call(home, "skill.index")["index"] == []
    assert "candidate" in call(home, "skill.list")["stats"]["by_status"]


# ── read / run / retire ─────────────────────────────────────────────────


def test_index_lines_never_leak_steps(home):
    created = call(home, "skill.create", model_authored=True, definition=DEFINITION)
    index = call(home, "skill.index")["index"]
    assert index, "an active project skill must reach the resident index"
    assert created["skill"]["qualified_name"] in index[0]
    assert "运行失败的单个测试" not in index[0]


def test_index_falls_back_when_no_skill_was_ever_tiered(home):
    """Tiers are refreshed by a background scan the host does not run yet.

    A fresh project therefore has every skill in ``warm``; an index that only
    read the hot tier would stay empty while the skill clearly exists.
    """
    call(home, "skill.create", model_authored=True, definition=DEFINITION)
    assert call(home, "skill.list")["items"][0]["tier"] == "warm"
    assert len(call(home, "skill.index")["index"]) == 1


def test_index_respects_the_attention_budget(home):
    """The fallback lists every visible skill, so it must still fit the budget.

    Without a cut, a project with dozens of skills pushed all of them into the
    system prompt: the hot path is budgeted by ``refresh_tiers``, the fallback
    was not, and the two paths cost wildly different amounts for the same
    question.
    """
    from memory_system import MemoryConfig, MemorySystem
    from memory_system.text import estimate_tokens

    for i in range(30):
        call(
            home,
            "skill.create",
            model_authored=True,
            definition={
                "title": f"流程 {i}",
                "description": f"第 {i} 类的标准流程说明",
                "when_to_use": "需要时",
                "triggers": [f"触发{i}"],
                "steps": [{"action": f"执行第 {i} 步", "tool": "run_terminal"}],
            },
        )

    memory = MemorySystem(MemoryConfig.for_home(home))
    try:
        budget = memory.config.l4.index_budget_tokens
    finally:
        memory.close()

    result = call(home, "skill.index")
    index = result["index"]
    assert index, "the index must not be emptied by the budget"
    assert sum(estimate_tokens(line) for line in index) <= budget
    # The skills that did not fit are counted, not silently vanished.
    assert result["dropped"] > 0
    assert len(index) + result["dropped"] == 30


def test_get_returns_the_full_definition(home):
    call(home, "skill.create", model_authored=True, definition=DEFINITION)
    found = call(home, "skill.get", skill="定位失败的测试")
    assert found["skill"]["qualified_name"].endswith("定位失败的测试")
    assert len(found["definition"]["steps"]) == 3
    assert "修改实现文件" in found["markdown"]
    assert fail(home, "skill.get", skill="不存在的技能")["code"] == "not_found"


def test_run_records_the_outcome(home):
    call(home, "skill.create", model_authored=True, definition=DEFINITION)
    first = call(home, "skill.run", skill="定位失败的测试", outcome="success")
    assert first["success"] is True
    failed = call(home, "skill.run", skill="定位失败的测试", outcome="failure", error="测试仍然失败")
    assert failed["success"] is False
    # Bayesian smoothing: 1 success + 1 failure -> (1+1)/(2+2).
    assert failed["success_rate"] == 0.5


def test_retire_keeps_the_record(home):
    call(home, "skill.create", model_authored=True, definition=DEFINITION)
    retired = call(home, "skill.retire", skill="定位失败的测试", reason="做法过时")
    assert retired["skill"]["status"] == "retired"
    assert call(home, "skill.index")["index"] == []
    # Soft delete: the row survives, retired, with its version history intact.
    assert call(home, "skill.get", skill=retired["skill"]["skill_id"])["skill"]["status"] == "retired"


def test_model_cannot_retire_an_org_skill(home):
    # An org skill can only be created by the user-facing path (this command
    # refuses a non-project scope), so seed one directly in the store the
    # bridge itself uses for ``home``.
    from memory_system.bridge import Scope, open_memory

    with open_memory(Scope.from_payload({"home": home})) as memory:
        memory.ensure_project("proj-a", org_id="acme")
        memory.skills.create(
            view=memory.view("proj-a"),
            definition=SkillDefinition.from_dict(DEFINITION),
            name="org-rule",
            scope_kind="org",
            status="active",
        )
    error = fail(home, "skill.retire", skill="org-rule", model_authored=True)
    assert error["code"] == "bad_request"
    assert "only the user can retire" in error["message"]
    # The user's own call still goes through.
    assert call(home, "skill.retire", skill="org-rule")["skill"]["status"] == "retired"