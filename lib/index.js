import z from '@deepseek-ai/schemastery';
import { DEFAULT_BUDGET, MemoryStore, resolveDshHome } from './store.js';
import { buildSection } from './inject.js';
import { registerMemoryTools } from './tools.js';
import { isCompletedTurnEnd, runL0 } from './l0.js';
export const name = 'memory';
export const inject = ['tools', 'systemPrompt'];
export const Config = z.object({
    memoryHome: z.string(),
    enableInjection: z.boolean(),
    budgetTier0: z.number(),
    budgetUser: z.number(),
    budgetMemory: z.number(),
    importanceThreshold: z.number(),
    epistemicWeighting: z.boolean(),
    forgetEnabled: z.boolean(),
    forgetDays: z.object({
        env: z.number(),
        lesson: z.number(),
        decision: z.number(),
        general: z.number(),
    }),
    windowDays: z.number(),
    episodeRetentionDays: z.number(),
    forgetObserveDays: z.number(),
    l0Summarize: z.union([z.const('rules'), z.const('llm')]),
    l0Provider: z.string(),
    l0Model: z.string(),
    l0MaxTokens: z.number(),
    l0TimeoutMs: z.number(),
});
const FORGET_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const FORGET_FIRST_DELAY_MS = 5 * 60 * 1000; // 5 min after boot
export function apply(ctx, config = {}) {
    const store = new MemoryStore(config.memoryHome || resolveDshHome(), {
        tier0: config.budgetTier0 ?? DEFAULT_BUDGET.tier0,
        user: config.budgetUser ?? DEFAULT_BUDGET.user,
        memory: config.budgetMemory ?? DEFAULT_BUDGET.memory,
    }, config.windowDays ?? 30);
    const enableInjection = config.enableInjection ?? true;
    const importanceThreshold = config.importanceThreshold ?? 3;
    const epistemicWeighting = config.epistemicWeighting ?? true;
    const forgetEnabled = config.forgetEnabled ?? true;
    const episodeRetentionDays = config.episodeRetentionDays ?? 180;
    const forgetObserveDays = config.forgetObserveDays ?? 30;
    const l0Summarize = config.l0Summarize ?? 'llm';
    const l0MaxTokens = config.l0MaxTokens ?? 400;
    const l0TimeoutMs = config.l0TimeoutMs ?? 8000;
    let disposed = false;
    let timer;
    const runForget = () => {
        if (disposed)
            return;
        try {
            store.forgetRun({
                forgetDays: config.forgetDays,
                windowDays: config.windowDays,
                episodeRetentionDays,
                observeDays: forgetObserveDays,
            });
        }
        catch (err) {
            if (!disposed)
                console.warn('[dsh-memory] forget run failed:', err instanceof Error ? err.message : err);
        }
    };
    const scheduleForget = (delay) => {
        if (!forgetEnabled)
            return;
        timer = setTimeout(() => {
            timer = undefined;
            runForget();
            scheduleForget(FORGET_INTERVAL_MS);
        }, delay);
    };
    ctx.effect(() => {
        if (enableInjection) {
            ctx.systemPrompt.section({
                name: 'memory:tier0',
                order: 10,
                text: () => buildSection(store, { importanceThreshold }).text,
            });
        }
        registerMemoryTools(ctx, store, { epistemicWeighting });
        // ---- L0 episodic condensation: turn/end(completed) → episode summary ----
        // Adapt the dsh LLM seam (LlmRuntime.stream -> text-delta iterable) into the
        // shape l0.ts consumes, and resolve the model route (plan 2: session header).
        const l0Llm = 'llm' in ctx
            ? {
                stream: (o) => {
                    const opaque = ctx.llm.stream(o);
                    return (async function* () {
                        for await (const chunk of opaque) {
                            const c = chunk;
                            if (c?.type === 'text-delta' && typeof c.text === 'string')
                                yield c;
                        }
                    })();
                },
            }
            : undefined;
        const l0Dispose = ctx.on('session/event', (session, event) => {
            if (!isCompletedTurnEnd(event))
                return;
            // Resolve the model route (plan 2: auto from the session's request header).
            const cfg = session.requestHeader()?.config;
            const provider = config.l0Provider ?? cfg?.provider;
            const model = config.l0Model ?? cfg?.model;
            void runL0(store, {
                events: session.events,
                turn: event.data?.turn,
                summarize: l0Summarize,
                llm: l0Llm,
                provider,
                model,
                maxTokens: l0MaxTokens,
                timeoutMs: l0TimeoutMs,
                signal: undefined,
                sessionId: session.id,
                toolsUsed: undefined,
                topic: undefined,
            }).catch(() => { });
        });
        scheduleForget(FORGET_FIRST_DELAY_MS);
        return () => {
            disposed = true;
            l0Dispose();
            if (timer)
                clearTimeout(timer);
            store.close();
        };
    });
}
