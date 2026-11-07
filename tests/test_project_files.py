"""The checkout's own files: daily work records and ``.agents/rules``.

The work records are derived (rewritten from L2, never read back as truth), one
Markdown file per UTC day under ``.agents/memory/<YYYY-MM-DD>.md``; the rules
are authored content (one Markdown per rule, the file is the source of truth).
These tests pin the contracts the prompt path depends on:

* the excerpt cleaning, day ordering and character cap the host renders into a
  system prompt, where the marker/title/blockquote are chrome and a missing
  directory is not an error;
* the atomic, unchanged-skipping day-file writer and the deletion rules that
  make forgetting a record or migrating an older layout lossless;
* the atomic, never-overwriting rule writer.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from memory_system import project_files
from memory_system.errors import ConflictError, ValidationError
from memory_system.project_files import (
    LEGACY_PROJECT_MEMORY_FILE,
    LEGACY_PROJECT_SUMMARY_FILE,
    PROJECT_MEMORY_DIR_RELATIVE,
    PROJECT_SUMMARY_MARKER,
    create_rule,
    day_memory_path,
    legacy_memory_path,
    list_memory_files,
    memory_dir,
    read_project_memory,
    read_rules,
    render_memory_day,
    render_rule,
    rules_dir,
    single_file_memory_path,
    validate_rule_name,
    write_memory_files,
)
from memory_system.summary import write_project_summaries


# ── helpers ─────────────────────────────────────────────────────────────


def generated_memory_text(
    day: str = "2026-11-07",
    *,
    updated: str = "2026-11-07 09:30:00",
    entries: list[str] | None = None,
) -> str:
    """A day file in the exact shape ``write_project_summaries`` produces."""
    if entries is None:
        entries = [
            "- `09:30` （fix · 结果：success）修复了登录竞态",
            "- `10:00` （note）接入了记忆工具",
        ]
    return render_memory_day(
        project_id="proj-a",
        display_name="Project A",
        day=day,
        updated=updated,
        entries=entries,
    )


def write_memory_file(root: Path, text: str, day: str = "2026-11-07") -> Path:
    path = day_memory_path(root, day)
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
    assert PROJECT_MEMORY_DIR_RELATIVE == ".agents/memory"
    assert memory_dir(tmp_path) == tmp_path / ".agents" / "memory"
    assert day_memory_path(tmp_path, "2026-11-07") == (
        tmp_path / ".agents" / "memory" / "2026-11-07.md"
    )
    assert single_file_memory_path(tmp_path) == (
        tmp_path / ".agents" / "memory" / LEGACY_PROJECT_MEMORY_FILE
    )
    assert rules_dir(tmp_path) == tmp_path / ".agents" / "rules"
    assert legacy_memory_path(tmp_path) == tmp_path / LEGACY_PROJECT_SUMMARY_FILE
    # The forward-slash spelling is the one the status payload and docs show.
    assert memory_dir(tmp_path).as_posix().endswith(PROJECT_MEMORY_DIR_RELATIVE)


def test_missing_memory_directory_reads_as_exists_false(tmp_path: Path):
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
    assert result["path"] is None
    assert result["dir"] == str(memory_dir(tmp_path))
    assert result["days"] == []
    assert result["files"] == []
    assert result["legacy"] is False
    assert not (tmp_path / ".agents").exists()


def test_generated_day_files_are_listed_newest_first(tmp_path: Path):
    write_memory_file(tmp_path, generated_memory_text("2026-11-05"), "2026-11-05")
    write_memory_file(tmp_path, generated_memory_text("2026-11-07"), "2026-11-07")
    write_memory_file(tmp_path, generated_memory_text("2026-11-06"), "2026-11-06")
    # Not ours: wrong name, an unmarked date-named file and a directory whose
    # name looks like a date file.
    (memory_dir(tmp_path) / "notes.md").write_text("note", encoding="utf-8")
    (memory_dir(tmp_path) / "2026-11-04.md").write_text("# 手写\n", encoding="utf-8")
    (memory_dir(tmp_path) / "2026-11-03.md").mkdir()

    paths = list_memory_files(tmp_path)

    assert [p.name for p in paths] == [
        "2026-11-07.md",
        "2026-11-06.md",
        "2026-11-05.md",
    ]


# ── the work record excerpt ─────────────────────────────────────────────


def test_excerpt_keeps_only_day_headings_and_work_lines(tmp_path: Path):
    text = generated_memory_text()
    write_memory_file(tmp_path, text)

    result = read_project_memory(tmp_path)

    assert result["exists"] is True
    assert result["legacy"] is False
    assert result["days"] == ["2026-11-07"]
    assert result["files"] == [str(day_memory_path(tmp_path, "2026-11-07"))]
    assert result["path"] == str(day_memory_path(tmp_path, "2026-11-07"))
    # `chars` is every file so a host can say "there is more" without reading
    # the records again; the excerpt is the prompt-sized view.
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


def test_excerpt_joins_newest_first_and_truncates_on_a_line_boundary(tmp_path: Path):
    older = generated_memory_text(
        "2026-11-06",
        updated="2026-11-06 18:00:00",
        entries=["- `18:00` （note）昨天的记录"],
    )
    newer = generated_memory_text("2026-11-07", entries=["- `09:30` （fix）今天的记录"])
    write_memory_file(tmp_path, older, "2026-11-06")
    write_memory_file(tmp_path, newer, "2026-11-07")

    full = read_project_memory(tmp_path, max_chars=10_000)
    assert full["truncated"] is False
    assert full["days"] == ["2026-11-07", "2026-11-06"]
    assert full["chars"] == len(newer) + len(older)
    assert full["updated"] == "2026-11-07 09:30:00"
    assert full["excerpt"].index("## 2026-11-07") < full["excerpt"].index("## 2026-11-06")
    assert full["excerpt"].endswith("昨天的记录")

    first_line = "## 2026-11-07"
    whole = read_project_memory(tmp_path, max_chars=len(first_line))
    assert whole["truncated"] is True
    assert whole["excerpt"] == first_line

    partial = read_project_memory(tmp_path, max_chars=len(first_line) + 6)
    assert partial["truncated"] is True
    assert partial["excerpt"].startswith(first_line)
    assert len(partial["excerpt"]) <= len(first_line) + 6
    assert partial["excerpt"] != whole["excerpt"]

    empty = read_project_memory(tmp_path, max_chars=0)
    assert empty["excerpt"] == ""
    assert empty["truncated"] is True


def test_a_legacy_single_file_is_read_until_it_is_converted(tmp_path: Path):
    """A read-only checkout written by the previous layout keeps its context."""
    legacy = single_file_memory_path(tmp_path)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text(generated_memory_text("2026-11-01"), encoding="utf-8")

    result = read_project_memory(tmp_path)

    assert result["exists"] is True
    assert result["legacy"] is True
    assert result["path"] == str(legacy)
    assert result["days"] == []
    assert result["chars"] == len(generated_memory_text("2026-11-01"))
    assert result["excerpt"].startswith("## 2026-11-01")


# ── writing the day records ─────────────────────────────────────────────


def test_render_memory_day_has_the_expected_shape(tmp_path: Path):
    text = generated_memory_text(
        "2026-11-07",
        updated="2026-11-07 10:00:00",
        entries=["- `10:00` （note）记录"],
    )

    assert text.startswith(PROJECT_SUMMARY_MARKER + "\n")
    assert "# 项目摘要：Project A · 2026-11-07" in text
    assert "> 项目 ID：`proj-a` · 由 dsh-memory 自动维护 · 更新于 2026-11-07 10:00:00" in text
    assert "## 2026-11-07" in text
    assert "- `10:00` （note）记录" in text
    assert text.endswith("\n")
    assert "\r" not in text


def test_write_memory_files_is_atomic_lf_and_skips_unchanged(tmp_path: Path):
    days = {
        "2026-11-07": generated_memory_text("2026-11-07"),
        "2026-11-06": generated_memory_text("2026-11-06"),
    }
    written = write_memory_files(tmp_path, days)
    assert sorted(Path(p).name for p in written) == ["2026-11-06.md", "2026-11-07.md"]

    path = day_memory_path(tmp_path, "2026-11-07")
    raw = path.read_bytes()
    assert b"\r\n" not in raw
    assert raw.decode("utf-8") == days["2026-11-07"]
    # No scratch file is left behind by the atomic replace.
    assert not list(memory_dir(tmp_path).glob("*.tmp"))

    # Nothing changed: no file is rewritten (the mtime stays put).
    stat = path.stat()
    assert write_memory_files(tmp_path, days) == []
    assert path.stat().st_mtime_ns == stat.st_mtime_ns

    changed = dict(days)
    changed["2026-11-07"] = generated_memory_text(
        "2026-11-07", entries=["- `11:00` （fix）新增"]
    )
    assert write_memory_files(tmp_path, changed) == [str(path)]
    assert "新增" in path.read_text(encoding="utf-8")


def test_a_day_without_active_records_is_deleted_only_when_known(tmp_path: Path):
    write_memory_file(tmp_path, generated_memory_text("2026-11-01"), "2026-11-01")
    write_memory_file(tmp_path, generated_memory_text("2026-11-02"), "2026-11-02")
    write_memory_file(tmp_path, generated_memory_text("2026-10-01"), "2026-10-01")
    (memory_dir(tmp_path) / "2026-10-02.md").write_text("# 手写\n", encoding="utf-8")

    written = write_memory_files(
        tmp_path,
        {"2026-11-02": generated_memory_text("2026-11-02")},
        known_days={"2026-11-01", "2026-11-02"},
    )

    assert written == []
    # 11-01 was a known day with no active records any more -> deleted.
    assert not day_memory_path(tmp_path, "2026-11-01").exists()
    assert day_memory_path(tmp_path, "2026-11-02").exists()
    # A date the project never knew (another project id sharing the checkout)
    # and a hand-written file both survive.
    assert day_memory_path(tmp_path, "2026-10-01").exists()
    assert (memory_dir(tmp_path) / "2026-10-02.md").exists()


def test_write_memory_files_removes_both_legacy_layouts_when_marked(tmp_path: Path):
    single = single_file_memory_path(tmp_path)
    single.parent.mkdir(parents=True, exist_ok=True)
    single.write_text(generated_memory_text("2026-11-01"), encoding="utf-8")
    root_legacy = legacy_memory_path(tmp_path)
    root_legacy.write_text(
        f"{PROJECT_SUMMARY_MARKER}\n# 项目摘要：旧位置\n\n- `09:00` 旧工作\n",
        encoding="utf-8",
    )

    write_memory_files(tmp_path, {"2026-11-07": generated_memory_text("2026-11-07")})

    assert day_memory_path(tmp_path, "2026-11-07").is_file()
    assert not single.exists()
    assert not root_legacy.exists()


def test_a_hand_written_legacy_file_survives_the_write(tmp_path: Path):
    single = single_file_memory_path(tmp_path)
    single.parent.mkdir(parents=True, exist_ok=True)
    handwritten_single = "# 我自己的笔记\n- 不是生成的文件\n"
    single.write_text(handwritten_single, encoding="utf-8")
    root_legacy = legacy_memory_path(tmp_path)
    handwritten_root = "# 我的根笔记\n- 不能删除\n"
    root_legacy.write_text(handwritten_root, encoding="utf-8")

    write_memory_files(tmp_path, {"2026-11-07": generated_memory_text("2026-11-07")})

    assert single.read_text(encoding="utf-8") == handwritten_single
    assert root_legacy.read_text(encoding="utf-8") == handwritten_root


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


# ── legacy layout migration ─────────────────────────────────────────────


def test_write_summaries_removes_a_generated_legacy_root_file(
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

    files = list_memory_files(root)
    assert len(files) == 1
    assert files[0].parent == memory_dir(root)
    assert files[0].suffix == ".md" and len(files[0].stem) == 10
    assert written == [str(files[0])]
    assert "迁移到 .agents 目录" in files[0].read_text(encoding="utf-8")
    assert not legacy.exists()

    # The rewritten file is readable by the same excerpt path the host uses.
    info = read_project_memory(root)
    assert info["exists"] is True
    assert info["excerpt"].startswith("## ")
    assert "迁移到 .agents 目录" in info["excerpt"]
    assert PROJECT_SUMMARY_MARKER not in info["excerpt"]


def test_write_summaries_converts_the_single_file_layout(
    tmp_path: Path, memory, project: str
):
    """The previous ``.agents/memory/MEMORY.md`` is replaced by day files."""
    root = tmp_path / "repo"
    root.mkdir()
    legacy = single_file_memory_path(root)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text(generated_memory_text("2026-11-01"), encoding="utf-8")
    memory.ensure_project(project, display_name="Project A", root_path=str(root))
    memory.remember(project_id=project, summary="新布局的第一条记录", event_type="note")

    write_project_summaries(memory)

    assert not legacy.exists()
    files = list_memory_files(root)
    assert len(files) == 1
    assert "新布局的第一条记录" in files[0].read_text(encoding="utf-8")
    assert read_project_memory(root)["legacy"] is False


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

    files = list_memory_files(root)
    assert files and "新位置的工作" in files[0].read_text(encoding="utf-8")
    assert legacy.read_text(encoding="utf-8") == handwritten
