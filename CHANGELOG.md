# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (P3 — 向量/图存储真实化 + 研究 Agent Profile + 观测)

- **Vector/graph storage realized on the read path** (`src/infrastructure/index-backends.ts`,
  `src/application/recall.ts`, `src/service.ts`): `DerivedIndexBackend` now carries a
  read contract (`search` / `graphNeighbors` / `graphFactIds` + `capabilities`), and
  `recall` accepts an optional `IndexRead`. When a searchable vector backend is
  present it drives the semantic-recall stage (a genuine sparse TF-IDF cosine
  vector-space index over char n-gram features, not presence-only BM25); when a
  graph backend is present it drives graph expansion with whitelist-aware entity
  hops. No read source → the KV lexical/adjacency fallback is used unchanged.
  `composeIndexRead()` binds a composite read to the registered backends and the
  service passes it through automatically when indexing is enabled. Real ANN /
  Neo4j / object stores implement the same port.
- **Research Agent Profile** (`src/build-policy.ts`, `src/domain/policies.ts`,
  `src/config.ts`): personal / research share the same engines; differences are
  converged into a typed `profileKind` resolved from `config.profile`. Research
  (`profile: research`) enables all-version retrieval (`versions: 'all'`, recall
  reads `active` + `superseded` and keeps every version instead of collapsing a
  semantic key), a larger pruned graph fan-out, weaker recency decay + longer TTL
  (keeps history), and a privacy filter that may surface `confidential` evidence.
  Personal keeps byte-for-byte P0 defaults.
- **Observability: metrics + tracing** (`src/application/observability.ts`,
  `src/service.ts`): an in-process `Metrics` registry (typed counters + latency
  histograms) and a bounded `TraceBuffer` of execution spans (§11, §12.4). Now
  tracked: writes (`remember`/`forget`/`forget_all`/`link`), recall (count +
  latency + degradation timeout), extraction attempts/success/fail, forgetting
  (`expired`/`merged`), and index worker ticks/applied/dead. `MemoryService.metrics()`
  returns the full counter snapshot and `traces()` exposes recent end-to-end spans.
  Recall-timeout degradation is fault-injected and asserted in tests (§12.8).

### Tests

- `tests/index-read.test.ts` (composeIndexRead, vector cosine ranking, graph
  whitelist neighbors, recall routed to derived backends + KV fallback),
  `tests/profile.test.ts` (research vs personal policy differences, all-version
  retrieval vs active-only), `tests/observability.test.ts` (metric counters /
  recall latency / trace spans / timeout degradation fault injection).
- Suite is now **117 unit tests** (was 104 after the Outbox/Saga round).

### Added (P3 — Outbox / Saga 多后端最终一致性)

- **Outbox log** (`src/domain/outbox.ts`, `src/infrastructure/outbox-journal.ts`):
  an append-only, replay-safe journal of index/unindex changes keyed by
  `(op, factId)` (idempotent — duplicate appends coalesce). Exponential backoff
  (`backoffDelayMs`) governs retry timings. The `OutboxJournal` is in-process for
  the plugin's single-process local positioning; the `OutboxStore` port is the
  seam a durable SQLite/PostgreSQL log can implement later.
- **Pluggable derived backends** (`src/infrastructure/index-backends.ts`): three
  in-memory implementations of `DerivedIndexBackend` (vector / graph / object),
  each with an idempotent `upsert`/`remove` and a fault-injection seam
  (`injectFault`, `setHealthy`). Real ANN / Neo4j / object stores implement the
  same port.
- **IndexWorker** (`src/application/index-worker.ts`): the background Saga
  participant. Reads due outbox entries, propagates `index`/`unindex` to every
  registered backend, flips the fact `index_state` `pending_indexing → ready`,
  retries failures with exponential backoff, and graduates permanently-failing
  entries to the DLQ (`index_failed`) so recall can skip them. Skips unhealthy
  backends without burning retries and surfaces degradation via `health()`.
- **Tombstone & cascade delete** wired through `MemoryService`: `remember` /
  `link` / `slowPath` / `applyUserMdEdits` publish `index` (and `unindex` for a
  superseded fact) to the outbox; `forget` / `forgetAll` / `consolidate` publish
  `unindex` tombstones so derived copies are removed (§7.2, §7.3, §12.7).
- **Recall consistency barrier**: when indexing is enabled and backends are
  registered, `recall` reads only `index_state = ready` facts (§7.2) via a new
  `requireReadyIndex` option — a pending fact is hidden until the worker confirms
  it. With zero backends the plugin behaves byte-for-byte like P0 (all facts
  immediately `ready`), keeping every prior test green.
- **Config & policy** (`config.ts`, `domain/policies.ts`, `build-policy.ts`):
  `indexing.{enabled, pollIntervalMs, requireReadyIndex, maxRetries, backoff*}`.
  Off by default; `index.ts` builds/start the outbox + worker and registers a
  disposer when enabled.
- **Observability**: `health()` now reports `indexing{enabled,backends,degraded}`
  and `outbox{pending,dead}`; `metrics()` reports `outboxPending` / `outboxDead`
  and per-backend counts.

### Tests

- New `tests/outbox.test.ts` (journal idempotency, backoff/due, DLQ counts),
  `tests/index-backends.test.ts`, `tests/index-worker.test.ts` (happy path,
  tombstone cascade, retry-then-success, DLQ on retry exhaustion, unhealthy-skip,
  zero-backend trivially-consistent), and `tests/indexing-service.test.ts`
  (end-to-end service write path + recall barrier + health/metrics, plus the
  default no-outbox regression guard).
- Suite is now **104 unit tests** (was 84 after P2).

### Added (P2)

- **Entity-card aggregation & summary** (`src/domain/card.ts`,
  `src/application/card.ts`): the read path now aggregates an entity's active,
  retrieval-visible facts into a structured `EntityCard` — grouped by canonical
  predicate, ordered by confidence then recency, with a deterministic summary
  capped to a token budget. `MemoryService.getCard()` exposes it with timeout
  degradation, and `read_user_profile` now returns this aggregated card
  (summary + per-topic groups) instead of a raw fact list.
- **`user.md` two-way sync** (design §8; `src/domain/usermd.ts`,
  `src/application/usermd-render.ts` / `usermd-parse.ts` / `usermd-sync.ts`,
  `src/infrastructure/usermd-file.ts`): renders the user profile card to a
  human-readable `user.md` (the `# User Profile` / `## 核心摘要` / `## 详细偏好`
  structure with `### <predicate>` groups), and writes user edits back to
  atomic facts — changed lines supersede, new lines are added, removed lines
  are archived, all with `source=user_edit` (credibility 1.0) so user edits
  always win conflicts. A `userMdFile` config option persists the view and
  watches for external edits (e.g. editing in Obsidian). `MemoryService`
  exposes `renderUserMd()` / `applyUserMdEdits()`.
- **Procedural memory serialization** (design §3.12; `src/domain/procedural.ts`):
  `AtomicFact` now carries structured `steps` / `preconditions` / `tool_chain` /
  `success_rate`, `memory_remember` accepts a `procedure` argument, and
  `normalizeProcedure()` / `stepsFromContent()` validate and migrate P0-era
  "steps-as-content" into typed steps (tool / depends_on / on_failure /
  rollback). Procedural payload is not part of the semantic identity.

### Fixed (P2)

- **`parseUserMd` H1 entity recovery**: the `# User Profile: <name>` heading is
  now parsed to just the entity name (the template prefix is stripped), so a
  parsed `entity` matches the rendered `card.entityName`. Previously the whole
  heading text (`User Profile: Alice`) leaked through.

### Changed (P1 hardening)

- **Per-memory-type recency decay in fusion ranking** (`src/application/recall.ts`):
  `fusionScore` now uses the forgetting-policy lambda for the fact's type
  (`decayLambda`) instead of a fixed `0.005` placeholder — episodic facts sink
  faster than semantic ones as they age. Fixed a latent double-subtraction so the
  `ageMs` parameter is the true age (now − updated_at) rather than a timestamp.
  The `now` argument was removed from `fusionScore` (callers pass the age).
- **LLM extraction made unit-testable** (`src/adapters/llm-extractor.ts`): the
  adapter now takes the `llm` service as an injected parameter instead of reading
  `ctx.get('llm')` internally, so the stream → `BlockAssembler` → validation
  pipeline is testable without a full Cordis context. `index.ts` resolves the
  `llm` service once at the call site.

### Packaging

- **Git installs need no `allowBuilds` key any more.** Dropped the `prepare`
  script and started committing the built `lib/` (`lib/` removed from
  `.gitignore`). pnpm only demands an allowlist entry when a git dependency runs
  an install-time script, and that key embeds the commit SHA — so the old
  `prepare: tsdown` install forced every consumer to re-approve on every push.
  `lib/` is now the shipped artifact: rebuild and commit it together with any
  `src/` change (see README → Install & mount).

### Tests

- `tests/recall.test.ts`: added recency-decay cases (per-type lambda ordering,
  fresh-beats-old, lambda resolution).
- `tests/llm-extractor.test.ts`: 8 end-to-end cases — valid extraction, code-fence
  tolerance, non-`stop` finish rejection, malformed/non-array output rejection, and
  prompt-injection isolation.
- Suite is now **64 unit tests** (was 53 at P0, +3 recall +8 extractor).

## [0.1.0] — 2026-09-08

Initial **P0 core** release per the design document.

### Added

- **Atomic fact model** (`src/domain/fact.ts`): schema versioned, self-contained
  subject–predicate–object assertions with qualifiers, type, status, privacy,
  PII flag, TTL, and source credibility.
- **Semantic-key dedup** (`src/domain/semantic-key.ts`): stable SHA-256 key from
  canonical subject / normalized predicate / canonical object / keyed qualifiers;
  deterministic and order-independent.
- **Predicate registry & entity resolver** (`src/domain/predicate.ts`,
  `src/domain/entity.ts`): synonym canonicalization and dependency-free alias /
  fuzzy resolution.
- **Storage** (`src/infrastructure/json-repo.ts`): atomic JSON-document store
  with KV + lexical BM25 index + entity adjacency; dependency-free, crash-safe
  (temp + rename), serialized writes; supports in-memory mode for tests.
- **Ready engines** (`src/application/*`): `recall` (filter/dedup/graph/fusion/
  budget), `remember` (conflict supersede), `consolidate` (expiry + dedup),
  `privacy` (PII + tier filter + redaction).
- **Extraction** (`src/extraction/*`): fast-channel rule matcher (mode B) and an
  optional LLM extractor with immutable prompt, strict JSON validation, and
  prompt-injection defense.
- **MemoryService** (`src/service.ts`): programmatic API (`recall/remember/
  forget/forgetAll/link/consolidate/health/metrics`) with timeout degradation
  and a scope-scoped worker queue.
- **Adapters** (`src/adapters/*`): `system-prompt/assemble` context injection,
  `session/event` fast-channel capture, `memory_*` + `read_user_profile` tools,
  and an optional `ctx.llm` extractor bridge.
- **Tests**: 50 unit tests across the domain/application/infrastructure layers.
- Packaging: `cordis.patch.yml`, `README.md`, `src/invariant.ts`.

### Security

- User content treated as untrusted data; immutable extraction prompt.
- Privacy-tier retrieval filter and secret/non-injection default.
- PII detection + redaction; `source.user_edit` wins conflicts.

### Not yet (P1–P3)

- Real vector/graph storage, entity-card aggregation & summary, `user.md`
  round-trip, full graph fan-out ranking, outbox/Saga multi-backend consistency.
