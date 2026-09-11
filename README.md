# dsh-memory

Persistent, atomic-fact memory for DeepSeek Harness (DSH), written as a Cordis
plugin. It lets an agent remember user preferences, project knowledge, and
decisions **across sessions**, with privacy-first defaults and a predictable,
budgeted retrieval path that never blocks the main conversation.

This is a **P0–P2** implementation of the design in
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
  - `memory_remember` optionally takes a `procedure` (structured steps) for
    procedural memory; `read_user_profile` returns the aggregated **entity
    card** (core summary + per-topic groups).
- **Entity-card aggregation** — `read_user_profile` / `getCard` aggregate an
  entity's facts into a grouped card with a deterministic, budgeted summary
  (design §3.13).
- **`user.md` round-trip** — a `user.md` view (design §8) is rendered to disk
  from the entity card and watched for external edits, which are written back
  to atomic facts as `user_edit` (credibility 1.0, always wins conflicts).
- **Procedural memory** — procedural facts carry structured `steps` /
  `preconditions` / `tool_chain` / `success_rate` (design §3.12), with a
  migration helper for P0-era "steps-as-content" facts.
- **Fast-channel capture** — a `session/event` listener with deterministic,
  zero-LLM rules that hands signals to the background queue (design §6.4
  **mode B**): a message is captured only when a configured trigger phrase fires
  (`记住…`, `我的偏好是…`) or when it carries a fact-worthy signal (numbers,
  dates, proper nouns, versions — the §6.4 mode B pattern). Everything else is
  ignored. `extraction.triggers` configures the trigger list.
- **Dynamic-context injection** — recalled facts are surfaced through DSH's
  `system-prompt/assemble` context channel (the same "Current runtime context"
  snapshot mechanism), so they remain reconstructible from the session log and
  never mutate the frozen `agent/request` config.
- **Privacy guard** — PII detection + redaction, privacy-tier retrieval filter,
  and an immutable extraction prompt with strict JSON validation / prompt
  injection defense (design §12.7). Enforced on every path to the model:
  PII-flagged facts are never auto-injected or returned by a tool, `secret`
  facts require `secretRequiresExplicitAuth: false` **and** a tier list that
  admits them, and `confidential` content is PII-masked and tier-marked
  (`[confidential] …`) on the way out.
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

## Known Limitations (P0/P1/P2)

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
- **Consolidation** covers expiry + same-key dedup only; schema migration and
  full graph fan-out ranking remain deferred (design P3).
- **Summarization** is deterministic first-class-line selection, not an LLM
  call. LLM/embedding-based summarization of entity cards is a later seam on
  top of the grouping.
- **`user.md` reconciliation** matches edited lines to facts per predicate by
  exact content, against exactly the facts the rendered view can show (the
  primary entity, the current privacy tier, non-PII). Facts the view cannot
  represent are never treated as "deleted by the user". Heavily restructured
  free-hand edits may still not map cleanly to a single fact and are written
  back as new/archived facts. Concurrent user edits win over background
  aggregation (design §8.4).
- **Per-scope ordering** is guaranteed by a scope-scoped worker queue, but there
  is no cross-process lock: P0 targets a single local DSH process.
- **Persistence failure semantics.** A write that fails (file lock, full disk)
  is rolled back in memory and reported; it no longer breaks later operations. A
  document that cannot be parsed is moved aside to `<file>.corrupt-<ts>` before
  anything else is written, and a document that cannot be read at all puts the
  store in read-only mode rather than being overwritten. There is no `fsync`, so
  a power loss can still leave a truncated file (recovered as above, not lost).

## Security model

- User content is **untrusted data**. The extraction prompt is immutable and
  user text cannot alter it; output must pass JSON schema validation.
- `source.user_edit` implies `credibility = 1.0` and always wins conflicts.
- Privacy tiers (`public/private/confidential/secret`), enforced on every path
  that can reach the model (recall, the degradation fallback, context injection,
  the `memory_*` tools and the `user.md` view):
  - PII-flagged facts are never auto-injected, and PII detected at capture time
    is stored redacted (`<<phone>>`, `<<id>>`, …) — the raw value does not enter
    memory;
  - `confidential` content is PII-masked and marked `[confidential]` on recall;
  - `secret` facts are dropped unless `secretRequiresExplicitAuth: false` **and**
    `privacy.retrievalFilter` lists `secret`.
- `forgetAll(scope)` is the forgetting-rights cascade.

> **Storage is plaintext.** `dataFile` and `userMdFile` hold long-term memory
> (including `confidential`/`secret` facts) as unencrypted JSON/Markdown with
> default filesystem permissions, and there is no passphrase or OS-keychain
> integration. Point them at a location your platform already protects, and do
> not put them in a synced/public folder. Encryption is not implemented.

## Configuration

All settings are declared in `src/config.ts` (schemastery `z.object`) and
mirror the design's Profile (§10). Selected defaults **for `profile: personal`**:

| key | default |
| --- | --- |
| `dataFile` | `''` (**in-memory**; set a path to persist) |
| `userMdFile` | `''` (persist + watch the `user.md` view; empty disables) |
| `profile` | `personal` |
| `injectContext` | `true` |
| `captureEnabled` | `true` |
| `llmExtractionEnabled` | `false` |
| `retrieval.topK` / `maxTokens` / `timeoutMs` | `20` / `800` / `80` |
| `retrieval.ranking` | `w1..w5 = .45/.20/.15/.10/.10` |
| `forgetting.semantic.ttl` / `.episodic.ttl` | `365d` / `90d` |
| `privacy.default` / `retrievalFilter` | `private` / `[public,private]` |
| `consolidation.incrementalIntervalMs` | `900000` (15min) |

The profile-dependent keys — `retrieval.versions`,
`retrieval.graph.{maxDepth,maxFanoutPerEntity,maxCandidates}`,
`forgetting.*.{ttl,lambda}`, `privacy.{default,retrievalFilter}` — are resolved
in `src/build-policy.ts` per profile (§10.2) and deliberately carry **no schema
default**, so an unset key means "use the profile's value". `profile: research`
therefore differs from personal (all-version retrieval, larger pruned fan-out,
weaker decay / longer TTL, `confidential` in the retrieval filter). Set any of
them explicitly to override both profiles; `privacy.retrievalFilter` is read as
unset when empty.

## Install & mount

```bash
# From within the profile that should host it:
dsh plugin add "https://github.com/masquerator-coder/dsh-memory.git"
# or a tag / branch / registry spec / local path, e.g. dsh plugin add dsh-memory@next
```

The plugin's `package.json` declares `dsh.bundle.patch: ./cordis.patch.yml`, so
the loader auto-inserts the `memory` row. To persist fact storage, patch
`dataFile` to an absolute path in your profile's `cordis.patch.yml`.

To persist the `user.md` view and sync user edits back to facts, set `userMdFile`
to an absolute path (e.g. next to `dataFile`). The file is rendered on data
changes and watched for external edits (editing it in Obsidian writes the
changes back to atomic facts as `user_edit`).

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
