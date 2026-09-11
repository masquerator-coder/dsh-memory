/**
 * Derive a fully-resolved {@link MemoryPolicy} from plugin {@link Config}
 * (design doc §10.3 hot-update: apply() holds the latest policy; in-flight
 * work snapshots it). Pure and testable.
 *
 * The personal/research differences of design §10.2 are expressed as an
 * explicit per-profile defaults table below, not as scattered ternaries: the
 * profile-dependent config keys carry **no schema default** (see
 * `src/config.ts`), so `undefined` reliably means "the deployment did not set
 * it" and the table value applies. Personal resolves to the exact P0 defaults.
 *
 * @module dsh-memory/build-policy
 */
import type { Config } from './config.ts'
import type { PrivacyLevel } from './domain/fact.ts'
import type {
  AgentProfileKind,
  ForgettingPolicy,
  IndexingPolicy,
  MemoryPolicy,
  PrivacyPolicy,
  RetrievalPolicy,
} from './domain/policies.ts'

/** Map a configured profile string onto a typed profile kind (§10.2). */
export function resolveProfileKind(profile: string | undefined): AgentProfileKind {
  return profile === 'research' || profile === 'research-agent' ? 'research' : 'personal'
}

/** The profile-dependent slice of the policy (§10.2). */
interface ProfileDefaults {
  readonly versions: RetrievalPolicy['versions']
  readonly maxDepth: number
  readonly maxFanoutPerEntity: number
  readonly maxCandidates: number
  readonly forgetting: ForgettingPolicy
  readonly privacyDefault: PrivacyLevel
  readonly retrievalFilter: readonly PrivacyLevel[]
}

/**
 * §10.2 profile differences, verbatim.
 *
 * personal — only `active` versions, a small graph fan-out, strong TTL, strict
 * privacy, no confidential evidence.
 * research — reads every version (evolution / contradiction analysis), allows a
 * larger pruned fan-out, keeps history with weaker decay and longer TTL, and may
 * surface `confidential` evidence.
 */
const PROFILE_DEFAULTS: Record<AgentProfileKind, ProfileDefaults> = {
  personal: {
    versions: 'active',
    maxDepth: 2,
    maxFanoutPerEntity: 30,
    maxCandidates: 200,
    forgetting: {
      semantic: { ttl: '365d', lambda: 0.001 },
      episodic: { ttl: '90d', lambda: 0.02 },
      procedural: { ttl: '365d', lambda: 0.005 },
      working: { ttl: null, lambda: 0 },
    },
    privacyDefault: 'private',
    retrievalFilter: ['public', 'private'],
  },
  research: {
    versions: 'all',
    maxDepth: 3,
    maxFanoutPerEntity: 60,
    maxCandidates: 400,
    forgetting: {
      semantic: { ttl: '730d', lambda: 0.0001 },
      episodic: { ttl: '365d', lambda: 0.005 },
      procedural: { ttl: '730d', lambda: 0.001 },
      working: { ttl: null, lambda: 0 },
    },
    privacyDefault: 'confidential',
    retrievalFilter: ['public', 'private', 'confidential'],
  },
}

/**
 * `undefined` for an absent/empty list. Schemastery materializes an absent
 * `z.array()` as `[]`, which must not be mistaken for "the deployment chose an
 * empty list" (that would allow no privacy tier at all).
 */
function nonEmpty<T>(value: readonly T[] | undefined): readonly T[] | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

export function buildPolicy(config: Config): MemoryPolicy {  const kind = resolveProfileKind(config.profile)
  const defaults = PROFILE_DEFAULTS[kind]

  const retrieval: RetrievalPolicy = {
    topK: config.retrieval?.topK ?? 20,
    maxTokens: config.retrieval?.maxTokens ?? 800,
    timeoutMs: config.retrieval?.timeoutMs ?? 80,
    // personal: only active; research: all versions (evolution/contradiction).
    versions: config.retrieval?.versions ?? defaults.versions,
    graph: {
      // research allows a larger, pruned fan-out (§10.2 "可较大,带剪枝").
      maxDepth: config.retrieval?.graph?.maxDepth ?? defaults.maxDepth,
      maxSeedEntities: config.retrieval?.graph?.maxSeedEntities ?? 5,
      maxFanoutPerEntity: config.retrieval?.graph?.maxFanoutPerEntity ?? defaults.maxFanoutPerEntity,
      maxCandidates: config.retrieval?.graph?.maxCandidates ?? defaults.maxCandidates,
      relationWhitelist: config.retrieval?.graph?.relationWhitelist ?? [],
    },
    ranking: {
      w1: config.retrieval?.ranking?.w1 ?? 0.45,
      w2: config.retrieval?.ranking?.w2 ?? 0.2,
      w3: config.retrieval?.ranking?.w3 ?? 0.15,
      w4: config.retrieval?.ranking?.w4 ?? 0.1,
      w5: config.retrieval?.ranking?.w5 ?? 0.1,
    },
  }

  // research keeps history: weaker decay + longer TTL (§10.2 "保留历史").
  const forgetting: ForgettingPolicy = {
    semantic: {
      ttl: config.forgetting?.semantic?.ttl ?? defaults.forgetting.semantic.ttl,
      lambda: config.forgetting?.semantic?.lambda ?? defaults.forgetting.semantic.lambda,
    },
    episodic: {
      ttl: config.forgetting?.episodic?.ttl ?? defaults.forgetting.episodic.ttl,
      lambda: config.forgetting?.episodic?.lambda ?? defaults.forgetting.episodic.lambda,
    },
    procedural: {
      ttl: config.forgetting?.procedural?.ttl ?? defaults.forgetting.procedural.ttl,
      lambda: config.forgetting?.procedural?.lambda ?? defaults.forgetting.procedural.lambda,
    },
    working: {
      ttl: config.forgetting?.working?.ttl ?? defaults.forgetting.working.ttl,
      lambda: config.forgetting?.working?.lambda ?? defaults.forgetting.working.lambda,
    },
  }

  const privacy: PrivacyPolicy = {
    default: config.privacy?.default ?? defaults.privacyDefault,
    // research may surface confidential evidence (§10.2 "可配置").
    // schemastery hands back `[]` for an absent array, so "empty" must be read
    // as unset: an empty allow-list would silently disable every recall.
    retrievalFilter: nonEmpty(config.privacy?.retrievalFilter) ?? defaults.retrievalFilter,
    secretRequiresExplicitAuth: config.privacy?.secretRequiresExplicitAuth ?? true,
    piiRedaction: config.privacy?.piiRedaction ?? true,
  }

  const indexing: IndexingPolicy = {
    enabled: config.indexing?.enabled ?? false,
    pollIntervalMs: config.indexing?.pollIntervalMs ?? 250,
    backoff: {
      maxRetries: config.indexing?.maxRetries ?? 5,
      baseMs: config.indexing?.backoffBaseMs ?? 50,
      factor: config.indexing?.backoffFactor ?? 2,
      capMs: config.indexing?.backoffCapMs ?? 5_000,
    },
    requireReadyIndex: config.indexing?.requireReadyIndex ?? true,
  }

  return {
    profile: config.profile ?? kind,
    profileKind: kind,
    retrieval,
    extraction: {
      provider: config.extraction?.provider ?? '',
      model: config.extraction?.model ?? '',
      maxTokens: config.extraction?.maxTokens ?? 600,
      batchWindowMs: config.extraction?.batchWindowMs ?? 1500,
      fallback: config.extraction?.fallback ?? 'store_raw_event',
      selfContainmentCheck: {
        enabled: config.extraction?.selfContainmentCheck?.enabled ?? false,
        timeoutMs: config.extraction?.selfContainmentCheck?.timeoutMs ?? 3000,
      },
      triggers: config.extraction?.triggers ?? [
        '记住', '以后都', '我的偏好是', '我一般', '我不太', '别再', '以后别', '请记住',
      ],
      ruleConfidence: config.extraction?.ruleConfidence ?? 0.5,
    },
    forgetting,
    privacy,
    consolidation: {
      enabled: config.consolidation?.enabled ?? true,
      incrementalIntervalMs: config.consolidation?.incrementalIntervalMs ?? 15 * 60_000,
      batchSize: config.consolidation?.batchSize ?? 500,
    },
    indexing,
  }
}
