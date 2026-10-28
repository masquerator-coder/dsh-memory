"""Digest, profile, notepad, export and the host bridge wire."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from memory_system import FactInput, MemoryConfig, MemorySystem
from memory_system.bridge import handle, parse_backup_markdown, resolve_project_id
from memory_system.summary import (
    AUTO_MODE,
    BACKUP_MARKER,
    DEFAULT_LENGTH,
    DIGEST_PROJECT_LABEL_MAX,
    LENGTH_MAX,
    LENGTH_MIN,
    LENGTH_PRESETS,
    META_UPDATED,
    PROJECT_SUMMARY_FILE,
    PROJECT_SUMMARY_MARKER,
    DigestService,
    Materials,
    MemoryNotepad,
    _digest_label,
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


def test_settings_round_trip(service: DigestService):
    assert service.settings().length == DEFAULT_LENGTH == 1_000
    assert service.set_length(500).length == 500
    # Automatic generation is fixed to idle; there is no switch to turn off.
    assert service.settings().mode == AUTO_MODE == "idle"
    assert service.set_mode("debounced").mode == AUTO_MODE
    assert service.set_mode("off").mode == AUTO_MODE


def test_materials_share_the_budget_across_projects():
    """One busy project must not starve the others out of the prompt."""
    episodes = [
        {
            "created_at": f"2026-01-0{day}T0{hour}:00:00+00:00",
            "project_id": pid,
            "event_type": "fix",
            "importance": 0.8,
            "summary": f"{pid} work item {day}-{hour}",
            "outcome": "success",
        }
        for pid in ("proj-a", "proj-b")
        for day in (1, 2)
        for hour in (1, 2, 3, 4, 5, 6)
    ]
    materials = Materials(
        project_ids=["proj-a", "proj-b"],
        episodes=episodes,
        project_names={"proj-a": "Project A", "proj-b": "Project B"},
    )
    body = materials.render(max_chars=600)
    assert "## 项目：Project A（`proj-a`）" in body
    assert "## 项目：Project B（`proj-b`）" in body
    assert len(body) <= 600


def test_materials_only_contain_work_episodes():
    """The global digest is a work log, so its materials carry no profile,
    user requests or semantic facts that would invite lessons/preferences."""
    fields = set(Materials.__dataclass_fields__)
    assert "episodes" in fields
    assert not fields & {"profile", "user_texts", "facts"}


# ── profile ─────────────────────────────────────────────────────────────


def test_profile_is_stored_and_anchored(service: DigestService):
    service.set_profile("# 用户画像\n- 偏好中文回答")
    anchors = service.anchors()
    assert anchors["profile"]["chars"] > 0
    assert "memory_profile_read" in anchors["text"]
    # The anchor carries counts only, never the profile body.
    assert "偏好中文回答" not in anchors["text"]
    assert anchors["text"].startswith("@@dsh-memory 1")


def test_profile_too_long_is_refused(service: DigestService):
    with pytest.raises(Exception):
        service.set_profile("x" * 200_000)


# ── digest ──────────────────────────────────────────────────────────────


def test_plan_uses_all_projects_and_never_calls_a_model(
    service: DigestService, memory: MemorySystem, project: str
):
    memory.remember(project_id=project, summary="chose sqlite for storage", importance=0.9, event_type="decision")
    request = service.plan(length=1_500)
    assert request.scope == "global" and request.scope_ref is None
    assert request.target_chars == 1_500
    assert "chose sqlite for storage" in request.user
    assert request.materials["episodes"] == 1
    assert request.materials["projects"] == 1
    assert request.sources
    assert request.prompt_version >= 2
    # Same inputs, same prompt: the hash is the cache key a host can trust.
    again = service.plan(length=1_500)
    assert again.prompt_hash == request.prompt_hash


def test_budget_guides_generation_instead_of_clipping(service: DigestService):
    """A budget is an instruction to the model, not scissors on its output."""
    service.set_length(2_000)
    record = service.commit(text="A" * 5_000, reason="manual", generator="test")
    assert record.status == "ok"
    assert record.actual_chars == 5_000
    assert record.requested_chars == 2_000
    assert record.estimated_tokens > 0
    assert service.latest().digest_id == record.digest_id


def test_prompt_scales_detail_with_the_budget(service: DigestService):
    concise = service.plan(length=300)
    detailed = service.plan(length=3_000)
    assert "约 300 个字符" in concise.system
    assert "约 3000 个字符" in detailed.system
    # The budget is a whole-document cap, so the project count must not read as
    # a multiplier: each band says how many items *in total* to keep per project.
    assert "全文总字数" in detailed.system
    assert "≤800" in detailed.system and ">2000" in detailed.system


def test_project_heading_stays_small_against_the_budget():
    """Path-shaped project ids must not eat a small budget's fixed overhead."""
    long_pid = "c-users-fuqia-documents-aiworkspace-blender-render-pipeline"
    materials = Materials(
        project_ids=[long_pid],
        episodes=[
            {
                "created_at": "2026-01-01T01:00:00+00:00",
                "project_id": long_pid,
                "event_type": "fix",
                "importance": 0.8,
                "summary": "fixed the camera alignment",
                "outcome": "success",
            }
        ],
    )
    body = materials.render(max_chars=20_000)
    heading = next(line for line in body.splitlines() if line.startswith("## "))
    label = heading.split("（")[0].removeprefix("## 项目：")
    # The label shortens; the id stays verbatim so the model can echo the
    # heading as instructed and still name the project unambiguously.
    assert long_pid not in label
    assert len(label) <= DIGEST_PROJECT_LABEL_MAX
    assert f"`{long_pid}`" in heading
    assert "fixed the camera alignment" in body


def test_digest_label_keeps_a_short_name_verbatim():
    assert _digest_label("dsh-memory") == "dsh-memory"
    assert _digest_label("C:\\Users\\fuqia\\Documents\\OSpace") == "OSpace"
    assert len(_digest_label("a" * 40)) == DIGEST_PROJECT_LABEL_MAX


def test_short_labels_stay_distinct_for_path_shaped_ids():
    """Truncating the tail would collapse every project onto one label."""
    ids = [
        "c-users-fuqia-documents-aiworkspace-blender",
        "c-users-fuqia-documents-aiworkspace-ai",
        "c-users-fuqia-documents-aiworkspace-im-workspace",
        "c-users-fuqia-documents-workspace-08-1-26-27-1",
    ]
    labels = [_digest_label(pid) for pid in ids]
    assert len(set(labels)) == len(labels)
    assert all(len(label) <= DIGEST_PROJECT_LABEL_MAX for label in labels)


def test_commit_rejects_empty_and_records_errors(service: DigestService):
    empty = service.commit(text="   ")
    assert empty.status == "empty"
    broken = service.commit(text="", error="boom")
    assert broken.status == "error"
    assert broken.error == "boom"
    # Failed generations are not offered as "the latest digest".
    assert service.latest() is None


def test_failed_commit_leaves_the_updated_marker_alone(service: DigestService):
    """The marker must describe the digest the prompt shows, not the last try.

    A failed run still records its error row (that is the history), but moving
    ``memory.summary.updated_at`` for empty content made the settings page and
    `/health` report a digest that was never written.
    """
    good = service.commit(text="## state\nreal work")
    stamped = service.store.get_meta(META_UPDATED)
    assert stamped == good.created_at

    failed = service.commit(text="", error="模型调用失败：400")
    assert failed.status == "error"
    assert service.store.get_meta(META_UPDATED) == stamped
    assert service.latest().digest_id == good.digest_id

    # An empty generation is not "updated" either.
    service.commit(text="   ")
    assert service.store.get_meta(META_UPDATED) == stamped


def test_only_global_digests_are_generated_but_legacy_project_rows_read(service: DigestService, project: str):
    with pytest.raises(Exception):
        service.commit(scope="project", project_id=project, text="no longer generated")

    # Old backups may still carry project rows; they stay readable, but the
    # prompt anchor never surfaces them.
    legacy = service.import_digest(scope="project", project_id=project, content="legacy project")
    assert service.latest(scope="project", project_id=project).digest_id == legacy.digest_id
    assert service.anchors()["text"] == ""

    record = service.commit(text="global digest")
    assert service.latest().content == "global digest"
    assert service.anchors()["summary"]["digest_id"] == record.digest_id


def test_summary_anchor_reports_staleness(service: DigestService):
    record = service.commit(text="## state\ndone")
    anchors = service.anchors()
    assert anchors["summary"]["digest_id"] == record.digest_id
    assert "memory_digest_read" in anchors["text"]
    # Force the age past the staleness threshold.
    service.store.execute(
        "UPDATE memory_digests SET created_at = '2000-01-01T00:00:00+00:00' WHERE digest_id = ?",
        (record.digest_id,),
    )
    assert service.anchors()["summary"]["stale"] is True


def test_anchor_is_empty_without_memory(service: DigestService):
    assert service.anchors()["text"] == ""


def test_commit_writes_each_project_root_markdown(service: DigestService, memory: MemorySystem, tmp_path: Path):
    root = tmp_path / "repo"
    root.mkdir()
    memory.ensure_project("proj-md", display_name="Markdown Project", root_path=str(root))
    kept = memory.remember(
        project_id="proj-md",
        summary="实现了 DSH_MEMORY.md 导出",
        event_type="fix",
        outcome="success",
    )
    gone = memory.remember(project_id="proj-md", summary="临时调试记录")
    MemoryNotepad(memory).forget(gone["memory_id"])
    memory.remember(
        project_id="proj-md",
        summary="用户偏好 dark mode",
        event_type="preference",
    )

    service.commit(text="## 全局\n工作记录")

    path = root / PROJECT_SUMMARY_FILE
    content = path.read_text(encoding="utf-8")
    assert content.startswith(PROJECT_SUMMARY_MARKER)
    assert "Markdown Project" in content
    assert "实现了 DSH_MEMORY.md 导出" in content
    assert "临时调试记录" not in content
    assert "用户偏好 dark mode" not in content
    assert kept["memory_id"] != gone["memory_id"]


def test_bridge_memory_add_refreshes_the_project_markdown(tmp_path: Path):
    """A write through the bridge must update the checkout's own file.

    ``memory.remember`` registers the project id but knows nothing about the
    checkout, so without registering ``root_path`` first the project summary
    was skipped and ``DSH_MEMORY.md`` only caught up when some other command
    happened to pass through — while ``AGENTS.md`` tells every session to read
    it first.
    """
    repo = tmp_path / "checkout"
    (repo / ".git").mkdir(parents=True)
    home = str(tmp_path / "mem")

    remembered = handle(
        {
            "id": "1",
            "command": "memory.remember",
            "payload": {"home": home, "cwd": str(repo), "summary": "接入了记忆工具", "event_type": "note"},
        }
    )
    assert remembered["ok"], remembered
    content = (repo / PROJECT_SUMMARY_FILE).read_text(encoding="utf-8")
    assert "接入了记忆工具" in content


def test_project_markdown_stamp_follows_the_newest_record(tmp_path: Path):
    """The header time is the newest memory, not the moment the file was written.

    A wall-clock stamp made every ``digest.commit`` rewrite the file even when
    nothing had changed, which defeats the unchanged-file guard.
    """
    root = tmp_path / "repo"
    root.mkdir()
    memory = MemorySystem(MemoryConfig.for_home(tmp_path / "home"))
    try:
        memory.ensure_project("proj-stamp", display_name="Stamp", root_path=str(root))
        memory.remember(project_id="proj-stamp", summary="第一条", event_type="note")
        DigestService(memory).write_project_summaries(project_id="proj-stamp")
        path = root / PROJECT_SUMMARY_FILE
        first = path.read_text(encoding="utf-8")

        # Nothing new was written: a later commit must leave the file alone.
        DigestService(memory).commit(text="## 全局\n新摘要")
        assert path.read_text(encoding="utf-8") == first

        memory.remember(project_id="proj-stamp", summary="第二条", event_type="note")
        DigestService(memory).write_project_summaries(project_id="proj-stamp")
        second = path.read_text(encoding="utf-8")
        assert second != first
        assert "第二条" in second
        stamp = memory.store.query_one(
            "SELECT created_at FROM l2_episodes ORDER BY ord DESC LIMIT 1"
        )["created_at"]
        assert stamp[:19].replace("T", " ") in second
    finally:
        memory.close()


def test_bridge_project_registration_creates_the_markdown_file(tmp_path: Path):
    repo = tmp_path / "checkout"
    (repo / ".git").mkdir(parents=True)
    nested = repo / "src"
    nested.mkdir()
    home = str(tmp_path / "mem")
    project = handle(
        {"id": "1", "command": "projects", "payload": {"home": home, "cwd": str(nested)}}
    )
    assert project["ok"], project
    summary = repo / PROJECT_SUMMARY_FILE
    assert summary.is_file()
    assert "还没有记录任何工作" in summary.read_text(encoding="utf-8")


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


def test_memory_edit_reindexes_every_indexed_field(memory: MemorySystem, project: str):
    """The FTS body is a view of summary + event_type + participants.

    Rebuilding it from only the field that changed drops the other two out of
    lexical recall: editing a summary used to make the participants
    unsearchable, and an event_type-only edit never rebuilt the row at all, so
    the old type kept matching.
    """
    created = memory.remember(
        project_id=project,
        summary="checkout latency spiked",
        event_type="incident",
        participants=["stripe-webhook"],
    )
    notepad = MemoryNotepad(memory)

    def lexical(term: str) -> set[str]:
        return {mid for mid, _ in memory.l2._lexical_hits(term, [project], limit=10)}

    notepad.update(created["memory_id"], {"summary": "checkout latency spiked again"})
    assert created["memory_id"] in lexical("stripe-webhook")
    assert created["memory_id"] in lexical("incident")

    notepad.update(created["memory_id"], {"event_type": "postmortem"})
    assert created["memory_id"] in lexical("postmortem")
    assert created["memory_id"] not in lexical("incident")


def test_memory_edit_reembeds_the_new_text(memory: MemorySystem, project: str):
    """The stored vector is a view of the summary, so an edit must re-embed.

    ``update`` rewrote the text and the lexical index but left the vector
    alone: the memory kept answering semantic queries in its *old* wording,
    and the database then held a vector that was not the embedding of the
    summary stored next to it.
    """
    created = memory.remember(project_id=project, summary="database index tuning", importance=0.8)
    MemoryNotepad(memory).update(created["memory_id"], {"summary": "协议超时重试策略"})

    ordinal = memory.l2.get(created["memory_id"]).ordinal

    def distance(text: str) -> float:
        hits = dict(memory.store.vectors.knn("l2", memory.embeddings.embed_one(text), k=10))
        return hits[ordinal]

    assert distance("协议超时重试策略") == pytest.approx(0.0, abs=1e-6)
    assert distance("database index tuning") > 0.05


def test_memory_edit_refuses_to_duplicate_another_memory(memory: MemorySystem, project: str):
    """Editing a memory onto another's text must not create two rows.

    ``summary_hash`` is the key the write path dedups on. Before the guard, an
    edit could hand two rows the same hash: a later ``remember`` of that text
    merged into whichever row ``LIMIT 1`` happened to return, and recall showed
    the same sentence twice.
    """
    from memory_system.errors import ConflictError

    first = memory.remember(project_id=project, summary="原始文本 A", event_type="note")
    second = memory.remember(project_id=project, summary="原始文本 B", event_type="note")
    notepad = MemoryNotepad(memory)

    with pytest.raises(ConflictError, match=first["memory_id"]):
        notepad.update(second["memory_id"], {"summary": "原始文本 A"})

    hashes = {
        row["summary_hash"]
        for row in memory.store.query(
            "SELECT summary_hash FROM l2_episodes WHERE project_id = ?", (project,)
        )
    }
    assert len(hashes) == 2
    # The refused edit left the row untouched.
    assert notepad.get(second["memory_id"])["summary"] == "原始文本 B"


def test_memory_edit_accepts_its_own_text(memory: MemorySystem, project: str):
    """Re-saving a row's own summary (e.g. only importance changed) is not a clash."""
    created = memory.remember(project_id=project, summary="同一条文本", event_type="note")
    updated = MemoryNotepad(memory).update(
        created["memory_id"], {"summary": "同一条文本", "importance": 0.9}
    )
    assert updated["importance"] == 0.9


def test_duplicate_lookup_is_deterministic_across_identical_hashes(memory: MemorySystem, project: str):
    """A legacy store may still hold two rows sharing one hash.

    The merge must land on a fixed row (the newest) instead of whichever one
    SQLite visits first, which made a re-observation attach to a different
    memory on every call.
    """
    created = memory.remember(project_id=project, summary="部署命令是 make deploy", event_type="note")
    # Force the legacy shape: a second row with the same hash.
    duplicate = memory.remember(project_id=project, summary="部署命令变了", event_type="note")
    memory.store.execute(
        "UPDATE l2_episodes SET summary_hash = (SELECT summary_hash FROM l2_episodes WHERE memory_id = ?) "
        "WHERE memory_id = ?",
        (created["memory_id"], duplicate["memory_id"]),
    )

    first = memory.l2.find_duplicate(project, "部署命令是 make deploy")
    second = memory.l2.find_duplicate(project, "部署命令是 make deploy")
    assert first is not None and second is not None
    assert first.memory_id == second.memory_id


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
    materials = collect_materials(memory, material_char_budget=20_000)
    summaries = " ".join(e["summary"] for e in materials.episodes)
    assert "keep-me:" in summaries
    assert "gone-me:" not in summaries
    assert all(e["memory_id"] != gone["memory_id"] for e in materials.episodes)
    # Restoring brings everything back.
    notepad.restore(gone["memory_id"])
    materials = collect_materials(memory, material_char_budget=20_000)
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
    DigestService(memory).commit(text="## 摘要\n内容")
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
    # The digest and fact sections are part of the document, so they must be
    # readable as data: a restore used to see only profile + memory bullets and
    # silently drop both sections, losing the summaries and every belief.
    assert [d["content"] for d in parsed["digests"]] == ["## 摘要\n内容"]
    assert parsed["digests"][0]["scope"] == "global"
    assert parsed["digests"][0]["scope_ref"] is None
    assert len(parsed["facts"]) == 0


def test_export_pages_past_the_list_limit_and_keeps_dormant_rows(
    memory: MemorySystem, project: str
):
    """A backup is the fallback copy, so it must contain the whole corpus.

    Two silent caps used to shrink it: ``notepad.list`` returns at most 500
    rows per call and the export never paged, and it asked for ``state="active"``
    only -- so everything that had merely decayed below the recall threshold
    (dormant, still revivable) was left out of the file as well.
    """
    for i in range(600):
        memory.l2.add(project_id=project, summary=f"bulk note {i}", importance=0.5)
    rows = memory.store.query("SELECT memory_id FROM l2_episodes ORDER BY ord")
    oldest, dormant = rows[0]["memory_id"], rows[300]["memory_id"]
    memory.store.execute(
        "UPDATE l2_episodes SET state = 'dormant' WHERE memory_id = ?", (dormant,)
    )

    parsed = parse_backup_markdown(export_markdown(memory))
    exported = {item["memory_id"] for item in parsed["memories"]}
    assert len(exported) == 600  # not the first 500 the listing returned
    assert oldest in exported
    assert dormant in exported


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


def test_restore_imports_digest_history_and_facts(memory: MemorySystem, project: str, tmp_path: Path):
    """A round trip must carry the whole document, not only memory bullets.

    ``export_markdown`` writes digest history and the fact graph; the restore
    parser ignored both sections, so a backup that looked complete came back
    without a single summary or belief.
    """
    service = DigestService(memory)
    digest = service.commit(text="## 摘要\n索引选型已定")
    memory.l3.add_fact(project, FactInput(head="billing", relation="uses", tail="sqlite", confidence=0.9))
    markdown = export_markdown(memory)

    home = str(tmp_path / "restore-sections")
    done = handle(
        {
            "id": "1",
            "command": "backup.restore",
            "payload": {"home": home, "markdown": markdown, "project_id": project},
        }
    )
    assert done["ok"], done
    assert done["result"]["facts"] == {"planned": 1, "imported": 1}
    assert done["result"]["digests"] == {"planned": 1, "imported": 1}
    assert done["result"]["failed"] == []

    with MemorySystem(MemoryConfig.for_home(home)) as restored:
        assert restored.store.scalar("SELECT count(*) FROM memory_digests") == 1
        assert "索引选型已定" in restored.store.scalar("SELECT content FROM memory_digests")
        # The restored digest keeps its source timestamp instead of claiming to
        # be the newest one (which would suppress regeneration in the host).
        stored_at = restored.store.scalar("SELECT created_at FROM memory_digests")
        assert stored_at[:10] == digest.created_at[:10]
        assert restored.store.scalar("SELECT count(*) FROM l3_edges") == 1
        row = restored.store.query_one("SELECT confidence FROM l3_edges")
        assert row["confidence"] == pytest.approx(0.9)
        # Facts-only projects never pass through ``remember``, so the restore
        # registers them itself; otherwise the graph exists but the project
        # list (which the UI is built from) never shows it.
        assert restored.store.scalar(
            "SELECT count(*) FROM projects WHERE project_id = ?", (project,)
        ) == 1


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