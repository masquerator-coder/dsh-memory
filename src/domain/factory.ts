/**
 * AtomicFact factory — normalizes a raw extraction (or rule capture) into a
 * fully-populated AtomicFact: resolves entities, canonicalizes the predicate,
 * computes the semantic_key, computes expiry from the policy TTL, and stamps
 * id/version/status/privacy. Pure and deterministic for tests.
 *
 * @module dsh-memory/domain/factory
 */
import { EntityResolver } from './entity.ts'
import { canonicalizePredicate, predicateEntry } from './predicate.ts'
import { buildSemanticKey, qualifierSignature } from './semantic-key.ts'
import { newFactId } from './id.ts'
import type {
  AtomicFact,
  FactEntity,
  FactQualifiers,
  FactSource,
  FactType,
  PrivacyLevel,
} from './fact.ts'
import type { ForgettingPolicy } from './policies.ts'
import { parseTtlMs } from './policies.ts'

/** Raw extraction input accepted by the Remember engine / factory. */
export interface RawAssertion {
  subject: { type: string; name: string; id?: string }
  predicate: string
  object: { type: string; name: string; id?: string }
  content: string
  type: FactType
  confidence: number
  qualifiers?: FactQualifiers
  privacy?: PrivacyLevel
  pii?: boolean
  tags?: readonly string[]
  scope: string
  source: FactSource
}

/** Light wrapper resolving entities through a resolver and a known type. */
export function resolveEntity(
  resolver: EntityResolver,
  type: string,
  name: string,
  explicitId?: string,
): FactEntity {
  if (explicitId !== undefined) {
    return { type, id: explicitId, name, aliases: [name] }
  }
  const resolved = resolver.resolve(name, { type })
  return { type, id: resolved.id, name, aliases: [name] }
}

export interface BuildOptions {
  readonly resolver: EntityResolver
  readonly forgetting: ForgettingPolicy
  readonly defaultPrivacy: PrivacyLevel
  readonly now?: number
  readonly idOverride?: string
}

/**
 * Build a complete AtomicFact from a raw assertion.
 * The version starts at 1; conflict resolution raises it via supersede.
 */
export function buildFact(input: RawAssertion, options: BuildOptions): AtomicFact {
  const now = options.now ?? Date.now()
  const subject = resolveEntity(options.resolver, input.subject.type, input.subject.name, input.subject.id)
  const object = resolveEntity(options.resolver, input.object.type, input.object.name, input.object.id)
  const canonicalPredicate = canonicalizePredicate(input.predicate)
  const entry = predicateEntry(canonicalPredicate)
  const qSig = qualifierSignature(input.type, input.qualifiers)
  const semanticKey = buildSemanticKey(subject.id, canonicalPredicate, object.id, qSig)

  const ttlMs = parseTtlMs(options.forgetting[input.type]?.ttl)
  const expiresAt = ttlMs === null ? null : now + ttlMs

  return {
    schema_version: '1.0',
    id: options.idOverride ?? newFactId(now),
    subject,
    predicate: input.predicate,
    canonical_predicate: canonicalPredicate,
    object,
    qualifiers: input.qualifiers,
    semantic_key: semanticKey,
    content: input.content,
    type: input.type,
    scope: input.scope,
    source: input.source,
    confidence: input.confidence,
    version: 1,
    status: 'active',
    privacy: input.privacy ?? options.defaultPrivacy,
    pii: input.pii ?? false,
    ttl: options.forgetting[input.type]?.ttl ?? null,
    entities: [subject.id, object.id],
    tags: input.tags,
    // The weight hint from the predicate registry is folded into storage only
    // via graph scoring; keep a reference for fan-out pruning.
    index_state: 'ready',
    created_at: now,
    updated_at: now,
    expires_at: expiresAt,
  }
}

/** Bump a fact to supersede a prior version (design §3.9). */
export function supersedeFact(prior: AtomicFact, input: RawAssertion, options: BuildOptions): AtomicFact {
  const next = buildFact(input, options)
  return {
    ...next,
    version: prior.version + 1,
    supersedes: prior.id,
    created_at: prior.created_at,
    updated_at: options.now ?? Date.now(),
  }
}
