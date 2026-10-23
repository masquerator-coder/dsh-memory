"""Bridge-level regressions.

These cover failure modes that only show up on the wire or on re-import: a bad
request must never take the serving process down, and the backup parser has to
agree with what the exporter actually writes.
"""

from __future__ import annotations

import json

import pytest

from memory_system import MemoryConfig, MemorySystem
from memory_system.bridge import (
    _git_remote_from_config,
    _strip_label,
    handle,
    parse_backup_markdown,
    serve,
)
from memory_system.summary import export_markdown


# ── backup parsing ──────────────────────────────────────────────────────


def test_strip_label_keeps_colons_inside_the_value():
    # Only the leading label is removed; the value's own ":" stays intact.
    assert _strip_label("结果: 错误: 超时", "结果") == "错误: 超时"
    assert _strip_label("结果：耗时 3s", "结果") == "耗时 3s"
    assert _strip_label("项目: `p1`", "项目") == "`p1`"


def test_parse_backup_keeps_outcome_with_colon():
    text = "\n".join(
        [
            "## 记忆条目",
            "",
            "### 项目 proj-a",
            "",
            "- [ ] `ep_1` `active` `note`",
            "  - a memory",
            "  - 结果: 错误: 超时",
        ]
    )
    parsed = parse_backup_markdown(text)
    assert parsed["memories"][0]["summary"] == "a memory"
    assert parsed["memories"][0]["outcome"] == "错误: 超时"


def test_parse_backup_ignores_unterminated_marker_line():
    # A body line that merely starts like the header comment must stay content,
    # not be swallowed as (empty, unparseable) header JSON.
    text = "\n".join(
        [
            "<!--dsh-memory-backup not actually closed",
            "## 记忆条目",
            "",
            "### 项目 proj-a",
            "",
            "- [ ] `ep_1` `active` `note`",
            "  - keeps its text",
        ]
    )
    parsed = parse_backup_markdown(text)
    assert parsed["header"] == {}
    assert parsed["memories"][0]["summary"] == "keeps its text"


def test_export_round_trips_through_the_parser():
    """The parser must read exactly what the exporter writes."""
    config = MemoryConfig()
    config.embedding.dim = 128
    memory = MemorySystem(config)
    try:
        memory.ensure_project("proj-a", display_name="Project A")
        memory.remember(project_id="proj-a", summary="a durable fact", event_type="note")
        text = export_markdown(memory)
    finally:
        memory.close()

    parsed = parse_backup_markdown(text)
    assert parsed["header"]["format"] == "dsh-memory-backup"
    assert [item["summary"] for item in parsed["memories"]] == ["a durable fact"]
    assert parsed["memories"][0]["project_id"] == "proj-a"


# ── git remote resolution ───────────────────────────────────────────────


def _write_git_config(tmp_path, body: str):
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    (git_dir / "config").write_text(body, encoding="utf-8")
    return tmp_path


def test_git_remote_prefers_origin(tmp_path):
    root = _write_git_config(
        tmp_path,
        '[remote "upstream"]\n\turl = git@github.com:me/fork.git\n'
        '[remote "origin"]\n\turl = git@github.com:me/repo.git\n',
    )
    assert _git_remote_from_config(root) == "git@github.com:me/repo.git"


def test_git_remote_falls_back_to_another_remote(tmp_path):
    """A fork with only `upstream` must still resolve to one project id."""
    root = _write_git_config(
        tmp_path,
        '[remote "upstream"]\n\turl = git@github.com:me/repo.git\n',
    )
    assert _git_remote_from_config(root) == "git@github.com:me/repo.git"


def test_git_remote_ignores_url_lookalike_keys(tmp_path):
    root = _write_git_config(
        tmp_path,
        '[remote "origin"]\n\turlx = nope\n\turl = git@github.com:me/repo.git\n',
    )
    assert _git_remote_from_config(root) == "git@github.com:me/repo.git"


# ── memory.capture idempotency ──────────────────────────────────────────
#
# These go through ``handle`` exactly as the host does, so they must pin the
# store explicitly: ``handle`` resolves an absent ``home`` to the real
# ``~/.dsh/memory`` and would write into the developer's live database.


@pytest.fixture()
def capture_home(tmp_path):
    return str(tmp_path / "memory")


def _capture(home: str, **payload) -> dict:
    reply = handle(
        {
            "id": "t",
            "command": "memory.capture",
            "payload": {"home": home, "project_id": "p", **payload},
        }
    )
    assert reply["ok"], reply.get("error")
    return reply["result"]


def _rows(home: str, project: str = "p") -> int:
    reply = handle(
        {
            "id": "t",
            "command": "memory.list",
            "payload": {"home": home, "project_id": project, "limit": 1},
        }
    )
    assert reply["ok"], reply.get("error")
    return reply["result"]["total"]


def test_capture_without_seq_still_absorbs_a_replay(capture_home):
    """A missing ``seq`` must not cost retry protection.

    The key falls back to ``(session_key, text)``, so a byte-identical replay
    in the same session is merged instead of inflating the store.
    """
    text = "用户要求把记忆系统的备份恢复路径改好"
    first = _capture(capture_home, text=text, session_key="s1")
    second = _capture(capture_home, text=text, session_key="s1")
    assert first["deduped"] is False and first["duplicate"] is False
    assert second["deduped"] is True and second["captured"] is None
    assert "text:" in first["dedupe_key"]
    assert _rows(capture_home) == 1


def test_capture_fallback_key_does_not_merge_different_text(capture_home):
    a = "用户要求把记忆系统的备份恢复路径改好"
    _capture(capture_home, text=a, session_key="s2")
    b = _capture(capture_home, text=a + "，另外还要写测试", session_key="s2")
    assert b["deduped"] is False
    assert _rows(capture_home) == 2


def test_capture_seq_dedupe_is_unchanged(capture_home):
    text = "回合 3 完成"
    first = _capture(capture_home, text=text, session_key="s3", seq=7)
    second = _capture(capture_home, text=text, session_key="s3", seq=7)
    assert first["deduped"] is False and second["deduped"] is True
    assert first["dedupe_key"] == "dsh.capture:s3:7"
    # 0 is a real sequence number, not a missing one.
    zero = _capture(capture_home, text=text, session_key="s4", seq=0)
    assert zero["dedupe_key"] == "dsh.capture:s4:0"
    assert _capture(capture_home, text=text, session_key="s4", seq=0)["deduped"] is True


def test_capture_reports_a_content_dedup_as_duplicate(capture_home):
    """``deduped`` means "the retry key hit"; ``duplicate`` means "no new row".

    Without a session key there is no retry key, yet the write path still
    merges identical text — the reply must not report that as a fresh write.
    """
    text = "无会话键的重复消息内容"
    first = _capture(capture_home, text=text)
    second = _capture(capture_home, text=text)
    assert first["dedupe_key"] is None
    assert first["duplicate"] is False
    assert second["duplicate"] is True
    assert _rows(capture_home) == 1


def test_capture_reports_a_genuinely_new_row(capture_home):
    """A near-miss must not be reported as a duplicate."""
    base = "用户要求把记忆系统的备份恢复路径改好，并且保留源项目不串味"
    _capture(capture_home, text=base, session_key="s5")
    other = _capture(capture_home, text=base.replace("源项目", "原项目"), session_key="s5")
    assert other["duplicate"] is False
    assert _rows(capture_home) == 2


def test_remember_report_is_opt_in(memory: MemorySystem, project: str):
    """Passing no ``report`` keeps the return value exactly as before."""
    plain = memory.remember(project_id=project, summary="不带 report 的写入")
    assert set(plain) == {"memory_id", "anchor_id", "facts"}
    report: dict = {}
    written = memory.remember(project_id=project, summary="带 report 的写入", report=report)
    assert report["reused"] is False
    again: dict = {}
    reused = memory.remember(project_id=project, summary="带 report 的写入", report=again)
    assert reused["memory_id"] == written["memory_id"]
    assert again["reused"] is True


# ── process survival ────────────────────────────────────────────────────


class _FakeReader:
    def __init__(self, lines: list[str]) -> None:
        self._payload = "".join(f"{line}\n" for line in lines)

    def readline(self) -> str:
        if not self._payload:
            return ""
        head, _, rest = self._payload.partition("\n")
        self._payload = rest
        return head + "\n"


class _FakeWriter:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def write(self, text: str) -> None:
        self.lines.append(text)

    def flush(self) -> None:
        return None


def _serve(lines: list[dict]) -> list[dict]:
    """Feed JSON lines through `serve` and collect its replies."""
    stdout = _FakeWriter()
    serve(stdin=_FakeReader([json.dumps(item, ensure_ascii=False) for item in lines]), stdout=stdout)
    return [json.loads(line) for line in stdout.lines]


def test_serve_survives_a_failing_command():
    """One bad request must answer with an error, then keep serving."""
    replies = _serve(
        [
            {"id": "a", "command": "this_command_does_not_exist", "payload": {}},
            {"id": "b", "command": "settings.get", "payload": {}},
        ]
    )
    assert len(replies) == 2
    assert replies[0]["id"] == "a"
    assert replies[0]["ok"] is False
    # The second request was still answered, so the loop did not exit.
    assert replies[1]["id"] == "b"
    assert replies[1]["ok"] is True


def test_serve_survives_an_unusable_scope():
    """A payload that breaks scope resolution must not end the loop either."""
    replies = _serve(
        [
            {"id": "a", "command": "settings.get", "payload": {"home": "\0bad"}},
            {"id": "b", "command": "settings.get", "payload": {}},
        ]
    )
    assert [r["id"] for r in replies] == ["a", "b"]
    assert replies[0]["ok"] is False
    assert replies[1]["ok"] is True