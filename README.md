# dsh-memory

Persistent, atomic-fact memory for DeepSeek Harness (DSH), written as a Cordis
plugin. It lets an agent remember user preferences, project knowledge, and
decisions **across sessions**, with privacy-first defaults and a predictable,
budgeted retrieval path that never blocks the main conversation.

This is a **P0 core** implementation of the design in
[`DeepSeek Harness 记忆系统插件 · 完整设计说明.md`](./DeepSeek%20Harness%20记忆系统插件%20·%20完整设计说明.md).

---

## What it does

- **Atomic-fact model** — every memory is a minimal, self-contained assertion
  (`subject - predicate - object - qualifiers`), deduplicated by a stable
  `semantic_key` (canonicalized predicate + resolved entities + keyed
  qualifiers). Semantic, episodic, and procedural memories all degrade to this
  single contract.
- **A `memory` service** (`ctx.memory`) with `recall`, `remember`, `forget`,
  `forgetAll`, `link`, `consolidate`, `extractAndRemember`, `health`, `metrics`.
- **Explicit tools** the model can call:
  - `memory_recall` / `memory_remember` / `memory_forget` /
    `memory_forget_all` / `memory_link` / `read_user_profile`
- **Fast-channel capture** — a `session/event` listener with deterministic,
  zero-LLM rules (`记住…`, `我的偏好是…`) that hands signals to the background
  queue (design §6.4 **mode B**).
- **Dynamic-context injection** — recalled facts are surfaced through DSH's
  `system-prompt/assemble` context channel (the same "Current runtime context"
  snapshot mechanism), so they remain reconstructible from the session log and
  never mutate the frozen `agent/request` config.
- **Privacy guard** — PII detection + redaction, privacy-tier retrieval filter,
  and an immutable extraction prompt with strict JSON validation / prompt
  injection defense (design §12.7).
- **Background consolidation** — TTL expiry sweep and same-key dedup merge on a
  timer (design §5.3, P0 scope).

## Model Experience

- The model gets a **system-prompt section** (`memory-awareness`) teaching it to
  use `memory_*` tools, and a bounded block of recalled facts injected as
  **data** on each assembly. Recalled content is always framed as data, never as
  instructions.
- The model never performs extraction itself: `memory_remember` forwards raw
  content and extraction/storage happens on a background worker. The main LLM
  only delegates (§6.3).
- LLM-backed extraction is **off by default** and only engaged when a
  `provider` **and** `model` are configured in `extraction` plus
  `llmExtractionEnabled: true`.

## Known Limitations (P0)

- **Storage** is a dependency-free JSON document (KV + lexical BM25 stand-in for
  a vector store + entity adjacency). No external vector DB, no SQLite, no graph
  DB yet. Lexical recall is a faithful but weaker stand-in for semantic recall.
- **LLM extraction is optional and off by default.** Without it, capture is
  rule-driven (confident triggers) and stores the raw statement at low
  confidence — facts are never silently lost, but richer extraction requires
  wiring `ctx.get('llm')` + provider/model. The LLM path (stream → `BlockAssembler`
  → strict JSON validation → injection isolation) is unit-tested end-to-end.
- **Recency decay is per-memory-type.** Fusion ranking decays recency
  exponentially with the forgetting-policy lambda of the fact's type (semantic
  decays slowly, episodic faster) rather than a fixed placeholder.
- **Consolidation** covers expiry + same-key dedup only; entity-card
  aggregation, summarization, schema migration, and full graph fan-out ranking
  are deferred (design P1–P3).
- **`user.md`** rendering/round-trip is not implemented in P0 (design §8 is
  P2/P3). The `read_user_profile` tool returns an aggregated raw view.
- **Per-scope ordering** is guaranteed by a scope-scoped worker queue, but there
  is no cross-process lock: P0 targets a single local DSH process.

## Security model

- User content is **untrusted data**. The extraction prompt is immutable and
  user text cannot alter it; output must pass JSON schema validation.
- `source.user_edit` implies `credibility = 1.0` and always wins conflicts.
- Privacy tiers (`public/private/confidential/secret`); secrets are never
  auto-injected; confidential content is redacted on non-auth recall.
- `forgetAll(scope)` is the forgetting-rights cascade.

## Configuration

All settings are declared in `src/config.ts` (schemastery `z.object`) and
mirror the design's Profile (§10). Selected defaults:

| key | default |
| --- | --- |
| `dataFile` | `''` (**in-memory**; set a path to persist) |
| `profile` | `personal` |
| `injectContext` | `true` |
| `captureEnabled` | `true` |
| `llmExtractionEnabled` | `false` |
| `retrieval.topK` / `maxTokens` / `timeoutMs` | `20` / `800` / `80` |
| `retrieval.ranking` | `w1..w5 = .45/.20/.15/.10/.10` |
| `forgetting.semantic.ttl` / `.episodic.ttl` | `365d` / `90d` |
| `privacy.default` / `retrievalFilter` | `private` / `[public,private]` |
| `consolidation.incrementalIntervalMs` | `900000` (15min) |

## Install & mount

```bash
# From within the profile that should host it:
dsh plugin add "https://github.com/masquerator-coder/dsh-memory.git"
# or a tag / branch / registry spec / local path, e.g. dsh plugin add dsh-memory@next
```

The plugin's `package.json` declares `dsh.bundle.patch: ./cordis.patch.yml`, so
the loader auto-inserts the `memory` row. To persist fact storage, patch
`dataFile` to an absolute path in your profile's `cordis.patch.yml`.

To enable LLM extraction, add `extraction.provider`, `extraction.model`, and
`llmExtractionEnabled: true` to the `memory` row.

### Git installs need no `allowBuilds` key

pnpm refuses to run a git dependency's install-time scripts until the consumer
allowlists it, and that allowlist key embeds the commit SHA — so a plugin built
by `prepare` forces every consumer to re-approve on **every** push. This package
therefore declares **no `prepare` script** and **commits the built `lib/`**:
`dsh plugin add <git-url>` works on any machine with no allowlist edit, and
`dsh plugin update` keeps working.

### Contributor rule: `src/` and `lib/` ship in the same commit

`lib/` is the distributable artifact (`files` ships `lib/` + `cordis.patch.yml`)
and is tracked on purpose. **Any change under `src/` — or to `cordis.patch.yml`
/ `package.json` — must be followed by `pnpm build` and the rebuilt `lib/`
committed together**, otherwise consumers install a stale build (git installs no
longer rebuild from source). Run `pnpm typecheck && pnpm test` before committing.

## Development

```bash
pnpm install
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
pnpm build          # tsdown -> lib/   (rebuild AND commit lib/ with any src change)
```

---

### KV Cache effect

This plugin does **not** interact with the DSH KV cache. It persists user memory
in its own on-disk JSON document (`dataFile`) or in-process memory; it appends
no cache-affecting reads or writes. **No KV cache effect.**

### Invariants

See `src/invariant.ts` for the structural guarantees the core reasons about.
`No runtime invariant: <storage> is checked by its own tests` — storage
consistency is verified by unit tests rather than a live runtime assertion.

## License

Apache-2.0
