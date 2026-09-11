# Changelog

All notable changes to this project are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
