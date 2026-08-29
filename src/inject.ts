/**
 * dsh-memory-v3 — Tier-0 injection renderer.
 *
 * Rendered as the text of a systemPrompt.section whose provider is re-evaluated
 * at every prompt assembly, so it is always fresh from the global store and
 * survives compaction (it lives in the system prompt, not the chat history).
 */
import type { MemoryStore } from './store.js'

export interface SectionBuild {
  text: string
  empty: boolean
}

export function buildSection(store: MemoryStore, opts: { importanceThreshold?: number } = {}): SectionBuild {
  const threshold = opts.importanceThreshold ?? 3
  const coreUser = store.list({ layer: 'user', tier: 0, includeLowQuality: false })
  const coreMem = store.list({ layer: 'memory', tier: 0, includeLowQuality: false })
    .filter(e => (e.kind === 'preference' || e.kind === 'env') && e.importance >= threshold)
  const topics = store.topicsIndex()
  const total = store.count()
  const usage = store.usage()
  const episodeCount = store.listEpisodes({ includeArchived: false }).length

  if (coreUser.length + coreMem.length + topics.length === 0 && total === 0 && episodeCount === 0) {
    return { text: '', empty: true }
  }

  const lines: string[] = [
    '# Persistent memory (cross-session)',
    '以下为跨会话持久记忆,酌情采用;更具体/更强的指令优先。',
  ]
  if (coreUser.length > 0) {
    lines.push('', `## user · 关于用户 (${usage.user}字符)`)
    for (const e of coreUser) lines.push(`- [${e.topic}] ${e.content}`)
  }
  if (coreMem.length > 0) {
    lines.push('', `## memory · 偏好/教训 (${usage.memory}字符)`)
    for (const e of coreMem) lines.push(`- [${e.topic}] ${e.content}`)
  }
  if (topics.length > 0) {
    lines.push('', `可召回长期记忆(tier1)领域(${topics.length}个): ${topics.map(t => t.topic).join('、')}`)
  }
  if (episodeCount > 0) {
    lines.push('', `有 ${episodeCount} 段历史会话情景记忆,可用 memory_recall(scope=episodic) 检索。`)
  }
  lines.push('', `记忆占用 ${usage.pct}%(${usage.total}字符);需要详情用 memory_recall;学到稳定事实(用户偏好/环境事实/可复用约定)用 memory 记录,避免任务进度与一次性过程。`)

  return { text: lines.join('\n'), empty: false }
}
