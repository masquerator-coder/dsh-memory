# Agent-memory-system

A layered memory system for coding agents. Episodic recall with decay (L2), a
knowledge graph with write-time consistency and full provenance (L3), and
scoped procedural skills under an attention budget (L4).

Runs embedded in the agent process: one SQLite file, no server, no required
third-party dependencies.

```bash
pip install -e .            # core, stdlib only
pip install -e ".[vec,zh]"  # + sqlite-vec (faster vectors), jieba (better CJK)
```

## Quickstart

```python
from memory_system import MemorySystem, MemoryConfig

with MemorySystem(MemoryConfig.for_home("~/.dsh/memory")) as memory:
    memory.ensure_project("acme-web", org_id="acme")

    # One call = one episode + the facts it establishes (atomically).
    memory.remember(
        project_id="acme-web",
        summary="billing-service 迁移到 eu-west-1；切换后发现重试次数过高",
        importance=0.85,
        event_type="decision",
        facts=[{"head": "billing-service", "relation": "located_in", "tail": "eu-west-1"}],
    )

    # Recall: routed automatically, fused, budget-aware.
    result = memory.recall("billing-service 在哪个区域", project_id="acme-web")
    for fact in result.facts:
        print(fact.head.name, fact.edge.relation, fact.tail.name)

    # Why does the system believe that?
    memory.explain(edge_id=result.facts[0].edge.edge_id)
```

> **On embeddings.** The default `HashEmbedding` is dependency-free and
> deterministic but purely lexical: a query phrased with different words
> ("计费服务" vs "billing-service") will not match. For real recall, use the
> built-in preset for **Qwen3-Embedding-0.6B** (1024 dims, strong on mixed
> CJK/English and code):
>
> ```bash
> ollama pull qwen3-embedding:0.6b
> ```
>
> ```python
> from memory_system import MemoryConfig, MemorySystem
>
> config = MemoryConfig.for_home("~/.dsh/memory", embedding_preset="qwen3")
> memory = MemorySystem(config)   # probes the endpoint on open
> ```
>
> Other presets: `bge-m3` (1024), `nomic-embed-text` (768). Any
> OpenAI-compatible server works (Ollama, vLLM, LM Studio, TEI) — override
> `http_url` / `http_model` / `dim` for a custom endpoint.
>
> **The endpoint is probed at startup.** `on_unavailable` decides what happens
> when it is down: `"warn"` (default) opens anyway and reports
> `memory.probe`, `"raise"` refuses to open, `"fallback"` degrades to hash
> embeddings — but **only on an empty database**, because mixing two vector
> spaces silently is worse than failing loudly.
>
> The dimension is fixed per database. To switch models later without losing
> data:
>
> ```python
> memory.change_embedding(provider, allow_redimension=True)  # re-embeds every row
> ```

## What each layer does

**L2 — episodic.** Memories decay (`R = exp(-Δt/S)`) but are never deleted,
only down-weighted; archived items stay retrievable with an explicit opt-in.
Every retrieval strengthens what it returns.

**L3 — semantic.** A graph where every belief is validated at *write* time:
unknown relations, type violations, cardinality conflicts, weak evidence and
cycles are all rejected or resolved before they can pollute recall. Facts carry
two timelines (when the world was that way, vs. when we learned it) and point
back at the L2 episodes and L0 anchors that justify them.

**L4 — procedural.** Skills are scoped (`project > org > sys`), budgeted
(≤ 3300 tokens/turn across three disclosure levels), and matched on
*actionability* — a skill whose required tools are unavailable is not
recommended. Skills are born from real execution traces, meet five maturity
conditions, and still need a human to approve them.

## Not doing

- **No raw text stored.** L0 anchors are opaque pointers; the system can pass
  them around but cannot dereference them.
- **No model calls on the retrieval path.** Deep recall is deterministic
  structured expansion plus PageRank. Budgets are latency, not vibes.
- **No automatic promotion.** The system proposes; a human decides.

## Tests

```bash
pytest            # 204 tests
```

## Docs

- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture, interface contracts, and
  the ten documented divergences from the original design.
- `memory_system/adapters/dsh.py` — the DeepSeek Harness seam (interface only).