"""Bridge commands for L4: a project's skills are files in its checkout.

The wire is the only door the model has, so this is where the storage change
has to be honest: a create lands in ``<cwd>/.agents/skills/<name>/SKILL.md``
(a bundle DSH's own catalog discovers), the resident index stops listing
project skills because the host already shows them, nothing is ever
overwritten or evicted, and run evidence lands under the memory home instead
of dirtying the repository.
"""

from __future__ import annotations

from pathlib import Path

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

NAME = "locate-failing-test"


@pytest.fixture()
def home(tmp_path: Path) -> str:
    return str(tmp_path / "memory")


@pytest.fixture()
def repo(tmp_path: Path) -> str:
    """A checkout that owns the skill bundles."""
    root = tmp_path / "repo"
    root.mkdir()
    (root / ".git").mkdir()
    return str(root)


def call(home: str, repo: str, command: str, **payload) -> dict:
    reply = handle(
        {
            "id": "t",
            "command": command,
            "payload": {"home": home, "project_id": "proj-a", "cwd": repo, **payload},
        }
    )
    assert reply["ok"], reply.get("error")
    return reply["result"]


def fail(home: str, repo: str, command: str, **payload) -> dict:
    reply = handle(
        {
            "id": "t",
            "command": command,
            "payload": {"home": home, "project_id": "proj-a", "cwd": repo, **payload},
        }
    )
    assert reply["ok"] is False, reply
    return reply["error"]


def seed_org_skill(home: str) -> None:
    """An org skill can only be created by the user-facing path, so seed one."""
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


# ── create ──────────────────────────────────────────────────────────────


def test_create_writes_the_bundle_and_lists_it(home: str, repo: str):
    created = call(home, repo, "skill.create", model_authored=True, definition=DEFINITION, name=NAME)
    assert created["created"] is True and created["reused"] is False
    assert created["actor"] == "model"
    skill = created["skill"]
    assert skill["source"] == "file" and skill["status"] == "active"
    assert skill["qualified_name"] == f"user:project:proj-a:{NAME}"
    # The file DSH's provider discovers, at the path it scans.
    bundle = Path(repo) / ".agents" / "skills" / NAME / "SKILL.md"
    assert bundle.is_file() and skill["path"] == str(bundle)
    assert bundle.read_text(encoding="utf-8").startswith("---\n")

    listed = call(home, repo, "skill.list")
    assert listed["file_skills"] == 1
    entry = next(item for item in listed["items"] if item["source"] == "file")
    assert entry["name"] == NAME
    # The list carries what a caller needs to choose, not just ids. Steps stay
    # in the body (read back by `skill.get` or the host's skill tool), so the
    # list reports their count instead of pretending to carry them.
    assert entry["description"] == "定位失败测试并验证"
    assert entry["step_count"] == 3


def test_name_is_required_and_must_be_kebab_case(home: str, repo: str):
    missing = fail(home, repo, "skill.create", model_authored=True, definition=DEFINITION)
    assert missing["code"] == "validation" and "kebab-case" in missing["message"]
    chinese = fail(
        home, repo, "skill.create", model_authored=True, definition=DEFINITION, name="定位失败的测试"
    )
    assert chinese["code"] == "validation"
    # Nothing was written for a refused name: the catalog would ignore it.
    assert not (Path(repo) / ".agents").exists()


def test_second_create_of_the_same_name_is_refused(home: str, repo: str):
    call(home, repo, "skill.create", model_authored=True, definition=DEFINITION, name=NAME)
    bundle = Path(repo) / ".agents" / "skills" / NAME / "SKILL.md"
    before = bundle.read_text(encoding="utf-8")
    error = fail(
        home, repo, "skill.create", model_authored=True, definition=OTHER, name=NAME
    )
    assert error["code"] == "validation" and "已存在" in error["message"]
    assert bundle.read_text(encoding="utf-8") == before


def test_org_and_sys_scopes_are_refused(home: str, repo: str):
    for scope in ("org", "sys"):
        error = fail(
            home, repo, "skill.create", model_authored=True, definition=DEFINITION, name=NAME, scope_kind=scope
        )
        assert error["code"] == "bad_request"
        assert "org/sys promotion stays a user decision" in error["message"]
    assert call(home, repo, "skill.list")["items"] == []


def test_definition_must_be_an_object_with_steps(home: str, repo: str):
    assert fail(home, repo, "skill.create", model_authored=True, name=NAME)["code"] == "bad_request"
    assert fail(home, repo, "skill.create", definition=["nope"], name=NAME)["code"] == "bad_request"
    no_steps = {k: v for k, v in DEFINITION.items() if k != "steps"}
    assert fail(home, repo, "skill.create", definition=no_steps, name=NAME)["code"] == "bad_request"


def test_invalid_definition_reports_validation(home: str, repo: str):
    too_long = {**DEFINITION, "description": "x" * 40}
    error = fail(home, repo, "skill.create", model_authored=True, definition=too_long, name=NAME)
    assert error["code"] == "validation"
    assert "30 characters" in error["message"]
    assert not (Path(repo) / ".agents").exists()


def test_cap_answers_with_a_decision(home: str, repo: str):
    call(home, repo, "skill.create", model_authored=True, definition=DEFINITION, name=NAME, max_active=1)
    error = fail(
        home, repo, "skill.create", model_authored=True, definition=OTHER, name="release-check", max_active=1
    )
    assert error["code"] == "validation"
    assert "active 技能" in error["message"]
    # Nothing was evicted to make room.
    assert call(home, repo, "skill.list")["file_skills"] == 1


def test_create_needs_a_cwd_to_know_where_the_checkout_is(home: str):
    reply = handle(
        {
            "id": "t",
            "command": "skill.create",
            "payload": {"home": home, "project_id": "proj-a", "definition": DEFINITION, "name": NAME},
        }
    )
    assert reply["ok"] is False
    assert reply["error"]["code"] == "bad_request"
    assert "cwd is required" in reply["error"]["message"]


# ── the resident index ──────────────────────────────────────────────────


def test_index_lists_no_project_skill(home: str, repo: str):
    """Project skills reach the model through the host's catalog, not here.

    Listing them in both places would spend the same tokens twice and make the
    model believe two skills exist.
    """
    call(home, repo, "skill.create", model_authored=True, definition=DEFINITION, name=NAME)
    assert call(home, repo, "skill.list")["file_skills"] == 1
    assert call(home, repo, "skill.index")["index"] == []


def test_index_still_lists_global_skills(home: str, repo: str):
    seed_org_skill(home)
    call(home, repo, "skill.create", model_authored=True, definition=DEFINITION, name=NAME)
    index = call(home, repo, "skill.index")["index"]
    assert len(index) == 1 and "org-rule" in index[0]
    assert NAME not in index[0]


# ── read / run / retire ─────────────────────────────────────────────────


def test_get_reads_the_bundle(home: str, repo: str):
    call(home, repo, "skill.create", model_authored=True, definition=DEFINITION, name=NAME)
    found = call(home, repo, "skill.get", skill=NAME)
    assert found["source"] == "file"
    assert found["skill"]["qualified_name"].endswith(NAME)
    assert found["definition"]["title"] == "定位失败的测试"
    assert "修改实现文件" in found["markdown"]
    assert fail(home, repo, "skill.get", skill="不存在的技能")["code"] == "not_found"


def test_run_records_into_the_ledger(home: str, repo: str):
    call(home, repo, "skill.create", model_authored=True, definition=DEFINITION, name=NAME)
    first = call(home, repo, "skill.run", skill=NAME, outcome="success")
    assert first["success"] is True and first["runs"] == 1
    failed = call(home, repo, "skill.run", skill=NAME, outcome="failure", error="测试仍然失败")
    assert failed["success"] is False
    assert failed["runs"] == 2 and failed["success_rate"] == 0.5
    ledger = Path(home) / "l4_runs" / "proj-a" / f"{NAME}.jsonl"
    assert ledger.is_file()
    # Evidence follows the skill, not the repository.
    assert not list(Path(repo).rglob("*.jsonl"))


def test_partial_is_not_counted_as_success(home: str, repo: str):
    call(home, repo, "skill.create", model_authored=True, definition=DEFINITION, name=NAME)
    partial = call(home, repo, "skill.run", skill=NAME, outcome="partial")
    assert partial["success"] is False and partial["success_rate"] == 0.0


def test_retire_moves_the_bundle_out_of_the_scanned_root(home: str, repo: str):
    call(home, repo, "skill.create", model_authored=True, definition=DEFINITION, name=NAME)
    retired = call(home, repo, "skill.retire", skill=NAME, reason="做法过时")
    assert retired["source"] == "file" and retired["skill"]["status"] == "retired"
    moved = Path(repo) / ".agents" / "skills" / ".retired" / NAME / "SKILL.md"
    assert moved.is_file()
    # Soft delete: gone from the catalog, still on disk.
    assert call(home, repo, "skill.list")["file_skills"] == 0
    assert not (Path(repo) / ".agents" / "skills" / NAME).exists()


def test_model_cannot_retire_an_org_skill(home: str, repo: str):
    seed_org_skill(home)
    error = fail(home, repo, "skill.retire", skill="org-rule", model_authored=True)
    assert error["code"] == "bad_request"
    assert "only the user can retire" in error["message"]
    # The user's own call still goes through.
    assert call(home, repo, "skill.retire", skill="org-rule")["skill"]["status"] == "retired"
