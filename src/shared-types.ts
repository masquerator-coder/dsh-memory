/**
 * dsh-memory — types shared between the server (identity-routes.ts / index.ts)
 * and the browser client (client.tsx).
 *
 * WHY this file exists (L14, audit 2026-09-05): the client bundle runs in the
 * browser and cannot `import` the server modules (they pull in node:fs /
 * node:child_process / node:sqlite into the frontend bundle). The two sides
 * used to each hand-write structurally identical copies of the HTTP-payload
 * types, which drifted silently — TypeScript never saw the two copies together,
 * so a field renamed on one side produced no compile error and broke at runtime.
 *
 * These are PURE TYPES with zero dependencies: importing them via `import type`
 * is erased at compile time and contributes zero bytes to the client bundle, so
 * sharing is free from the build's perspective. Every shape here corresponds to
 * a JSON payload that crosses the /memory/* HTTP boundary and is consumed on
 * BOTH sides; types used by only one side stay in their own file.
 */
import type { Kind, Tier, Layer } from './types.js'

/** Result of an immediate "整理记忆" pass, returned by /memory/trigger. */
export interface RunNowResult {
  refined: boolean
  forgetDemoted: number
  forgetArchivedMem: number
  forgetDeletedMem: number
  forgetArchivedEpi: number
  forgetDeletedEpi: number
}

/** One selectable refine-model candidate (host LLM registry entry). */
export interface RefineModelCandidate {
  provider: string
  model: string
  name?: string
}

/** Payload of /memory/models — candidates from the live LLM registry. */
export interface RefineModelsPayload {
  /** Host default model route (agentDefaultModel), for the auto hint. */
  default: { provider?: string; model?: string }
  candidates: RefineModelCandidate[]
  /** Providers whose model list could not be read (kept for the UI hint). */
  failures: { id: string; name: string; message: string }[]
}

/** One memory row in the viewer digest (/memory/view). */
export interface ViewMemory {
  id: string
  layer: Layer
  tier: Tier
  kind: Kind
  topic: string
  importance: number
  content: string
  created: number
  updated: number
  archived: boolean
  lowQuality: boolean
}

/** Digest payload for the "查看记忆" viewer window (/memory/view). */
export interface ViewPayload {
  memories: ViewMemory[]
  memoryCount: number
  episodeCount: number
  topics: { topic: string; count: number }[]
  updatedMs: number
}
