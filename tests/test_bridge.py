"""Bridge-level regressions.

These cover failure modes that only show up on the wire or on re-import: a bad
request must never take the serving process down, and the backup parser has to
agree with what the exporter actually writes.
"""

from __future__ import annotations

import json
from pathlib import Path

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


def _seeded_home(tmp_path) -> Path:
    """A real database under ``tmp_path`` with one memory in it.

    Seeded with the *default* config: ``handle`` re-opens the file with its own
    config, and a mismatched embedding dim is refused rather than migrated.
    """
    home = tmp_path / "home"
    memory = MemorySystem(MemoryConfig.for_home(home))
    try:
        memory.ensure_project("proj-a", display_name="Project A")
        memory.remember(project_id="proj-a", summary="a durable fact", event_type="note")
    finally:
        memory.close()
    return home


def test_backup_export_stays_inline_when_it_fits(tmp_path):
    home = _seeded_home(tmp_path)
    response = handle(
        {"id": 1, "command": "backup.export", "payload": {"home": str(home), "project_id": "proj-a"}}
    )

    assert response["ok"] is True, response
    result = response["result"]
    assert result["inline"] is True
    assert "a durable fact" in result["markdown"]
    assert "path" not in result


def test_backup_export_spills_to_a_file_instead_of_exceeding_the_wire_cap(tmp_path, monkeypatch):
    """A big backup must not fail just because one envelope cannot carry it.

    ``_serve_loop`` replaces an oversized response with
    ``response_too_large``; the export then failed with "narrow the request",
    which is impossible for a backup (it is the whole store by definition).
    The command already knew how to write a file, so it now falls back to that
    instead of handing back markdown the wire will drop.
    """
    from memory_system import bridge

    home = _seeded_home(tmp_path)
    monkeypatch.setattr(bridge, "MAX_RESPONSE_CHARS", 512)

    response = handle(
        {"id": 1, "command": "backup.export", "payload": {"home": str(home), "project_id": "proj-a"}}
    )

    assert response["ok"] is True, response
    result = response["result"]
    assert result["inline"] is False
    assert "markdown" not in result
    target = Path(result["path"])
    assert target.parent == home / "exports"
    assert target.exists()
    # The spilled file is a real backup, not just a transport detail.
    parsed = parse_backup_markdown(target.read_text(encoding="utf-8"))
    assert [item["summary"] for item in parsed["memories"]] == ["a durable fact"]
    # And the envelope that reports it fits the cap it had to respect.
    assert len(json.dumps(response, ensure_ascii=False)) <= 512


def test_backup_restore_reports_a_missing_file_as_a_client_error(tmp_path):
    """A path the caller chose is a bad request, not an internal failure.

    ``backup.restore`` read the file directly, so a missing one surfaced as
    ``FileNotFoundError`` -> code ``internal``: a typo in a path looked like a
    bug in the memory store, and the plugin answered it with HTTP 200.
    """
    missing = tmp_path / "exports" / "missing.md"
    response = handle(
        {
            "id": 1,
            "command": "backup.restore",
            "payload": {"home": str(tmp_path), "path": str(missing), "project_id": "p"},
        }
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "bad_request"
    assert "missing.md" in response["error"]["message"]


def test_backup_export_reports_an_unwritable_target_as_a_client_error(tmp_path):
    home = _seeded_home(tmp_path)
    blocker = home / "exports" / "blocker"
    blocker.mkdir(parents=True)
    # A directory where the file should go: mkdir succeeds, write_text fails.
    (blocker / "backup.md").mkdir()

    response = handle(
        {
            "id": 1,
            "command": "backup.export",
            "payload": {"home": str(home), "path": str(blocker / "backup.md")},
        }
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "bad_request"
    assert "blocker" in response["error"]["message"]


def test_backup_export_refuses_a_path_outside_the_store(tmp_path):
    """The store directory is the only tree a backup may be written into.

    ``backup.export`` forwarded ``path`` verbatim, so a caller (a settings-page
    body, a CLI payload, or a model tool's extra argument) could overwrite any
    file the harness user can write.
    """
    home = _seeded_home(tmp_path)
    outside = tmp_path / "outside" / "INJECTED.md"

    response = handle(
        {"id": 1, "command": "backup.export", "payload": {"home": str(home), "path": str(outside)}}
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "bad_request"
    assert not outside.exists()


def test_backup_export_refuses_a_traversal_out_of_the_store(tmp_path):
    home = _seeded_home(tmp_path)
    traversal = home / "exports" / ".." / ".." / "escaped.md"

    response = handle(
        {"id": 1, "command": "backup.export", "payload": {"home": str(home), "path": str(traversal)}}
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "bad_request"
    assert not (tmp_path / "escaped.md").exists()


def test_backup_restore_refuses_a_file_outside_the_store(tmp_path):
    """``backup.restore`` must not import an arbitrary local file."""
    home = _seeded_home(tmp_path)
    secret = tmp_path / "secret.md"
    secret.write_text("## 记忆条目\n\n- [ ] `ep_x` `active` `note` 重要度 0.50 · 2026-01-01 00:00\n", encoding="utf-8")

    response = handle(
        {"id": 1, "command": "backup.restore", "payload": {"home": str(home), "path": str(secret)}}
    )

    assert response["ok"] is False
    assert response["error"]["code"] == "bad_request"
    assert "outside" in response["error"]["message"]


def test_backup_round_trips_through_the_guard(tmp_path):
    """A file inside the store still exports and restores."""
    from memory_system import bridge

    home = _seeded_home(tmp_path)
    target = home / "manual-backup.md"
    exported = handle(
        {"id": 1, "command": "backup.export", "payload": {"home": str(home), "path": str(target)}}
    )
    assert exported["ok"] is True, exported
    assert target.exists()

    memory = bridge.open_memory(bridge.Scope.from_payload({"home": str(home)}))
    with memory as opened:
        opened.store.execute("DELETE FROM l2_episodes")
    restored = handle(
        {"id": 2, "command": "backup.restore", "payload": {"home": str(home), "path": str(target), "project_id": "proj-a"}}
    )
    assert restored["ok"] is True, restored
    assert restored["result"]["imported"] == 1


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


def test_serve_caches_systems_per_scope_and_closes_on_exit(tmp_path):
    """Opening rebuilt MemorySystem + reran the startup probe per request;
    serve() keeps one per {home, db_path, preset} scope instead, and closes
    them all when the loop ends."""
    from memory_system import bridge

    made: list[Any] = []

    class CountingSystem(bridge.MemorySystem):
        def __init__(self, config):
            super().__init__(config)
            made.append(self)

        closed = 0

        def close(self):
            CountingSystem.closed += 1
            super().close()

    monkeypatch_ = pytest.MonkeyPatch()
    monkeypatch_.setattr(bridge, "MemorySystem", CountingSystem)
    try:
        replies = _serve(
            [
                {"id": "a", "command": "settings.get", "payload": {}},
                {"id": "b", "command": "settings.get", "payload": {}},
                {
                    "id": "c",
                    "command": "settings.get",
                    "payload": {"db_path": str(tmp_path / "other.db")},
                },
            ]
        )
    finally:
        monkeypatch_.undo()

    assert [r["id"] for r in replies] == ["a", "b", "c"]
    assert all(r["ok"] for r in replies), replies
    # a and b share one scope -> one system; c differs -> its own.
    assert len(made) == 2
    assert CountingSystem.closed == 2  # teardown closed both


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


# ── error codes for an unknown memory id ────────────────────────────────
#
# A caller routes on ``code``: "the thing you named is not here" (not_found)
# and "your payload is malformed" (validation) need different handling, so
# every notepad command that takes an id must agree on the first one.


@pytest.mark.parametrize(
    ("command", "payload"),
    [
        ("memory.get", {"memory_id": "ep_missing"}),
        ("memory.forget", {"memory_id": "ep_missing"}),
        ("memory.restore", {"memory_id": "ep_missing"}),
        ("memory.update", {"memory_id": "ep_missing", "patch": {"importance": 0.5}}),
    ],
)
def test_unknown_memory_id_reports_not_found(capture_home, command, payload):
    reply = handle(
        {"id": "t", "command": command, "payload": {"home": capture_home, **payload}}
    )
    assert reply["ok"] is False
    assert reply["error"]["code"] == "not_found", reply["error"]
    assert "not found" in reply["error"]["message"]