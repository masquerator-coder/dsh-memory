"""Project skills are files: the `.agents/skills` bundle contract.

These pin what DSH's own ``skill-filesystem`` provider requires (kebab-case
name, frontmatter carrying ``name`` and ``description``, one level of
discovery) plus the policy that makes file-backed authoring safe: never
overwrite, never evict, retire by moving the bundle out of the scanned root,
and keep run evidence out of the repository.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from memory_system import SkillDefinition, Step
from memory_system import project_skills
from memory_system.errors import MemoryError, NotFoundError, ValidationError


def make_definition(**overrides) -> SkillDefinition:
    base = dict(
        title="定位失败的测试",
        description="从失败用例缩到最小复现",
        when_to_use="测试挂了但还没找到最小复现时",
        triggers=["测试失败", "单测失败"],
        requires_tools=["pwsh"],
        steps=[
            Step(action="运行失败的单个测试", tool="pwsh"),
            Step(action="修改实现文件", tool="edit", critical=True),
            Step(action="重跑测试确认通过", tool="pwsh", args_hint="pytest tests -q"),
        ],
        success_criteria="目标测试通过且相关用例无回归",
        fallback="回退到上一个提交再定位",
    )
    base.update(overrides)
    return SkillDefinition(**base)


@pytest.fixture()
def project_root(tmp_path: Path) -> Path:
    """A checkout without any skill root yet; the writer creates it."""
    root = tmp_path / "repo"
    root.mkdir()
    (root / ".git").mkdir()
    return root


# ── the bundle on disk ──────────────────────────────────────────────────


def test_create_writes_a_bundle_the_provider_can_parse(project_root: Path):
    skill = project_skills.create(project_root, make_definition(), name="locate-failing-test")
    path = project_root / ".agents" / "skills" / "locate-failing-test" / "SKILL.md"
    assert path.is_file() and skill.path == path
    text = path.read_text(encoding="utf-8")
    # The provider only reads YAML frontmatter delimited by `---`.
    assert text.startswith("---\n")
    front, body = project_skills.parse_frontmatter(text)
    assert front["name"] == "locate-failing-test"
    assert front["description"] == "从失败用例缩到最小复现"
    assert front["whenToUse"] == "测试挂了但还没找到最小复现时"
    assert front["metadata"]["title"] == "定位失败的测试"
    assert front["metadata"]["triggers"] == ["测试失败", "单测失败"]
    assert "## 步骤" in body and "**(关键)**" in body


def test_values_that_would_change_yaml_meaning_are_quoted(project_root: Path):
    definition = make_definition(description="先看 a: b，再看 [x]")
    project_skills.create(project_root, definition, name="quoted-values")
    text = (project_root / ".agents" / "skills" / "quoted-values" / "SKILL.md").read_text(encoding="utf-8")
    front, _ = project_skills.parse_frontmatter(text)
    assert front["description"] == "先看 a: b，再看 [x]"


def test_objective_fields_survive_a_render_parse_roundtrip(project_root: Path):
    project_skills.create(project_root, make_definition(), name="roundtrip")
    skill = project_skills.load(project_root, "roundtrip")
    assert skill is not None
    assert skill.title == "定位失败的测试"
    assert skill.triggers == ["测试失败", "单测失败"]
    assert skill.requires_tools == ["pwsh"]
    # Steps live in the body, which is exactly what the model reads; the
    # frontmatter only carries what the catalog needs.
    assert skill.steps == []
    assert "1. `pwsh` 运行失败的单个测试" in skill.body


# ── names ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name",
    ["定位失败的测试", "locate failing test", "Locate-Failing", "under_score", "-leading", "trail-", ""],
)
def test_only_kebab_case_names_are_accepted(project_root: Path, name: str):
    """The catalog silently drops other spellings, so the write path refuses them."""
    with pytest.raises(ValidationError):
        project_skills.create(project_root, make_definition(), name=name)
    assert not (project_root / ".agents").exists()


def test_valid_name_is_returned_normalised():
    assert project_skills.validate_name("  locate-failing-test  ") == "locate-failing-test"


# ── never overwrite, never evict ────────────────────────────────────────


def test_existing_bundle_is_refused_and_left_untouched(project_root: Path):
    project_skills.create(project_root, make_definition(), name="dup")
    path = project_root / ".agents" / "skills" / "dup" / "SKILL.md"
    before = path.read_text(encoding="utf-8")
    with pytest.raises(ValidationError) as excinfo:
        project_skills.create(project_root, make_definition(title="另一个"), name="dup")
    assert "已存在" in str(excinfo.value)
    assert path.read_text(encoding="utf-8") == before


def test_cap_refuses_instead_of_evicting(project_root: Path):
    project_skills.create(project_root, make_definition(), name="first", limit=1)
    with pytest.raises(ValidationError) as excinfo:
        project_skills.create(project_root, make_definition(title="发布前检查"), name="second", limit=1)
    assert "active 技能" in str(excinfo.value)
    assert [s.name for s in project_skills.discover(project_root)] == ["first"]


def test_failed_write_leaves_no_half_built_bundle(project_root: Path, monkeypatch: pytest.MonkeyPatch):
    def boom(path: Path, text: str) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(project_skills, "_atomic_write", boom)
    with pytest.raises(MemoryError):
        project_skills.create(project_root, make_definition(), name="doomed")
    assert not (project_root / ".agents" / "skills" / "doomed").exists()
    assert project_skills.discover(project_root) == []


def test_invalid_definition_is_refused_before_any_write(project_root: Path):
    with pytest.raises(ValidationError):
        project_skills.create(project_root, make_definition(steps=[]), name="no-steps")
    assert project_skills.discover(project_root) == []


# ── discovery ───────────────────────────────────────────────────────────


def test_discovery_reads_one_level_and_skips_non_bundles(project_root: Path):
    root = project_root / ".agents" / "skills"
    (root / "real" / "SKILL.md").parent.mkdir(parents=True)
    (root / "real" / "SKILL.md").write_text(
        "---\nname: real\ndescription: 真的技能\n---\n\n# real\n", encoding="utf-8"
    )
    # A flat file, a bundle without SKILL.md, a nested bundle and a dotted
    # directory must all stay invisible to the provider, so they stay invisible here.
    (root / "flat.md").write_text("---\nname: flat\ndescription: x\n---\n", encoding="utf-8")
    (root / "empty-dir").mkdir()
    (root / "outer" / "inner" / "SKILL.md").parent.mkdir(parents=True)
    (root / "outer" / "inner" / "SKILL.md").write_text("---\nname: inner\ndescription: x\n---\n", encoding="utf-8")
    (root / ".retired" / "old").mkdir(parents=True)
    (root / ".retired" / "old" / "SKILL.md").write_text("---\nname: old\ndescription: x\n---\n", encoding="utf-8")

    assert [s.name for s in project_skills.discover(project_root)] == ["real"]


def test_a_bundle_without_description_is_reported_not_hidden(project_root: Path):
    root = project_root / ".agents" / "skills" / "broken"
    root.mkdir(parents=True)
    (root / "SKILL.md").write_text("---\nname: broken\n---\n\n# broken\n", encoding="utf-8")
    skill = project_skills.load(project_root, "broken")
    assert skill is not None and "description" in (skill.problem or "")


def test_externally_authored_frontmatter_is_read(project_root: Path):
    """A human (or another tool) may write the file in plain YAML."""
    root = project_root / ".agents" / "skills" / "hand-written"
    root.mkdir(parents=True)
    (root / "SKILL.md").write_text(
        "---\n"
        "name: hand-written\n"
        "description: 手写的技能\n"
        "whenToUse: 需要时\n"
        "metadata:\n"
        "  title: 手写\n"
        "  triggers: [手写, 人工]\n"
        "---\n\n# 手写\n\n## 步骤\n1. 做事\n",
        encoding="utf-8",
    )
    skill = project_skills.load(project_root, "hand-written")
    assert skill is not None
    assert skill.title == "手写" and skill.triggers == ["手写", "人工"] and skill.problem is None


def test_resolve_accepts_name_qualified_name_and_path(project_root: Path):
    created = project_skills.create(project_root, make_definition(), name="resolve-me")
    skills = project_skills.discover(project_root)
    assert project_skills.resolve(skills, "resolve-me") is not None
    assert project_skills.resolve(skills, "user:project:proj-a:resolve-me", project_id="proj-a") is not None
    assert project_skills.resolve(skills, str(created.bundle)) is not None
    assert project_skills.resolve(skills, "missing") is None


# ── retirement ──────────────────────────────────────────────────────────


def test_retire_moves_the_bundle_out_of_the_scanned_root(project_root: Path):
    project_skills.create(project_root, make_definition(), name="obsolete")
    retired = project_skills.retire(project_root, "obsolete")
    assert retired.bundle == project_root / ".agents" / "skills" / ".retired" / "obsolete"
    assert (retired.bundle / "SKILL.md").is_file()
    # Nothing is deleted and the provider no longer discovers it.
    assert project_skills.discover(project_root) == []


def test_retire_twice_keeps_both_bundles(project_root: Path):
    project_skills.create(project_root, make_definition(), name="twice")
    first = project_skills.retire(project_root, "twice")
    project_skills.create(project_root, make_definition(), name="twice")
    second = project_skills.retire(project_root, "twice")
    assert first.bundle != second.bundle
    assert first.bundle.is_dir() and second.bundle.is_dir()


def test_retire_unknown_skill_is_a_not_found(project_root: Path):
    with pytest.raises(NotFoundError):
        project_skills.retire(project_root, "nope")


# ── run ledger ──────────────────────────────────────────────────────────


def test_runs_are_recorded_outside_the_repository(tmp_path: Path, project_root: Path):
    home = tmp_path / "dsh-home"
    project_skills.create(project_root, make_definition(), name="ledger")
    first = project_skills.append_run(home, "proj-a", "ledger", outcome="success", success=True)
    second = project_skills.append_run(
        home, "proj-a", "ledger", outcome="failure", success=False, error="测试仍失败"
    )
    assert first["runs"] == 1 and first["success_rate"] == 1.0
    assert second["runs"] == 2 and second["success_rate"] == 0.5

    ledger = home / "l4_runs" / "proj-a" / "ledger.jsonl"
    assert ledger.is_file()
    records = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert [r["outcome"] for r in records] == ["success", "failure"]
    assert records[1]["error"] == "测试仍失败"
    # Nothing was written into the repository besides the skill bundle itself.
    assert not list(project_root.rglob("*.jsonl"))


def test_success_rate_uses_the_rolling_window(tmp_path: Path):
    home = tmp_path / "dsh-home"
    for index in range(5):
        project_skills.append_run(home, "proj-a", "window", outcome="success", success=index > 0)
    stats = project_skills.run_stats(home, "proj-a", "window", window=3)
    assert stats["runs"] == 5 and stats["window"] == 3
    assert stats["success_rate"] == 1.0


def test_run_stats_for_an_unused_skill_is_empty_not_an_error(tmp_path: Path):
    stats = project_skills.run_stats(tmp_path / "dsh-home", "proj-a", "never-run")
    assert stats["runs"] == 0 and stats["success_rate"] is None
