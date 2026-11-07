"""The checkout's own files: ``.agents/memory/MEMORY.md`` and ``.agents/rules``.

The work summary is derived (rewritten from L2, never read back as truth); the
rules are authored content (one Markdown per rule, the file is the source of
truth). These tests pin the two contracts the prompt path depends on:

* the excerpt cleaning and character cap the host renders into a system prompt,
  where the file's marker/title/blockquote are chrome and a missing file is not
  an error;
* the atomic, never-overwriting rule writer, plus the legacy root
  ``DSH_MEMORY.md`` cleanup that makes the move lossless.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from memory_system import project_files
from memory_system.errors import ConflictError, ValidationError
from memory_system.project_files import (
    LEGACY_PROJECT_SUMMARY_FILE,
    PROJECT_MEMORY_RELATIVE,
    PROJECT_SUMMARY_MARKER,
    create_rule,
    legacy_memory_path,
    memory_path,
    read_project_memory,
    read_rules,
    render_rule,
    rules_dir,
    validate_rule_name,
)
from memory_system.summary import write_project_summaries


# ── helpers ─────────────────────────────────────────────────────────────


def generated_memory_text() -> str:
    """A file in the exact shape ``write_project_summaries`` produces."""
    return (
        f"{PROJECT_SUMMARY_MARKER}\n"
        "# 项目摘要：Project A\n"
        "\n"
        "> 项目 ID：`proj-a` · 由 dsh-memory 自动维护 · 更新于 2026-11-07 09:30:00\n"
        "> 只记录已做过的工作；经验教训与偏好不在此文件中。\n"
        "> 用户对项目的约定、规则、限制在 `.agents/rules/`（一条规则一份 markdown）。\n"
        "\n"
        "## 2026-11-07\n"
        "\n"
        "- `09:30` （fix · 结果：success）修复了登录竞态\n"
        "- `10:00` （note）接入了记忆工具\n"
    )


def write_memory_file(root: Path, text: str) -> Path:
    path = memory_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def write_rule_file(
    root: Path,
    filename: str,
    *,
    name: str,
    title: str,
    description: str,
    content: str,
    created_at: str = "2026-11-07T09:00:00+00:00",
) -> Path:
    path = rules_dir(root) / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        render_rule(
            name=name,
            title=title,
            description=description,
            content=content,
            created_at=created_at,
        ),
        encoding="utf-8",
    )
    return path


# ── paths ───────────────────────────────────────────────────────────────


def test_project_files_live_under_the_agents_directory(tmp_path: Path):
    assert PROJECT_MEMORY_RELATIVE == ".agents/memory/MEMORY.md"
    assert memory_path(tmp_path) == tmp_path / ".agents" / "memory" / "MEMORY.md"
    assert rules_dir(tmp_path) == tmp_path / ".agents" / "rules"
    assert legacy_memory_path(tmp_path) == tmp_path / LEGACY_PROJECT_SUMMARY_FILE
    # The forward-slash spelling is the one the status payload and docs show.
    assert memory_path(tmp_path).as_posix().endswith(PROJECT_MEMORY_RELATIVE)


def test_missing_memory_file_reads_as_exists_false(tmp_path: Path):
    """A project that recorded nothing yet (or a read-only checkout) is fine.

    ``read_project_memory`` is a read: it must not create the directory, so the
    caller can distinguish "not written yet" from "this project has no work".
    """
    result = read_project_memory(tmp_path)
    assert result["exists"] is False
    assert result["chars"] == 0
    assert result["updated"] is None
    assert result["excerpt"] == ""
    assert result["truncated"] is False
    assert result["path"] == str(memory_path(tmp_path))
    assert not (tmp_path / ".agents").exists()


# ── the work summary excerpt ────────────────────────────────────────────


def test_excerpt_keeps_only_day_headings_and_work_lines(tmp_path: Path):
    text = generated_memory_text()
    write_memory_file(tmp_path, text)

    result = read_project_memory(tmp_path)

    assert result["exists"] is True
    # `chars` is the whole file so a host can say "there is more" without
    # reading it again; the excerpt is the prompt-sized view.
    assert result["chars"] == len(text)
    assert result["updated"] == "2026-11-07 09:30:00"
    assert result["excerpt"] == (
        "## 2026-11-07\n"
        "- `09:30` （fix · 结果：success）修复了登录竞态\n"
        "- `10:00` （note）接入了记忆工具"
    )
    # Marker, H1 title and the blockquote are metadata for a human opening the
    # file, not prompt content.
    assert PROJECT_SUMMARY_MARKER not in result["excerpt"]
    assert "# 项目摘要" not in result["excerpt"]
    assert "项目 ID" not in result["excerpt"]
    assert "更新于" not in result["excerpt"]
    assert result["truncated"] is False


def test_excerpt_cap_truncates_on_a_line_boundary(tmp_path: Path):
    text = generated_memory_text()
    write_memory_file(tmp_path, text)
    first_line = "## 2026-11-07"

    # A budget that fits exactly one line keeps that line whole instead of
    # cutting mid-character.
    whole = read_project_memory(tmp_path, max_chars=len(first_line))
    assert whole["truncated"] is True
    assert whole["excerpt"] == first_line
    assert whole["chars"] == len(text)

    # A budget that falls inside line two keeps the first line and the longest
    # prefix of the second that fits.
    partial = read_project_memory(tmp_path, max_chars=len(first_line) + 6)
    assert partial["truncated"] is True
    assert partial["excerpt"].startswith(first_line)
    assert len(partial["excerpt"]) <= len(first_line) + 6
    assert partial["excerpt"] != whole["excerpt"]

    full = read_project_memory(tmp_path, max_chars=10_000)
    assert full["truncated"] is False
    assert full["excerpt"].endswith("接入了记忆工具")

    empty = read_project_memory(tmp_path, max_chars=0)
    assert empty["excerpt"] == ""
    assert empty["truncated"] is True


def test_excerpt_is_empty_when_no_work_was_recorded(tmp_path: Path):
    """The placeholder must not be injected as if it were work."""
    text = (
        f"{PROJECT_SUMMARY_MARKER}\n"
        "# 项目摘要：Empty Project\n"
        "\n"
        "> 项目 ID：`proj-empty` · 由 dsh-memory 自动维护 · 更新于 （无）\n"
        "> 只记录已做过的工作；经验教训与偏好不在此文件中。\n"
        "\n"
        "（还没有记录任何工作。）\n"
    )
    write_memory_file(tmp_path, text)

    result = read_project_memory(tmp_path)

    assert result["exists"] is True
    assert result["chars"] == len(text)
    assert result["updated"] is None
    assert result["excerpt"] == ""
    assert result["truncated"] is False


# ── project rules ───────────────────────────────────────────────────────


def test_read_rules_sorts_by_file_name_and_strips_the_chrome(tmp_path: Path):
    # Written out of alphabetical order on purpose: the injected order must be
    # stable, so it is the file name (not creation time) that decides.
    zeta = write_rule_file(
        tmp_path,
        "zeta.md",
        name="zeta-rule",
        title="乙规则",
        description="乙规则的说明",
        content="乙规则正文。\n\n- 第二条",
        created_at="2026-11-07T10:00:00+00:00",
    )
    alpha = write_rule_file(
        tmp_path,
        "alpha.md",
        name="alpha-rule",
        title="甲规则",
        description="甲规则的说明",
        content="甲规则正文。",
        created_at="2026-11-06T09:00:00+00:00",
    )
    # Things that are not rules: a non-Markdown file, a hidden draft and a
    # retired bundle directory are all ignored by the scan.
    (rules_dir(tmp_path) / "notes.txt").write_text("not a rule", encoding="utf-8")
    (rules_dir(tmp_path) / ".draft.md").write_text(
        "---\nname: draft\n---\n\n# 草稿\n\n正文", encoding="utf-8"
    )
    retired = rules_dir(tmp_path) / "old.retired"
    retired.mkdir()
    (retired / "retired.md").write_text(
        "---\nname: retired\n---\n\n# 旧规则\n\n正文", encoding="utf-8"
    )

    rules, truncated = read_rules(tmp_path)

    assert truncated is False
    assert [rule["name"] for rule in rules] == ["alpha-rule", "zeta-rule"]
    assert [rule["path"] for rule in rules] == [str(alpha), str(zeta)]
    first = rules[0]
    assert first["title"] == "甲规则"  # metadata.title, not the H1 fallback
    assert first["description"] == "甲规则的说明"
    # No frontmatter and no duplicated `# title` heading in the body.
    assert first["content"] == "甲规则正文。"
    assert first["chars"] == len("甲规则正文。")
    assert rules[1]["content"] == "乙规则正文。\n\n- 第二条"


def test_read_rules_reports_budget_truncation(tmp_path: Path):
    for index, filename in enumerate(("a.md", "b.md", "c.md")):
        write_rule_file(
            tmp_path,
            filename,
            name=f"rule-{index}",
            title=f"规则{index}",
            description="说明",
            content=f"正文{index}",
        )

    capped, truncated = read_rules(tmp_path, max_rules=2)
    assert [rule["name"] for rule in capped] == ["rule-0", "rule-1"]
    assert truncated is True

    # A budget too small for even one rule's heading/name overhead reports the
    # loss instead of silently returning nothing.
    squeezed, squeezed_truncated = read_rules(tmp_path, max_chars=10)
    assert squeezed == []
    assert squeezed_truncated is True


def test_a_rule_longer_than_the_budget_is_marked_with_a_pointer(tmp_path: Path):
    body = "很长的规则正文。" * 60
    path = write_rule_file(
        tmp_path,
        "long-rule.md",
        name="long-rule",
        title="超长规则",
        description="说明",
        content=body,
    )

    rules, truncated = read_rules(tmp_path, max_chars=300)

    assert truncated is True
    assert len(rules) == 1
    rule = rules[0]
    assert rule["content"].startswith("很长的规则正文。")
    # The model gets a readable prefix plus the file it can read for the rest,
    # never a silently partial rule, and the other rules keep their budget.
    assert "（规则过长，完整内容见 " in rule["content"]
    assert str(path) in rule["content"]
    assert len(rule["content"]) < len(body)
    assert rule["chars"] == len(rule["content"])


# ── creating a rule ─────────────────────────────────────────────────────


def test_create_rule_writes_frontmatter_and_body_atomically(tmp_path: Path):
    path = create_rule(
        tmp_path,
        name="comments-in-chinese",
        title="注释使用中文",
        description="代码注释必须用中文写",
        content="所有注释使用中文，标识符保留英文。\n",
        created_at="2026-11-07T09:00:00+00:00",
    )

    assert path == rules_dir(tmp_path) / "comments-in-chinese.md"
    assert path.is_file()
    # The temporary file used for the atomic rename is never left behind.
    assert [entry.name for entry in rules_dir(tmp_path).iterdir()] == [
        "comments-in-chinese.md"
    ]

    rules, truncated = read_rules(tmp_path)
    assert truncated is False
    assert len(rules) == 1
    rule = rules[0]
    assert rule["name"] == "comments-in-chinese"
    assert rule["title"] == "注释使用中文"
    assert rule["description"] == "代码注释必须用中文写"
    # The trailing newline from the caller is stripped; the body round-trips.
    assert rule["content"] == "所有注释使用中文，标识符保留英文。"
    assert rule["path"] == str(path)
    raw = path.read_text(encoding="utf-8")
    assert raw.startswith("---\n")
    assert "created-at: 2026-11-07T09:00:00+00:00" in raw


def test_create_rule_refuses_duplicates_without_touching_the_original(tmp_path: Path):
    original = create_rule(
        tmp_path,
        name="no-force-push",
        title="禁止强推",
        description="保护共享分支",
        content="不得对共享分支执行 git push --force。",
        created_at="2026-11-07T09:00:00+00:00",
    )
    before = original.read_text(encoding="utf-8")

    with pytest.raises(ConflictError):
        create_rule(
            tmp_path,
            name="no-force-push",
            title="另一个标题",
            description="另一段说明",
            content="另一段正文",
        )

    # No overwrite happened and no half-written file was left behind.
    assert original.read_text(encoding="utf-8") == before
    rules, _ = read_rules(tmp_path)
    assert len(rules) == 1
    assert rules[0]["content"] == "不得对共享分支执行 git push --force。"


@pytest.mark.parametrize("name", ["Bad Name", "", "  ", "../escape", "UPPER", "under_score"])
def test_create_rule_rejects_a_bad_name(tmp_path: Path, name: str):
    with pytest.raises(ValidationError):
        create_rule(tmp_path, name=name, title="标题", description="说明", content="正文")
    # Validation happens before any directory/file is created.
    assert not rules_dir(tmp_path).exists()


@pytest.mark.parametrize(
    "overrides",
    [{"title": "  "}, {"description": "\n"}, {"content": "   "}],
)
def test_create_rule_rejects_empty_fields(tmp_path: Path, overrides: dict[str, str]):
    payload = {"name": "valid-name", "title": "标题", "description": "说明", "content": "正文"}
    with pytest.raises(ValidationError):
        create_rule(tmp_path, **{**payload, **overrides})
    assert not rules_dir(tmp_path).exists()


def test_validate_rule_name_trims_and_keeps_kebab_case():
    assert validate_rule_name("  memory-file-location  ") == "memory-file-location"
    assert validate_rule_name("r2") == "r2"
    with pytest.raises(ValidationError):
        validate_rule_name("有中文的名字")


def test_create_rule_failure_leaves_no_partial_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A failed atomic replace must not leave a visible or scratch file."""

    def refuse(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(project_files.os, "replace", refuse)
    with pytest.raises(ValidationError):
        create_rule(
            tmp_path,
            name="crash-rule",
            title="崩溃规则",
            description="说明",
            content="正文",
        )
    assert not (rules_dir(tmp_path) / "crash-rule.md").exists()
    assert list(rules_dir(tmp_path).glob("*.tmp")) == []


# ── legacy root file migration ──────────────────────────────────────────


def test_write_summaries_removes_a_generated_legacy_file(
    tmp_path: Path, memory, project: str
):
    """The old root file was a generated artifact; the new write owns cleanup."""
    root = tmp_path / "repo"
    root.mkdir()
    legacy = root / LEGACY_PROJECT_SUMMARY_FILE
    legacy.write_text(
        f"{PROJECT_SUMMARY_MARKER}\n# 项目摘要：旧位置\n\n- `09:00` 旧工作\n",
        encoding="utf-8",
    )
    memory.ensure_project(project, display_name="Project A", root_path=str(root))
    memory.remember(project_id=project, summary="迁移到 .agents 目录", event_type="fix")

    written = write_project_summaries(memory)

    target = memory_path(root)
    assert str(target) in written
    assert target.is_file()
    assert "迁移到 .agents 目录" in target.read_text(encoding="utf-8")
    assert not legacy.exists()

    # The rewritten file is readable by the same excerpt path the host uses.
    info = read_project_memory(root)
    assert info["exists"] is True
    assert info["excerpt"].startswith("## ")
    assert "迁移到 .agents 目录" in info["excerpt"]
    assert PROJECT_SUMMARY_MARKER not in info["excerpt"]


def test_a_hand_written_root_file_survives_the_migration(
    tmp_path: Path, memory, project: str
):
    """Only a file carrying the writer's marker is provably ours to delete."""
    root = tmp_path / "repo"
    root.mkdir()
    legacy = root / LEGACY_PROJECT_SUMMARY_FILE
    handwritten = "# 我自己的笔记\n- 这条不是生成的文件，不能删除\n"
    legacy.write_text(handwritten, encoding="utf-8")
    memory.ensure_project(project, display_name="Project A", root_path=str(root))
    memory.remember(project_id=project, summary="新位置的工作", event_type="note")

    write_project_summaries(memory)

    assert memory_path(root).is_file()
    assert "新位置的工作" in memory_path(root).read_text(encoding="utf-8")
    assert legacy.read_text(encoding="utf-8") == handwritten
