# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
