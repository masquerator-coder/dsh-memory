import z from '@deepseek-ai/schemastery';
import { DEFAULT_BUDGET, MemoryStore, resolveDshHome } from './store.js';
import { buildSection } from './inject.js';
import { registerMemoryTools } from './tools.js';
import { isCompletedTurnEnd, runL0 } from './l0.js';
import { resolveRefineRoute, runRefineL1, runRefineL2 } from './refine.js';
export const name = 'memory';
export const inject = ['tools', 'systemPrompt', 'llm', 'agentDefaultModel'];
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
    l1Enabled: z.boolean(),
    l2Enabled: z.boolean(),
    l1Provider: z.string(),
    l1Model: z.string(),
    l1MaxTokens: z.number(),
    l1TimeoutMs: z.number(),
    l2Provider: z.string(),
    l2Model: z.string(),
    l2MaxTokens: z.number(),
    l2TimeoutMs: z.number(),
    refineIntervalMs: z.number(),
    l2MinCluster: z.number(),
    l1RetryDegraded: z.boolean(),
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
    const l1Enabled = config.l1Enabled ?? true;
    const l2Enabled = config.l2Enabled ?? true;
    const l1MaxTokens = config.l1MaxTokens ?? 800;
    const l1TimeoutMs = config.l1TimeoutMs ?? 10000;
    const l2MaxTokens = config.l2MaxTokens ?? 800;
    const l2TimeoutMs = config.l2TimeoutMs ?? 10000;
    const refineIntervalMs = config.refineIntervalMs ?? 3600_000;
    const l2MinCluster = config.l2MinCluster ?? 2;
    const l1RetryDegraded = config.l1RetryDegraded ?? false;
    let disposed = false;
    let timer;
    let refineTimer;
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
        // ---- L0 episodic condensation + L1/L2 background refinement ----
        // Host default model route (idiot-proof auto-route): read once at boot so the
        // background L1/L2 timer has a route even before any live session ran.
        let hostDefault;
        try {
            const sel = ctx.agentDefaultModel?.currentSelection?.();
            if (sel?.provider && sel?.model)
                hostDefault = { provider: sel.provider, model: sel.model };
        }
        catch {
            hostDefault = undefined;
        }
        // Route learned from a live session request-header (captured in the L0 hook).
        const learned = {};
        // Adapt the dsh LLM seam (LlmRuntime.stream -> text-delta iterable) into the
        // shape l0.ts / refine.ts consume, and resolve the model route (plan 2: session
        // header for L0; explicit config for background L1/L2 which have no session).
        const llmSeam = 'llm' in ctx
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
            if (cfg?.provider && cfg?.model) {
                learned.provider = cfg.provider;
                learned.model = cfg.model;
            }
            const provider = config.l0Provider ?? cfg?.provider;
            const model = config.l0Model ?? cfg?.model;
            void runL0(store, {
                events: session.events,
                turn: event.data?.turn,
                summarize: l0Summarize,
                llm: llmSeam,
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
        // L1/L2 refinement: unified background timer (no per-turn cost). Runs on the
        // same seam; explicit route (l1/l2Provider/model, falling back to l0 route)
        // because the timer has no request-header. Guarded by a re-entrancy latch so
        // a slow pass never stacks; never blocks the core write/recall loop.
        let refining = false;
        const runRefine = async () => {
            if (disposed || refining)
                return;
            refining = true;
            try {
                if (l1Enabled) {
                    const l1Route = resolveRefineRoute((config.l1Provider && config.l1Model)
                        ? { provider: config.l1Provider, model: config.l1Model }
                        : (config.l0Provider && config.l0Model)
                            ? { provider: config.l0Provider, model: config.l0Model }
                            : undefined, learned, hostDefault);
                    if (!l1Route && !disposed)
                        console.warn('[dsh-memory] L1 enabled but no LLM route resolved (explicit config, learned session route, and host default model all absent) — pass will be degraded');
                    await runRefineL1(store, {
                        llm: llmSeam,
                        provider: l1Route?.provider,
                        model: l1Route?.model,
                        maxTokens: l1MaxTokens, timeoutMs: l1TimeoutMs,
                        retryDegraded: l1RetryDegraded,
                    });
                }
                if (l2Enabled) {
                    const l2Route = resolveRefineRoute((config.l2Provider && config.l2Model)
                        ? { provider: config.l2Provider, model: config.l2Model }
                        : (config.l0Provider && config.l0Model)
                            ? { provider: config.l0Provider, model: config.l0Model }
                            : undefined, learned, hostDefault);
                    if (!l2Route && !disposed)
                        console.warn('[dsh-memory] L2 enabled but no LLM route resolved (explicit config, learned session route, and host default model all absent) — pass will be degraded');
                    await runRefineL2(store, {
                        llm: llmSeam,
                        provider: l2Route?.provider,
                        model: l2Route?.model,
                        maxTokens: l2MaxTokens, timeoutMs: l2TimeoutMs,
                        minCluster: l2MinCluster,
                    });
                }
            }
            catch (err) {
                if (!disposed)
                    console.warn('[dsh-memory] refine run failed:', err instanceof Error ? err.message : err);
            }
            finally {
                refining = false;
            }
        };
        const scheduleRefine = (delay) => {
            if (disposed)
                return;
            refineTimer = setTimeout(() => {
                refineTimer = undefined;
                void runRefine().finally(() => scheduleRefine(refineIntervalMs));
            }, delay);
        };
        scheduleForget(FORGET_FIRST_DELAY_MS);
        scheduleRefine(2 * 60 * 1000); // first pass 2 min after boot
        return () => {
            disposed = true;
            l0Dispose();
            if (timer)
                clearTimeout(timer);
            if (refineTimer)
                clearTimeout(refineTimer);
            store.close();
        };
    });
}
