/**
 * Plugin configuration (schemastery). Design doc §10 Profile. Fields are
 * optional by default in schemastery v3; `.default()` supplies a fallback that
 * is also made optional.
 *
 * @module dsh-memory/config
 */
import z from '@deepseek-ai/schemastery'
import type { PrivacyLevel, FactType } from './domain/fact.ts'

export interface Config {
  /** Where facts persist (JSON document). Empty string → in-memory only. */
  dataFile?: string
  profile?: string
  /** Whether to inject recalled facts as system context each step. */
  injectContext?: boolean
  /** Whether the session/event fast-channel capture is enabled. */
  captureEnabled?: boolean
  /** Whether session/event capture may call the LLM for extraction. */
  llmExtractionEnabled?: boolean
  retrieval?: {
    topK?: number
    maxTokens?: number
    timeoutMs?: number
    graph?: {
      maxDepth?: number
      maxSeedEntities?: number
      maxFanoutPerEntity?: number
      maxCandidates?: number
      relationWhitelist?: string[]
    }
    ranking?: { w1?: number; w2?: number; w3?: number; w4?: number; w5?: number }
  }
  extraction?: {
    provider?: string
    model?: string
    maxTokens?: number
    batchWindowMs?: number
    fallback?: 'store_raw_event' | 'ignore'
    selfContainmentCheck?: { enabled?: boolean; timeoutMs?: number }
    triggers?: string[]
    ruleConfidence?: number
  }
  forgetting?: Partial<Record<FactType, { ttl?: string | null; lambda?: number }>>
  privacy?: {
    default?: PrivacyLevel
    retrievalFilter?: PrivacyLevel[]
    secretRequiresExplicitAuth?: boolean
    piiRedaction?: boolean
  }
  consolidation?: {
    enabled?: boolean
    incrementalIntervalMs?: number
    batchSize?: number
  }
}

const relationWhitelist = ['works_with', 'prefers_diet', 'uses_tool', 'uses_technology', 'located_in', 'deployed_on', 'works_at', 'uses_database', 'uses_orm', 'has_theme', 'is_a', 'speaks']

export const Config: z<Config> = z.object({
  dataFile: z.string().default(''),
  profile: z.string().default('personal'),
  injectContext: z.boolean().default(true),
  captureEnabled: z.boolean().default(true),
  llmExtractionEnabled: z.boolean().default(false),
  retrieval: z.object({
    topK: z.number().default(20),
    maxTokens: z.number().default(800),
    timeoutMs: z.number().default(80),
    graph: z.object({
      maxDepth: z.number().default(2),
      maxSeedEntities: z.number().default(5),
      maxFanoutPerEntity: z.number().default(30),
      maxCandidates: z.number().default(200),
      relationWhitelist: z.array(z.string()).default(relationWhitelist),
    }),
    ranking: z.object({
      w1: z.number().default(0.45),
      w2: z.number().default(0.2),
      w3: z.number().default(0.15),
      w4: z.number().default(0.1),
      w5: z.number().default(0.1),
    }),
  }),
  extraction: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    maxTokens: z.number().default(600),
    batchWindowMs: z.number().default(1500),
    fallback: z.union(['store_raw_event', 'ignore'] as const).default('store_raw_event'),
    selfContainmentCheck: z.object({
      enabled: z.boolean().default(false),
      timeoutMs: z.number().default(3000),
    }),
    triggers: z.array(z.string()).default(['记住', '以后都', '我的偏好是', '我一般', '我不太', '别再', '以后别', '请记住']),
    ruleConfidence: z.number().default(0.5),
  }),
  forgetting: z.object({
    semantic: z.object({ ttl: z.string().default('365d'), lambda: z.number().default(0.001) }),
    episodic: z.object({ ttl: z.string().default('90d'), lambda: z.number().default(0.02) }),
    procedural: z.object({ ttl: z.string().default('365d'), lambda: z.number().default(0.005) }),
    working: z.object({ ttl: z.string().default(''), lambda: z.number().default(0) }),
  }),
  privacy: z.object({
    default: z.string().default('private') as z<PrivacyLevel>,
    retrievalFilter: z.array(z.string()).default(['public', 'private']) as z<PrivacyLevel[]>,
    secretRequiresExplicitAuth: z.boolean().default(true),
    piiRedaction: z.boolean().default(true),
  }),
  consolidation: z.object({
    enabled: z.boolean().default(true),
    incrementalIntervalMs: z.number().default(15 * 60_000),
    batchSize: z.number().default(500),
  }),
})
