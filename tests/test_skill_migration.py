"""The one-way door: project skills leave the store and become bundles.

Phase 2 of the file-backed layout. These pin the order that makes the move
safe — write the bundle, move the run history, then delete the row — and the
refusal to invent a bundle name for a row that has none.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from memory_system import MemorySystem, SkillDefinition, Step
from memory_system.migrate import export_project_skills


def make_definition(**overrides) -> SkillDefinition:
    base = dict(
        title="定位失败的测试",
        description="从失败用例缩到最小复现",
        when_to_use="测试挂了但还没找到最小复现时",
        triggers=["测试失败"],
        requires_tools=["pwsh"],
        steps=[Step(action="运行失败的单个测试", tool="pwsh"), Step(action="重跑确认", tool="pwsh")],
        success_criteria="目标测试通过",
    )
    base.update(overrides)
    return SkillDefinition(**base)


def seed_project_skill(memory: MemorySystem, project: str, name: str = "定位失败的测试") -> str:
    """Write the row the way the store did before the bundle layout."""
    created = memory.skills.create(
        view=memory.view(project),
        definition=make_definition(title=name),
        name=name,
        scope_kind="project",
        status="active",
    )
    return created.skill_id


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    (root / ".git").mkdir()
    return root


def test_export_writes_the_bundle_then_removes_the_row(
    memory: MemorySystem, project: str, repo: Path, tmp_path: Path
):
    skill_id = seed_project_skill(memory, project)
    report = export_project_skills(
        memory, repo, names={skill_id: "locate-failing-test"}, memory_home=tmp_path / "home"
    )
    assert report.exported == 1
    item = report.items[0]
    assert item.deleted is True and item.name == "locate-failing-test"
    bundle = repo / ".agents" / "skills" / "locate-failing-test" / "SKILL.md"
    assert bundle.is_file()
    assert "运行失败的单个测试" in bundle.read_text(encoding="utf-8")
    # The row, its FTS entry and its runs are gone; nothing dangles.
    assert memory.store.scalar("SELECT count(*) FROM l4_skills") == 0
    assert memory.store.scalar("SELECT count(*) FROM l4_fts WHERE skill_id = ?", (skill_id,)) == 0
    assert memory.store.scalar("SELECT count(*) FROM l4_runs WHERE skill_id = ?", (skill_id,)) == 0


def test_export_moves_run_history_into_the_ledger(
    memory: MemorySystem, project: str, repo: Path, tmp_path: Path
):
    skill_id = seed_project_skill(memory, project)
    memory.store.execute(
        "INSERT INTO l4_runs (run_id, skill_id, project_id, outcome, success, error, steps, "
        "tool_names, launch_context, started_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ("run_1", skill_id, project, "failure", 0, "仍失败", "[]", "[]", "{}", "2026-10-01T00:00:00+00:00"),
    )
    home = tmp_path / "home"
    export_project_skills(memory, repo, names={skill_id: "locate-failing-test"}, memory_home=home)
    ledger = home / "l4_runs" / project / "locate-failing-test.jsonl"
    assert ledger.is_file()
    lines = [line for line in ledger.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(lines) == 1
    assert '"at": "2026-10-01T00:00:00+00:00"' in lines[0]
    assert '"imported": true' in lines[0]


def test_a_row_without_a_name_is_left_alone(memory: MemorySystem, project: str, repo: Path):
    seed_project_skill(memory, project)
    report = export_project_skills(memory, repo)
    assert report.exported == 0
    assert report.items[0].reason and "name required" in report.items[0].reason
    # Still there, and still usable through the store path: nothing was guessed.
    assert memory.store.scalar("SELECT count(*) FROM l4_skills") == 1
    assert not (repo / ".agents").exists()


def test_dry_run_reports_without_writing_or_deleting(memory: MemorySystem, project: str, repo: Path):
    skill_id = seed_project_skill(memory, project)
    report = export_project_skills(memory, repo, names={skill_id: "locate-failing-test"}, dry_run=True)
    assert report.exported == 0
    assert report.items[0].path and report.items[0].reason == "dry run"
    assert not (repo / ".agents").exists()
    assert memory.store.scalar("SELECT count(*) FROM l4_skills") == 1


def test_an_existing_bundle_keeps_the_row(memory: MemorySystem, project: str, repo: Path):
    from memory_system import project_skills

    skill_id = seed_project_skill(memory, project)
    project_skills.create(repo, make_definition(title="已经存在"), name="locate-failing-test")
    report = export_project_skills(memory, repo, names={skill_id: "locate-failing-test"})
    assert report.exported == 0
    assert "已存在" in (report.items[0].reason or "")
    # The bundle on disk was not overwritten, and the row survives for a retry.
    assert memory.store.scalar("SELECT count(*) FROM l4_skills") == 1


def test_second_run_has_nothing_left_to_export(memory: MemorySystem, project: str, repo: Path):
    skill_id = seed_project_skill(memory, project)
    export_project_skills(memory, repo, names={skill_id: "locate-failing-test"})
    assert export_project_skills(memory, repo).items == []
