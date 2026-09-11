/**
 * LLM extractor adapter — the slow-channel extraction call against an `llm`
 * service. Optional: only wired when an `llm` service is present AND a
 * provider/model is configured AND advanced extraction is enabled in config.
 * The main-session LLM never performs extraction (§6.3); this is an independent
 * call with a strict, immutable prompt and a JSON validator on the output.
 *
 * If no provider/model is configured, or the call fails, the caller falls back
 * to rule capture / raw-event storage — never a silent drop.
 *
 * The `llm` object is injected as a parameter (read once at the call site via
 * `ctx.get('llm')`) so this adapter is unit-testable without a full Cordis
 * context.
 *
 * @module dsh-memory/adapters/llm-extractor
 */
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { RawAssertion } from '../domain/factory.ts'
import type { FactSource } from '../domain/fact.ts'
import {
  buildExtractionPrompt,
  validateExtraction,
  injectionSuspicion,
} from '../extraction/extractor.ts'

/** Minimum structural surface of the `llm` service this adapter consumes. */
export interface LlmLike {
  stream(options: GenerateOptions): AsyncIterable<unknown>
}

function asTextBlocks(assembler: BlockAssembler): string {
  const blocks = assembler.blocks()
  return blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

/** The slow-channel extraction function signature. */
export type ExtractFunction = (text: string) => Promise<RawAssertion[]>

export interface LlmExtractorOptions {
  provider?: string
  model?: string
  maxTokens: number
  scope: string
}

/**
 * Build an {@link ExtractFunction} bound to the given `llm` service. Returns
 * undefined when no `llm` is available or no provider+model is configured, so
 * the caller can disable the LLM path cleanly (and avoid NO_ADAPTER failures).
 *
 * @param llm - the ambient `llm` service, or undefined to stay off.
 * @param opts - provider/model route plus extraction budget and target scope.
 */
export function buildLlmExtractor(
  llm: LlmLike | undefined,
  opts: LlmExtractorOptions,
): ExtractFunction | undefined {
  if (llm === undefined) return undefined
  const { provider, model } = opts
  if (!provider || !model) return undefined

  return async (text: string): Promise<RawAssertion[]> => {
    const suspicious = injectionSuspicion(text)
    const source: FactSource = { type: 'conversation', extracted_by: `${provider}/${model}`, credibility: 0.7 }
    const input = suspicious === undefined ? text : `[isolated: ${suspicious}]\n${text}`
    const messages = [createUserMessage({
      content: [{ type: 'text', text: input }],
      source: { kind: 'plugin', plugin: 'dsh-memory' } as never,
    })]
    const options: GenerateOptions = {
      provider,
      model,
      messages: messages as never[],
      system: buildExtractionPrompt(input),
      maxTokens: opts.maxTokens,
      purpose: 'session-title',
    }
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk as never)
    }
    const finished = assembler.finish
    if (finished.kind !== 'stop') {
      throw new Error(`extraction LLM did not stop (${finished.kind})`)
    }
    const json = asTextBlocks(assembler).trim()
    // Strip accidental code fences defensively.
    const cleaned = json.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    return validateExtraction(cleaned, source, opts.scope)
  }
}
