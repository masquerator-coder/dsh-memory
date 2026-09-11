/**
 * Entity-card aggregation engine (design §3.13 / §8). Turns the raw store of an
 * entity's atomic facts into a structured `EntityCard`: grouped by canonical
 * predicate, ordered within group by confidence then recency, with a
 * deterministic summary capped to a token budget for cheap injection.
 *
 * The engine is deliberately deterministic and dependency-free — summarization
 * is a first-class-line selection, not an LLM call. LLM/embedding-based
 * summarization is a later seam built on top of this grouping.
 *
 * Privacy: only facts in the supplied privacy tier are included; secrets are
 * excluded unless explicitly requested, and PII-flagged facts are dropped from
 * the rendered card by default (design §12.7).
 *
 * @module dsh-memory/application/card
 */
import type { AtomicFact, PrivacyLevel } from '../domain/fact.ts'
import { predicateEntry } from '../domain/predicate.ts'
import type { EntityCard, CardFact, CardGroup, CardOptions } from '../domain/card.ts'
import { lineTokens } from '../domain/card.ts'
import type { MemoryRepository } from './ports.ts'

const DEFAULT_PRIVACY: PrivacyLevel[] = ['public', 'private']
const DEFAULT_SUMMARY_MAX = 8
const DEFAULT_SUMMARY_TOKENS = 200

/** Include a fact in the card only when its privacy tier is allowed. */
function privacyVisible(privacy: PrivacyLevel, tiers: readonly PrivacyLevel[]): boolean {
  return tiers.includes(privacy)
}

/**
 * Build the entity card for one canonical entity id from the repository.
 * Non-throwing by design: an unknown entity yields an empty card, never an
 * error, so callers (tools, injection) degrade cleanly.
 */
export async function buildEntityCard(
  repo: MemoryRepository,
  entityId: string,
  options: CardOptions = {},
): Promise<EntityCard> {
  const tiers = options.privacy ?? DEFAULT_PRIVACY
  const summaryMax = options.summaryMax ?? DEFAULT_SUMMARY_MAX
  const summaryTokens = options.summaryTokens ?? DEFAULT_SUMMARY_TOKENS
  const redactPii = options.redactPii ?? true

  const facts = await repo.byEntity(entityId, {
    status: ['active'],
    privacy: tiers,
  })

  // Derive display identity from the first fact that names this entity.
  let entityName = entityId
  let entityType = 'entity'
  for (const fact of facts) {
    if (fact.subject.id === entityId) {
      entityName = fact.subject.name
      entityType = fact.subject.type
      break
    }
    if (fact.object?.id === entityId) {
      entityName = fact.object.name
      entityType = fact.object.type
      break
    }
  }

  const visible: CardFact[] = facts
    .filter(f => !(redactPii && f.pii))
    .map(f => toCardFact(f))
    // Highest confidence first, then most recent.
    .sort((a, b) => b.confidence - a.confidence || b.updated_at - a.updated_at)

  // Group by canonical predicate, keeping group display order stable.
  const groups: CardGroup[] = []
  const index = new Map<string, CardGroup>()
  for (const fact of visible) {
    let group = index.get(fact.predicate)
    if (group === undefined) {
      group = { predicate: fact.predicate, title: fact.label, facts: [] }
      index.set(fact.predicate, group)
      groups.push(group)
    }
    group.facts.push(fact)
  }

  // Deterministic summary: the best lines that fit the token budget.
  const summary: string[] = []
  let tokens = 0
  for (const fact of visible) {
    if (summary.length >= summaryMax) break
    const t = lineTokens(fact.content)
    if (summary.length > 0 && tokens + t > summaryTokens) break
    summary.push(fact.content)
    tokens += t
  }

  const updatedAt = visible.length > 0 ? visible[0].updated_at : 0

  return {
    entityId,
    entityName,
    entityType,
    updatedAt,
    count: visible.length,
    summary,
    groups,
  }
}

function toCardFact(fact: AtomicFact): CardFact {
  const entry = predicateEntry(fact.canonical_predicate)
  return {
    id: fact.id,
    predicate: fact.canonical_predicate,
    label: entry.canonical,
    content: fact.content,
    confidence: fact.confidence,
    privacy: fact.privacy,
    pii: fact.pii,
    type: fact.type,
    updated_at: fact.updated_at,
    steps: fact.steps,
    tool_chain: fact.tool_chain,
  }
}
