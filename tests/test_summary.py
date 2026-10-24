"""Digest, profile, notepad, export and the host bridge wire."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from memory_system import MemoryConfig, MemorySystem
from memory_system.bridge import handle, parse_backup_markdown, resolve_project_id
from memory_system.summary import (
    AUTO_MODE,
    BACKUP_MARKER,
    DEFAULT_LENGTH,
    LENGTH_MAX,
    LENGTH_MIN,
    LENGTH_PRESETS,
    DigestService,
    MemoryNotepad,
    clip_to_budget,
    coerce_length,
    export_markdown,
    nearest_preset,
)


@pytest.fixture()
def service(memory: MemorySystem, project: str) -> DigestService:
    return DigestService(memory)


# ── length budget ───────────────────────────────────────────────────────


def test_length_presets_and_bounds():
    assert LENGTH_PRESETS == (300, 500, 800, 1_000, 1_500, 2_000, 3_000)
    assert LENGTH_MIN == 300 and LENGTH_MAX == 3_000
    for preset in LENGTH_PRESETS:
        assert coerce_length(preset) == preset
    for bad in (LENGTH_MIN - 1, LENGTH_MAX + 1, "abc", None, True):
        with pytest.raises(Exception):
            coerce_length(bad)


def test_legacy_large_length_migrates_to_nearest_preset():
    # Budgets stored under the old (100_000-character) grid snap onto presets.
    assert nearest_preset(100_000) == 3_000
    assert nearest_preset(800) == 800
    assert nearest_preset(0) == 300
    assert nearest_preset(1_200) == 1_000


def test_clip_to_budget_keeps_whole_lines():
    text = "\n".join(f"line {i} " + "x" * 40 for i in range(100))
    clipped, truncated = clip_to_budget(text, 120)
    assert truncated is True
    assert len(clipped) <= 120
    assert "…（已按预算截断）" in clipped
    kept, truncated_short = clip_to_budget("short", 120)
    assert (kept, truncated_short) == ("short", False)


def test_settings_round_trip(service: DigestService):
    assert service.settings().length == DEFAULT_LENGTH == 1_000
    assert service.set_length(500).length == 500
    # Automatic generation is fixed to idle; there is no switch to turn off.
    assert service.settings().mode == AUTO_MODE == "idle"
    assert service.set_mode("debounced").mode == AUTO_MODE
    assert service.set_mode("off").mode == AUTO_MODE


# ── profile ─────────────────────────────────────────────────────────────


def test_profile_is_stored_and_anchored(service: DigestService, project: str):
    service.set_profile("# 用户画像\n- 偏好中文回答")
    anchors = service.anchors(project_id=project)
    assert anchors["profile"]["chars"] > 0
    assert "memory_profile_read" in anchors["text"]
    # The anchor carries counts only, never the profile body.
    assert "偏好中文回答" not in anchors["text"]
    assert anchors["text"].startswith("@@dsh-memory 1")


def test_profile_too_long_is_refused(service: DigestService):
    with pytest.raises(Exception):
        service.set_profile("x" * 200_000)


# ── digest ──────────────────────────────────────────────────────────────


def test_plan_uses_memory_and_never_calls_a_model(service: DigestService, memory: MemorySystem, project: str):
    memory.remember(project_id=project, summary="chose sqlite for storage", importance=0.9, event_type="decision")
    request = service.plan(scope="project", project_id=project, length=1_500)
    assert request.target_chars == 1_500
    assert "chose sqlite for storage" in request.user
    assert request.materials["episodes"] == 1
    assert request.sources
    assert request.prompt_version >= 1
    # Same inputs, same prompt: the hash is the cache key a host can trust.
    again = service.plan(scope="project", project_id=project, length=1_500)
    assert again.prompt_hash == request.prompt_hash


def test_commit_clips_to_budget_and_keeps_the_newest(service: DigestService, project: str):
    service.set_length(2_000)
    record = service.commit(
        scope="project", project_id=project, text="A" * 5_000, reason="manual", generator="test"
    )
    assert record.status == "truncated"
    assert record.actual_chars <= 2_000
    assert record.estimated_tokens > 0
    assert service.latest(scope="project", project_id=project).digest_id == record.digest_id


def test_commit_rejects_empty_and_records_errors(service: DigestService, project: str):
    empty = service.commit(scope="project", project_id=project, text="   ")
    assert empty.status == "empty"
    broken = service.commit(scope="project", project_id=project, text="", error="boom")
    assert broken.status == "error"
    assert broken.error == "boom"
    # Failed generations are not offered as "the latest digest".
    latest = service.latest(scope="project", project_id=project)
    assert latest is None


def test_scopes_do_not_leak(service: DigestService, project: str):
    service.commit(scope="project", project_id=project, text="project only")
    assert service.latest(scope="project", project_id="other") is None
    assert service.latest(scope="global") is None
    service.commit(scope="global", project_id=None, text="global digest")
    assert service.latest(scope="global").content == "global digest"
    assert service.latest(scope="project", project_id=project).content == "project only"


def test_summary_anchor_reports_staleness(service: DigestService, project: str):
    record = service.commit(scope="project", project_id=project, text="## state\ndone")
    anchors = service.anchors(project_id=project)
    assert anchors["summary"]["digest_id"] == record.digest_id
    assert "memory_digest_read" in anchors["text"]
    # Force the age past the staleness threshold.
    service.store.execute(
        "UPDATE memory_digests SET created_at = '2000-01-01T00:00:00+00:00' WHERE digest_id = ?",
        (record.digest_id,),
    )
    assert service.anchors(project_id=project)["summary"]["stale"] is True


def test_anchor_is_empty_without_memory(service: DigestService, project: str):
    assert service.anchors(project_id=project)["text"] == ""


def test_global_anchor_falls_back_to_project_digest(service: DigestService, project: str):
    """A global anchor must not blank out the project digest."""
    record = service.commit(scope="project", project_id=project, text="## project\nkeep me")
    assert service.latest(scope="global") is None

    anchors = service.anchors(project_id=project, scope="global")
    assert anchors["summary"] is not None
    assert anchors["summary"]["digest_id"] == record.digest_id
    assert "memory_digest_read" in anchors["text"]

    # Once a global digest exists, it takes over.
    global_record = service.commit(scope="global", project_id=None, text="## global\nall projects")
    anchors = service.anchors(project_id=project, scope="global")
    assert anchors["summary"]["digest_id"] == global_record.digest_id


# ── notepad ─────────────────────────────────────────────────────────────


def test_memory_edit_updates_text_importance_and_index(memory: MemorySystem, project: str):
    created = memory.remember(project_id=project, summary="old summary", importance=0.3)
    notepad = MemoryNotepad(memory)
    updated = notepad.update(
        created["memory_id"],
        {"summary": "old summary", "importance": 0.9, "tags": ["架构", "架构", " "], "outcome": "done"},
    )
    assert updated["importance"] == 0.9
    assert updated["tags"] == ["架构"]
    assert updated["outcome"] == "done"
    # The lexical index was rewritten, so search sees the edited text.
    hits = memory.l2.search("summary", project_ids=[project], reinforce=False)
    assert created["memory_id"] in {h.episode.memory_id for h in hits}


def test_memory_edit_accepts_tags_only(memory: MemorySystem, project: str):
    """Tags live in a meta blob, not a column, so they must not trip the
    empty-patch guard on their own."""
    created = memory.remember(project_id=project, summary="tagged later")
    notepad = MemoryNotepad(memory)
    assert notepad.update(created["memory_id"], {"tags": ["架构", "缓存"]})["tags"] == ["架构", "缓存"]
    # Clearing is an edit too, not a no-op.
    assert notepad.update(created["memory_id"], {"tags": []})["tags"] == []
    # A truly empty patch still fails.
    with pytest.raises(Exception):
        notepad.update(created["memory_id"], {})


def test_forget_is_soft_and_restorable(memory: MemorySystem, project: str):
    created = memory.remember(project_id=project, summary="temporary fact")
    notepad = MemoryNotepad(memory)
    assert notepad.forget(created["memory_id"])["state"] == "archived"
    listing = notepad.list(project_id=project, state="active")
    assert created["memory_id"] not in {i["memory_id"] for i in listing["items"]}
    archived = notepad.list(project_id=project, state="archived")
    assert created["memory_id"] in {i["memory_id"] for i in archived["items"]}
    assert notepad.restore(created["memory_id"])["state"] == "active"


def test_forget_and_restore_are_atomic(memory: MemorySystem, project: str, monkeypatch):
    """State and forgotten_at must land in one transaction.

    They were two commits: a failure between them left
    archived-but-unforgotten (search would resurface it as decay junk) or
    active-but-forgotten (unfindable, restore gone).
    """
    created = memory.remember(project_id=project, summary="atomic forget target")
    notepad = MemoryNotepad(memory)
    real_execute = memory.store.execute

    def failing_when(sql, params=()):
        if "forgotten_at" in sql:
            raise RuntimeError("simulated crash between the two writes")
        return real_execute(sql, params)

    monkeypatch.setattr(memory.store, "execute", failing_when)
    with pytest.raises(RuntimeError):
        notepad.forget(created["memory_id"])
    monkeypatch.undo()

    row = memory.store.query_one(
        "SELECT state, json_extract(meta, '$.forgotten_at') AS f FROM l2_episodes WHERE memory_id = ?",
        (created["memory_id"],),
    )
    assert row["state"] == "active"      # no half-forget
    assert row["f"] is None

    # Symmetrically: a restore that fails mid-way leaves the memory archived
    # and still marked - not resurrected while still invisible to recall.
    notepad.forget(created["memory_id"])
    monkeypatch.setattr(memory.store, "execute", failing_when)
    with pytest.raises(RuntimeError):
        notepad.restore(created["memory_id"])
    monkeypatch.undo()

    row = memory.store.query_one(
        "SELECT state, json_extract(meta, '$.forgotten_at') AS f FROM l2_episodes WHERE memory_id = ?",
        (created["memory_id"],),
    )
    assert row["state"] == "archived"
    assert row["f"] is not None


def test_forget_keeps_memory_out_of_digest_materials(memory: MemorySystem, project: str):
    """A user-forgotten memory must not re-enter the prompt path (the digest
    is the one thing a host injects), whatever recall does."""
    from memory_system.summary import MemoryNotepad, collect_materials

    kept = memory.remember(project_id=project, summary="keep-me: oracle driver upgraded to v23")
    gone = memory.remember(
        project_id=project,
        summary="gone-me: temporary debug token minted in staging",
        facts=[{"head": "debug-token", "relation": "located_in", "tail": "staging"}],
    )
    notepad = MemoryNotepad(memory)
    notepad.forget(gone["memory_id"])
    materials = collect_materials(memory, scope="project", project_id=project, material_char_budget=20_000)
    summaries = " ".join(e["summary"] for e in materials.episodes)
    assert "keep-me:" in summaries
    assert "gone-me:" not in summaries
    assert all(e["memory_id"] != gone["memory_id"] for e in materials.episodes)
    # The edge justifying the forgotten episode must not surface either.
    assert not any(f["head"] == "debug-token" for f in materials.facts)
    # Restoring brings everything back.
    notepad.restore(gone["memory_id"])
    materials = collect_materials(memory, scope="project", project_id=project, material_char_budget=20_000)
    assert any(e["memory_id"] == gone["memory_id"] for e in materials.episodes)


def test_memory_update_validates(memory: MemorySystem, project: str):
    created = memory.remember(project_id=project, summary="x")
    notepad = MemoryNotepad(memory)
    for patch in ({"summary": "  "}, {"importance": 2}, {"state": "gone"}, {}):
        with pytest.raises(Exception):
            notepad.update(created["memory_id"], patch)


# ── export / restore ────────────────────────────────────────────────────


def test_export_markdown_round_trips(memory: MemorySystem, project: str):
    DigestService(memory).set_profile("# 画像\n- 中文用户")
    DigestService(memory).commit(scope="project", project_id=project, text="## 摘要\n内容")
    memory.remember(project_id=project, summary="使用 sqlite-vec 做向量检索", event_type="decision")
    memory.remember(project_id=project, summary="修复了 auth.ts 的登录 bug", event_type="fix", outcome="success")

    markdown = export_markdown(memory)
    assert "## 用户画像" in markdown
    assert "中文用户" in markdown
    assert "## 记忆摘要" in markdown
    assert "使用 sqlite-vec 做向量检索" in markdown
    assert f"<!--{BACKUP_MARKER}:{{" in markdown

    parsed = parse_backup_markdown(markdown)
    assert parsed["header"]["version"] == 1
    assert "中文用户" in parsed["profile"]
    summaries = [m["summary"] for m in parsed["memories"]]
    assert "使用 sqlite-vec 做向量检索" in summaries
    assert len(parsed["memories"]) == 2


def test_restore_imports_into_a_fresh_database(memory: MemorySystem, project: str, tmp_path: Path):
    memory.remember(project_id=project, summary="第一个事实", event_type="decision")
    DigestService(memory).set_profile("画像内容")
    markdown = export_markdown(memory)

    # Restore into a separate database through the bridge. ``home`` must be
    # pinned: without it the bridge resolves the real ``~/.dsh/memory`` and the
    # test would write into the developer's live store.
    home = str(tmp_path / "restore")
    request = {
        "command": "backup.restore",
        "payload": {"home": home, "markdown": markdown, "project_id": project, "dry_run": True},
    }
    preview = handle({**request, "id": "1"})
    assert preview["ok"], preview
    assert preview["result"]["planned"] == 1
    assert preview["result"]["imported"] == 0

    done = handle({**request, "id": "2", "payload": {**request["payload"], "dry_run": False}})
    assert done["ok"], done
    assert done["result"]["imported"] == 1
    assert done["result"]["profile_restored"] is True
    # A restore must actually write: reporting an import without a row is the
    # silent-drop bug a wrapping transaction used to cause. Read the *restored*
    # store, not the source one — asserting on ``memory`` here passed even when
    # the bridge wrote somewhere else entirely.
    with MemorySystem(MemoryConfig.for_home(home)) as restored:
        assert restored.store.scalar("SELECT count(*) FROM l2_episodes") == 1
        assert restored.store.scalar("SELECT summary FROM l2_episodes") == "第一个事实"


# ── bridge ──────────────────────────────────────────────────────────────


def test_bridge_unknown_command_answers_on_the_wire():
    response = handle({"id": "x", "command": "nope.nope", "payload": {}})
    assert response["ok"] is False
    assert response["error"]["code"] == "unknown_command"


def test_bridge_status_reports_project(tmp_path: Path):
    response = handle(
        {
            "id": "s",
            "command": "status",
            "payload": {"home": str(tmp_path / "mem"), "cwd": str(tmp_path), "display_name": "T"},
        }
    )
    assert response["ok"], response
    result = response["result"]
    assert result["project_id"] == resolve_project_id(str(tmp_path))
    assert result["settings"]["length"] == DEFAULT_LENGTH
    assert result["probe"]["provider"]


def test_bridge_digest_flow(tmp_path: Path):
    home = str(tmp_path / "mem")
    base = {"home": home, "project_id": "demo"}
    plan = handle({"id": "1", "command": "digest.plan", "payload": {**base, "length": 1_500}})
    assert plan["ok"], plan
    request = plan["result"]
    commit = handle(
        {
            "id": "2",
            "command": "digest.commit",
            "payload": {
                **base,
                "text": "## 项目状态\n一切正常",
                "target_chars": request["target_chars"],
                "sources": request["sources"],
                "generator": "unit-test",
            },
        }
    )
    assert commit["ok"], commit
    assert commit["result"]["digest"]["status"] == "ok"
    view = handle({"id": "3", "command": "digest.view", "payload": base})
    assert view["ok"], view
    assert "一切正常" in view["result"]["digest"]["content"]
    assert view["result"]["history"]


def test_bridge_profile_accepts_both_keys(tmp_path: Path):
    home = str(tmp_path / "mem")
    written = handle(
        {"id": "1", "command": "profile.write", "payload": {"home": home, "profile": "# 画像\n- 中文"}}
    )
    assert written["ok"], written
    assert written["result"]["chars"] > 0
    read = handle({"id": "2", "command": "profile.read", "payload": {"home": home}})
    assert read["result"]["content"] == "# 画像\n- 中文"


def test_serve_survives_a_legacy_console_codepage(tmp_path: Path):
    """CJK must survive the pipe on a GBK console (regression: mojibake)."""
    home = str(tmp_path / "mem")
    requests = [
        {"id": "1", "command": "profile.write", "payload": {"home": home, "content": "# 画像\n- 中文"}},
        {"id": "2", "command": "profile.read", "payload": {"home": home}},
    ]
    wire = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in requests).encode("utf-8")
    proc = subprocess.run(
        [sys.executable, "-W", "ignore", "-m", "memory_system", "--serve"],
        input=wire,
        capture_output=True,
        cwd=str(Path(__file__).resolve().parents[1]),
        env={"PYTHONIOENCODING": "gbk", "PATH": ""},
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    lines = [json.loads(line) for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]
    assert [line["id"] for line in lines] == ["1", "2"]
    assert lines[1]["result"]["content"] == "# 画像\n- 中文"


def test_resolve_project_prefers_git_remote(tmp_path: Path):
    repo = tmp_path / "checkout"
    (repo / ".git").mkdir(parents=True)
    (repo / ".git" / "config").write_text(
        '[remote "origin"]\n\turl = git@github.com:acme/web.git\n', encoding="utf-8"
    )
    nested = repo / "src" / "pkg"
    nested.mkdir(parents=True)
    assert resolve_project_id(str(nested)) == "acme-web"
    other = tmp_path / "plain"
    other.mkdir()
    # No remote: the path is the identity (slugified, last 64 chars).
    assert "plain" in resolve_project_id(str(other))
    assert any(ch.isalpha() for ch in resolve_project_id(str(other)))