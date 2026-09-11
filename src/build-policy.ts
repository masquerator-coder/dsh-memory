/**
 * Derive a fully-resolved {@link MemoryPolicy} from plugin {@link Config}
 * (design doc §10.3 hot-update: apply() holds the latest policy; in-flight
 * work snapshots it). Pure and testable.
 *
 * @module dsh-memory/build-policy
 */
import type { Config } from './config.ts'
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

export function buildPolicy(config: Config): MemoryPolicy {
  const kind = resolveProfileKind(config.profile)
  const research = kind === 'research'

  const retrieval: RetrievalPolicy = {
    topK: config.retrieval?.topK ?? 20,
    maxTokens: config.retrieval?.maxTokens ?? 800,
    timeoutMs: config.retrieval?.timeoutMs ?? 80,
    // personal: only active; research: all versions (evolution/contradiction).
    versions: config.retrieval?.versions ?? (research ? 'all' : 'active'),
    graph: {
      // research allows a larger, pruned fan-out (§10.2 "可较大,带剪枝").
      maxDepth: config.retrieval?.graph?.maxDepth ?? (research ? 3 : 2),
      maxSeedEntities: config.retrieval?.graph?.maxSeedEntities ?? 5,
      maxFanoutPerEntity: config.retrieval?.graph?.maxFanoutPerEntity ?? (research ? 60 : 30),
      maxCandidates: config.retrieval?.graph?.maxCandidates ?? (research ? 400 : 200),
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
  const forgetting: ForgettingPolicy = research
    ? {
        semantic: { ttl: config.forgetting?.semantic?.ttl ?? '730d', lambda: config.forgetting?.semantic?.lambda ?? 0.0001 },
        episodic: { ttl: config.forgetting?.episodic?.ttl ?? '365d', lambda: config.forgetting?.episodic?.lambda ?? 0.005 },
        procedural: { ttl: config.forgetting?.procedural?.ttl ?? '730d', lambda: config.forgetting?.procedural?.lambda ?? 0.001 },
        working: { ttl: config.forgetting?.working?.ttl ?? null, lambda: config.forgetting?.working?.lambda ?? 0 },
      }
    : {
        semantic: {
          ttl: config.forgetting?.semantic?.ttl ?? '365d',
          lambda: config.forgetting?.semantic?.lambda ?? 0.001,
        },
        episodic: {
          ttl: config.forgetting?.episodic?.ttl ?? '90d',
          lambda: config.forgetting?.episodic?.lambda ?? 0.02,
        },
        procedural: {
          ttl: config.forgetting?.procedural?.ttl ?? '365d',
          lambda: config.forgetting?.procedural?.lambda ?? 0.005,
        },
        working: {
          ttl: config.forgetting?.working?.ttl ?? null,
          lambda: config.forgetting?.working?.lambda ?? 0,
        },
      }

  const privacy: PrivacyPolicy = {
    default: config.privacy?.default ?? (research ? 'confidential' : 'private'),
    // research may surface confidential evidence (§10.2 "可配置").
    retrievalFilter: config.privacy?.retrievalFilter ?? (research ? ['public', 'private', 'confidential'] : ['public', 'private']),
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
    profile: config.profile ?? (research ? 'research' : 'personal'),
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
