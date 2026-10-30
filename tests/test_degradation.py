"""Degradation and first-call behaviour.

An embedded agent cannot afford a 400 ms surprise on the first recall of a
session, and the system must keep working when sqlite-vec is unavailable.
"""

from __future__ import annotations

import time

import pytest

from memory_system import FactInput, MemoryConfig, MemorySystem, SkillDefinition, Step
from memory_system.text import prewarm, tokenize


def test_prewarm_makes_first_tokenize_cheap():
    prewarm()
    started = time.perf_counter()
    tokens = tokenize("记忆系统 依赖 关系 svc-3")
    elapsed = (time.perf_counter() - started) * 1000
    assert tokens
    # Without prewarm the first call costs ~300 ms building jieba's dictionary.
    assert elapsed < 50


def test_facade_prewarms_on_open():
    system = MemorySystem(MemoryConfig())
    try:
        assert system.tokenizer_ready is True
        started = time.perf_counter()
        tokenize("记忆系统")
        assert (time.perf_counter() - started) * 1000 < 50
    finally:
        system.close()


def test_vec0_and_exact_agree_on_cosine_distance():
    """vec0's native metric is Euclidean, but knn's contract is cosine
    distance — every caller (`1.0 - distance`) and every stored threshold
    (dedup 0.95, min_similarity 0.12, ...) is built on it. The sqlite-vec
    branch must convert so both backends answer identically."""
    import sqlite3

    from memory_system.embedding import _l2_normalize
    from memory_system.vectors import VectorIndex

    pytest.importorskip("sqlite_vec")

    vectors = [
        _l2_normalize([1.0, 2.0, 0.0]),
        _l2_normalize([2.0, 3.9, 0.0]),  # near-duplicate of the first
        _l2_normalize([0.0, 0.0, 1.0]),  # orthogonal
    ]
    query = vectors[0]

    results: dict[str, list[tuple[int, float]]] = {}
    for backend, enabled in (("sqlite-vec", True), ("exact", False)):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
        index = VectorIndex(conn, dim=3, enabled=enabled)
        assert index.backend == backend
        for i, vec in enumerate(vectors, start=1):
            index.upsert("l2", i * 10, vec)
        results[backend] = index.knn("l2", query, k=3)
        conn.close()

    vec_pairs, exact_pairs = results["sqlite-vec"], results["exact"]
    assert [rowid for rowid, _ in vec_pairs] == [rowid for rowid, _ in exact_pairs]
    for (_, vd), (_, ed) in zip(vec_pairs, exact_pairs):
        assert vd == pytest.approx(ed, abs=1e-3)
    by_rowid = dict(vec_pairs)
    assert by_rowid[10] == pytest.approx(0.0, abs=1e-5)  # identical vector
    assert by_rowid[20] < 0.05  # near-duplicate stays confidently close
    assert by_rowid[30] == pytest.approx(1.0, abs=1e-3)  # orthogonal


def test_knn_window_grows_when_scope_rows_rank_beyond_the_fetch():
    """Scoping must not depend on how well the scoped rows rank globally:
    with allowed rowids clustered deep in the ranking, the fixed 64-row
    over-fetch window filtered to nothing and served recall starvation."""
    import sqlite3

    from memory_system.embedding import _l2_normalize
    from memory_system.vectors import VectorIndex

    pytest.importorskip("sqlite_vec")

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    index = VectorIndex(conn, dim=3, enabled=True)
    try:
        query = _l2_normalize([1.0, 0.0, 0.0])
        # Distance from the query grows monotonically with the second
        # component, so rowids rank in ascending order.
        for j in range(1, 201):
            index.upsert("l2", j, _l2_normalize([1.0, j * 0.001, 0.0]))

        allowed = set(range(150, 201))  # only ever ranks below the first window
        hits = index.knn("l2", query, k=5, allowed_rowids=allowed)
        rowids = [rid for rid, _ in hits]
        assert set(rowids) <= allowed
        assert rowids == [150, 151, 152, 153, 154]  # nearest allowed, in order
    finally:
        conn.close()


def test_knn_window_never_exceeds_the_backend_limit():
    """A scope smaller than ``k`` must return what exists, not raise.

    The over-fetch window doubles until it satisfies ``k`` or exhausts the
    table. A scope with fewer members than ``k`` can never satisfy it, so on a
    table larger than the backend's k limit (4096 in sqlite-vec) the window
    doubled past it and the query raised ``OperationalError`` — a small project
    stopped being recallable once the shared vector table grew.
    """
    import sqlite3

    from memory_system.embedding import _l2_normalize
    from memory_system.vectors import MAX_KNN_K, VectorIndex

    pytest.importorskip("sqlite_vec")

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    index = VectorIndex(conn, dim=3, enabled=True)
    try:
        query = _l2_normalize([1.0, 0.0, 0.0])
        # An index larger than the backend's k limit is what made widening
        # walk past it. The rows are inserted directly: this is about the query
        # window, not about ranking.
        for j in range(1, MAX_KNN_K + 1200):
            index.upsert("l2", j, _l2_normalize([1.0, (j % 500) * 0.001, 0.0]))

        # One allowed row, k=5: impossible to satisfy, must degrade instead.
        hits = index.knn("l2", query, k=5, allowed_rowids={7})
        assert [rid for rid, _ in hits] == [7]

        # A scope smaller than k but bigger than one keeps every member.
        allowed = {11, 12, 13}
        hits = index.knn("l2", query, k=5, allowed_rowids=allowed)
        assert {rid for rid, _ in hits} == allowed

        # And a large enough scope still fills k.
        allowed = set(range(1, 200))
        hits = index.knn("l2", query, k=5, allowed_rowids=allowed)
        assert len(hits) == 5
        assert set(rid for rid, _ in hits) <= allowed
    finally:
        conn.close()


def test_knn_scope_smaller_than_k_terminates_below_the_backend_limit():
    """A scope smaller than ``k`` must terminate, not spin, below 4096 rows.

    The window doubles until it satisfies ``k`` or exhausts the table, but
    when the table is smaller than the backend cap, ``min(fetch * 2,
    MAX_KNN_K, total)`` can round back down to ``total`` — the very window
    just queried. With 65 vectors and one allowed row, ``fetch`` reached 64,
    then 65, then stayed at 65 forever: ``memory_add`` and ``recall`` for a
    small project hung until the host's bridge timed out.
    """
    import queue
    import sqlite3
    import threading

    from memory_system.embedding import _l2_normalize
    from memory_system.vectors import VectorIndex

    pytest.importorskip("sqlite_vec")

    # The worker thread is what makes a hang visible without wedging pytest;
    # the store itself opens its connection cross-thread too.
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    index = VectorIndex(conn, dim=3, enabled=True)
    query = _l2_normalize([1.0, 0.0, 0.0])
    for j in range(1, 121):
        index.upsert("l2", j, _l2_normalize([1.0, j * 0.001, 0.0]))
    result: queue.Queue = queue.Queue()

    def run() -> None:
        try:
            result.put(("ok", index.knn("l2", query, k=5, allowed_rowids={7})))
        except BaseException as exc:  # noqa: BLE001 - report it to the test thread
            result.put(("error", exc))

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    try:
        kind, value = result.get(timeout=10)
    except queue.Empty:
        pytest.fail("knn did not return: the over-fetch window stopped growing")
    finally:
        conn.close()

    assert kind == "ok", value
    assert [rid for rid, _ in value] == [7]


def test_exact_scan_fallback(monkeypatch):
    from memory_system.vectors import VectorIndex


    monkeypatch.setattr(
        VectorIndex, "_try_sqlite_vec", lambda self: setattr(self, "_load_error", "simulated missing")
    )
    system = MemorySystem(MemoryConfig())
    try:
        assert system.store.vectors.backend == "exact"
        system.ensure_project("fb")
        system.remember(
            project_id="fb", summary="sqlite fallback recall test",
            facts=[{"head": "a", "relation": "uses", "tail": "b"}],
        )
        result = system.recall("sqlite fallback recall", project_id="fb")
        assert len(result.episodes) == 1
        assert len(result.facts) == 1
        definition = SkillDefinition(
            title="t", description="d", when_to_use="w", intent_labels=["x"], triggers=["x"],
            steps=[Step(action="a", tool="run_terminal"), Step(action="b", tool="run_terminal")],
            success_criteria="ok",
        )
        system.add_skill(project_id="fb", definition=definition, name="fb-skill")
        matches = system.skills.match(
            view=system.view("fb"), user_text="x", intent_labels=["x"]
        )
        assert [m.skill.name for m in matches] == ["fb-skill"]
        assert system.archive.search("d")
    finally:
        system.close()


def test_match_issues_one_vector_query(memory: MemorySystem, project: str):
    """Scoring must not scale its index queries with the number of skills."""
    for i in range(40):
        memory.add_skill(
            project_id=project,
            definition=SkillDefinition(
                title=f"技能 {i}", description=f"处理第 {i} 类任务", when_to_use="处理任务时",
                intent_labels=[f"task-{i}"], triggers=[f"任务{i}"],
                requires_tools=["run_terminal"],
                steps=[Step(action="一", tool="run_terminal"), Step(action="二", tool="run_terminal")],
                success_criteria="完成",
            ),
            name=f"skill-{i}",
        )
    calls = {"n": 0}
    original = memory.store.vectors.knn

    def counting(*args, **kwargs):
        calls["n"] += 1
        return original(*args, **kwargs)

    memory.store.vectors.knn = counting
    memory.skills.match(view=memory.view(project), user_text="帮我处理任务3 任务4",
                        context=_ctx(tools=("run_terminal",)))
    # One query for semantic scores; the count must not track the 40 candidates.
    assert calls["n"] <= 3


def _ctx(tools=(), entities=(), environment=None):
    from memory_system import SkillContext

    return SkillContext(
        tools=frozenset(tools), entities=frozenset(entities), environment=dict(environment or {})
    )
def test_degenerate_query_is_refused_by_both_backends(memory: MemorySystem, project: str):
    """A zero or non-finite query vector must return nothing on every backend.

    The fallback path skipped a zero vector (cosine is undefined) while the
    vec0 path did not: its Euclidean distance is the stored norm, which came
    back as a 0.5 cosine-distance -- a degenerate query scored as a half match
    against every row. A NaN component poisoned the ranking instead.
    """
    memory.remember(
        project_id=project,
        summary="a row so the vector table is non-empty",
        event_type="note",
        importance=0.7,
    )
    vectors = memory.store.vectors
    dim = vectors.dim
    nan = float("nan")
    inf = float("inf")

    assert vectors.knn("l2", [0.0] * dim) == []
    assert vectors.knn("l2", [nan] + [0.0] * (dim - 1)) == []
    assert vectors.knn("l2", [inf] + [0.0] * (dim - 1)) == []

    # The guard must not be so eager that a real query stops working.
    hits = memory.recall("a row so the vector table is non-empty", project_id=project)
    assert hits.episodes
