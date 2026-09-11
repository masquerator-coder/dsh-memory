/**
 * LLM extractor adapter — the slow-channel extraction call against `ctx.llm`.
 * Optional: only wired when an `llm` service is present AND advanced
 * extraction is enabled in config. The main-session LLM never performs
 * extraction (§6.3); this is an independent call with a strict, immutable
 * prompt and a JSON validator on the output.
 *
 * In P0, if no provider/model is configured, or the call fails, the caller
 * falls back to rule capture / raw-event storage — never a silent drop.
 *
 * @module dsh-memory/adapters/llm-extractor
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { RawAssertion } from '../domain/factory.ts'
import type { FactSource } from '../domain/fact.ts'
import {
  buildExtractionPrompt,
  validateExtraction,
  injectionSuspicion,
} from '../extraction/extractor.ts'

interface LlmLike {
  stream(options: GenerateOptions): AsyncIterable<unknown>
}

function asTextBlocks(assembler: BlockAssembler): string {
  const blocks = (assembler as unknown as { blocks(): { type: string; text?: string }[] }).blocks()
  return blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

/**
 * Build an `ExtractFunction` bound to the ambient `ctx.llm`. Returns undefined
 * so the caller can disable the LLM path cleanly.
 */
export function buildLlmExtractor(
  ctx: Context,
  opts: { provider?: string; model?: string; maxTokens: number; scope: string },
): ((text: string) => Promise<RawAssertion[]>) | undefined {
  const llm = ctx.get('llm') as unknown as LlmLike | undefined
  if (llm === undefined) return undefined
  const provider = opts.provider
  const model = opts.model
  if (!provider || !model) {
    // Try to inherit the session route is the caller's job; without a route
    // we stay off to avoid NO_ADAPTER failures.
    return undefined
  }

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
    const finished = (assembler as unknown as { finish: { kind: string } }).finish
    if (finished !== undefined && finished.kind !== 'stop') {
      throw new Error(`extraction LLM did not stop (${finished.kind})`)
    }
    const json = asTextBlocks(assembler).trim()
    // Strip accidental code fences defensively.
    const cleaned = json.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    return validateExtraction(cleaned, source, opts.scope)
  }
}
