/**
 * dsh-memory smoke test — runs without dsh, drives the compiled lib/.
 * Assertion groups mirror the v3 milestones:
 *   G1  idempotent schema      (M0)
 *   G2  global direct-write + cross-session recall  (M1)
 *   G3  content dedup          (M0)
 *   G4  quality filter         (M0)
 *   G5  failure_memories trail (M3)
 *   G6  exponential heat decay (M2)
 *   G7  frequency sliding window (M2)
 *   G8  episodes + recall      (M1)
 *   G9  three-level forgetting (M3)
 *   G10 user-layer immortality (M3)
 *   G11 episodic forgetting    (M3)
 *   G12 formatting (pure)      (M0)
 *
 * Run: node smoke.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from './lib/store.js'
import { DAY_MS, DEFAULT_FORGET_DAYS, heatOf, shouldArchive, shouldDelete, shouldDemote } from './lib/heat.js'
import { isLowQuality, qualityScore } from './lib/quality.js'
import { formatEntries, formatEpisodes, recallEmptyLabel, writeFailed, writeVerdictLabel } from './lib/format.js'
import { collectTurnTexts, collectTurnTools, dedupe, episodeWorthWriting, isCompletedTurnEnd, runL0, summarizeLlm, summarizeRules } from './lib/l0.js'
import { DatabaseSync } from 'node:sqlite'

let passed = 0
let failed = 0
function assert(name, cond) {
  if (cond) { passed += 1; console.log(`  \u2713 ${name}`) }
  else { failed += 1; console.error(`  \u2717 ${name}`) }
}
function group(name) {
  console.log(`\n=== ${name} ===`)
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
const DAY = DAY_MS
const now = Date.now()

// ---------------------------------------------------------------------------
group('G1 idempotent schema (M0)')
{
  let s = new MemoryStore(tmp)
  assert('constructor creates db', s.dbPath.endsWith('memory.db'))
  s.close()
  s = new MemoryStore(tmp) // re-open same path: DDL must be idempotent
  assert('re-open same path does not throw', s.count() >= 0)
  s.close()
}

// ---------------------------------------------------------------------------
group('G2 global direct-write + cross-session recall (M1)')
{
  const a = new MemoryStore(tmp)
  a.batch([{ action: 'add', layer: 'user', content: '用户偏好简洁的回复', importance: 5, topic: '偏好' }])
  a.batch([{ action: 'add', layer: 'memory', kind: 'env', content: '本机数据库连接串在 .env 文件的 DB_URL', importance: 5, topic: '环境' }])
  a.close()

  const b = new MemoryStore(tmp) // new session instance
  const hits = b.recall('数据库连接')
  assert('cross-session recall finds env fact', hits.some(h => h.entry.content.includes('DB_URL')))
  const hits2 = b.recall('简洁')
  assert('cross-session recall finds user pref', hits2.some(h => h.entry.content.includes('简洁')))
  assert('cross-session recall finds episode-empty but returns [] not throw', b.recallEpisodes('随便') instanceof Array)
  b.close()
}

// ---------------------------------------------------------------------------
group('G3 content dedup (M0)')
{
  const s = new MemoryStore(tmp)
  s.batch([{ action: 'add', content: '重复内容测试条目A', topic: 'x' }])
  const c1 = s.count()
  s.batch([{ action: 'add', content: '重复内容测试条目A', topic: 'x' }]) // same content
  const c2 = s.count()
  assert('same content twice → still one entry', c1 === c2)
  s.close()
}

// ---------------------------------------------------------------------------
group('G4 quality filter (M0)')
{
  const s = new MemoryStore(tmp)
  assert('qualityScore low for junk meta/weak content', qualityScore('临时记忆一次性的', []) <= 30)
  assert('isLowQuality(<=30) true', isLowQuality(30))
  assert('isLowQuality(>30) false', !isLowQuality(40))
  s.batch([{ action: 'add', content: '临时记忆一次性的垃圾' }])
  const e = s.activeEntries().find(x => x.content.includes('临时'))
  assert('low-quality entry flagged', e && e.low_quality === true)
  const hits = s.recall('临时')
  assert('low-quality excluded from default recall', !hits.some(h => h.entry.low_quality))
  const hits2 = s.recall('临时', { includeLowQuality: true })
  assert('low-quality included on explicit include', hits2.some(h => h.entry.low_quality))
  s.close()
}

// ---------------------------------------------------------------------------
group('G5 failure_memories trail (M3)')
{
  const s = new MemoryStore(tmp)
  s.batch([{ action: 'add', content: '旧内容AAA', topic: 't' }])
  const id = s.activeEntries().find(e => e.content === '旧内容AAA').id
  s.batch([{ action: 'replace', id, content: '新内容BBB' }])
  const trail = s.failureTrail()
  assert('replace records old/new', trail.some(f => f.oldContent === '旧内容AAA' && f.newContent === '新内容BBB'))
  assert('hasPendingCorrection true for corrected content', s.hasPendingCorrection('旧内容AAA'))
  s.close()
}

// ---------------------------------------------------------------------------
group('G6 exponential heat decay (M2)')
{
  const fd = DEFAULT_FORGET_DAYS
  const e = { layer: 'memory', kind: 'env', last_accessed: now, window_freq: 0 }
  assert('fresh heat ≈ 1', Math.abs(heatOf(e, fd, now) - 1) < 0.001)
  const cold = { layer: 'memory', kind: 'env', last_accessed: now - fd.env * DAY, window_freq: 0 }
  assert('after forgetDays env → heat ≈ 0.05', Math.abs(heatOf(cold, fd, now) - 0.05) < 0.001)
  const gen = { layer: 'memory', kind: 'general', last_accessed: now - fd.general * DAY, window_freq: 0 }
  assert('general forgets faster (60d vs env 365d)', heatOf(gen, fd, now) < 0.06)
  const user = { layer: 'user', kind: 'general', last_accessed: now - 1000 * DAY, window_freq: 0 }
  assert('user layer heat pinned to 1 (immortal)', heatOf(user, fd, now) === 1)
  // frequency boost
  const freq = { layer: 'memory', kind: 'env', last_accessed: now, window_freq: 10 }
  const base = { layer: 'memory', kind: 'env', last_accessed: now, window_freq: 0 }
  assert('frequency boost raises heat', heatOf(freq, fd, now) > heatOf(base, fd, now))
}

// ---------------------------------------------------------------------------
group('G7 frequency sliding window (M2)')
{
  const s = new MemoryStore(tmp)
  s.batch([{ action: 'add', content: '频率窗口测试内容', topic: 'freq' }])
  s.recall('频率窗口')
  let e = s.get(s.activeEntries().find(x => x.content.includes('频率')).id)
  assert('first recall → window_freq=1', e.window_freq === 1)
  s.recall('频率窗口')
  e = s.get(e.id)
  assert('second recall → window_freq=2', e.window_freq === 2)
  assert('window_start set', e.window_start > 0)
  s.close()
}

// ---------------------------------------------------------------------------
group('G8 episodes + recall (M1)')
{
  const s = new MemoryStore(tmp)
  s.addEpisode({ sessionId: 'sess-1', summary: '用户在会话里讨论了数据库迁移方案', toolsUsed: '["memory","terminal"]', topic: '数据库' })
  s.addEpisode({ sessionId: 'sess-2', summary: '用户问了内存优化的策略', topic: '优化' })
  const hits = s.recallEpisodes('数据库')
  assert('episodic recall finds session summary', hits.some(h => h.episode.summary.includes('迁移')))
  assert('episodes listed newest-first', s.listEpisodes()[0].session_id === 'sess-2')
  s.close()
}

// ---------------------------------------------------------------------------
group('G8.5 L0 episodic condensation (M1, new)')
{
  // pure collect + rules
  const events = [
    { type: 'request/header', data: {} },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: '帮我查一下数据库迁移方案' }] } },
    { type: 'agent/message', data: { turn: 1, content: [{ type: 'text', text: '好的，我来检查迁移步骤。' }] } },
    { type: 'user/message', data: { turn: 2, content: [{ type: 'text', text: '这是另一个回合，不该进 turn 1' }] } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const t1 = collectTurnTexts(events, 1)
  assert('collectTurnTexts scoped to requested turn', t1.length === 2 && t1.every(x => !x.includes('另一个回合')))
  assert('collectTurnTexts extracts message text', t1[0].includes('数据库迁移'))

  const rules = summarizeRules(['  a ', 'a', 'b', 'b', 'c'])
  assert('summarizeRules dedupes consecutive + trims', rules === 'a\nb\nc')

  assert('isCompletedTurnEnd true for completed', isCompletedTurnEnd({ type: 'turn/end', data: { reason: { kind: 'completed' } } }))
  assert('isCompletedTurnEnd false for aborted', !isCompletedTurnEnd({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }))
  assert('isCompletedTurnEnd false for user/message', !isCompletedTurnEnd({ type: 'user/message' }))

  assert('episodeWorthWriting true for real summary', episodeWorthWriting('用户在会话里讨论了迁移'))
  assert('episodeWorthWriting false for stub', !episodeWorthWriting(''))

  // LLM seam: valid (uses provider/model) vs degraded (throws -> null)
  const okSeam = {
    stream: async function* () { yield { type: 'text-delta', text: '用户询问数据库迁移' } },
  }
  const badSeam = {
    stream: async function* () { throw new Error('down') },
  }
  const llmOk = await summarizeLlm(okSeam, { provider: 'p', model: 'm', text: 'x' })
  assert('summarizeLlm returns streamed text', llmOk === '用户询问数据库迁移')
  const llmBad = await summarizeLlm(badSeam, { provider: 'p', model: 'm', text: 'x' })
  assert('summarizeLlm degrades to null on failure', llmBad === null)
  const llmNoRoute = await summarizeLlm(okSeam, { provider: '', model: '', text: 'x' })
  assert('summarizeLlm null without route', llmNoRoute === null)

  // runL0 end-to-end: llm mode writes an episode (isolated store, like G10)
  const lt = mkdtempSync(join(tmpdir(), 'dsh-memory-l0-'))
  const s = new MemoryStore(lt)
  const ep = await runL0(s, {
    events,
    turn: 1,
    summarize: 'llm',
    llm: okSeam,
    provider: 'p',
    model: 'm',
    sessionId: 'sess-l0',
  })
  const list = s.listEpisodes()
  assert('runL0 (llm) wrote an episode', list.length === 1)
  assert('episode summary is LLM text', list[0].summary.includes('数据库迁移'))
  assert('episode session_id tagged', list[0].session_id === 'sess-l0')

  // runL0 rules-mode writes; empty turn writes nothing
  const ep2 = await runL0(s, { events, turn: 2, summarize: 'rules', sessionId: 'sess-l0-2' })
  const list2 = s.listEpisodes()
  assert('runL0 rules-mode wrote episode', list2.length === 2 && ep2 !== null)
  const nullep = await runL0(s, { events: [{ type: 'turn/start', data: { turn: 9 } }], turn: 9, summarize: 'rules', sessionId: 'sess-l0-3' })
  const list3 = s.listEpisodes()
  assert('runL0 empty turn writes nothing', list3.length === 2 && nullep === null)

  // LLM-missing runL0 falls back to rules
  const epFb = await runL0(s, {
    events: events.filter(e => e.data?.turn === 1),
    turn: 1,
    summarize: 'llm',
    llm: null,
    provider: 'p',
    model: 'm',
    sessionId: 'sess-l0-fb',
  })
  assert('runL0 llm-missing falls back to rules', epFb !== null && s.listEpisodes().length === 3)
  s.close()
  rmSync(lt, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G8.6 tools_used collection (tools_used column realism)')
{
  // pure extraction: scoped to turn, dedupes, order-preserving
  const toolEvents = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'a', name: 'memory', arguments: '{}' } },
    { type: 'tool/call', data: { turn: 1, step: 2, callId: 'b', name: 'terminal', arguments: '{}' } },
    { type: 'tool/call', data: { turn: 1, step: 3, callId: 'c', name: 'memory', arguments: '{}' } },
    { type: 'tool/call', data: { turn: 2, step: 1, callId: 'd', name: 'other_tool', arguments: '{}' } },
  ]
  const tools1 = collectTurnTools(toolEvents, 1)
  assert('collectTurnTools scoped to turn', tools1.join(',') === 'memory,terminal')
  assert('collectTurnTools dedupes repeated calls', tools1.length === 2)
  const toolsAll = collectTurnTools(toolEvents, undefined)
  assert('collectTurnTools without turn collects all + dedup', toolsAll.join(',') === 'memory,terminal,other_tool')
  assert('collectTurnTools [] on no tool/call', collectTurnTools([{ type: 'user/message' }], 1).length === 0)

  // addEpisode persists tools_used into the tools_used column (read back)
  const st = new MemoryStore(tmp)
  st.addEpisode({ sessionId: 'sess-tools', summary: '用了若干工具的一回合', toolsUsed: '["memory","terminal"]' })
  const persisted = st.listEpisodes().find(e => e.session_id === 'sess-tools')
  assert('addEpisode persists tools_used column', persisted && persisted.tools_used === '["memory","terminal"]')

  // runL0 end-to-end auto-collects tool names from the turn's events
  const eventsWithTools = [
    { type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: '请帮我查询数据库迁移方案的整体步骤，并把关键结论记入长期记忆方便以后复用' }] } },
    { type: 'tool/call', data: { turn: 1, callId: 'a', name: 'memory', arguments: '{}' } },
    { type: 'tool/call', data: { turn: 1, callId: 'b', name: 'memory_recall', arguments: '{}' } },
    { type: 'tool/call', data: { turn: 2, callId: 'c', name: 'leak_other_turn', arguments: '{}' } },
  ]
  const epA = await runL0(st, { events: eventsWithTools, turn: 1, summarize: 'rules', sessionId: 'sess-l0-tools' })
  const row = st.listEpisodes().filter(e => e.session_id === 'sess-l0-tools')
  assert('runL0 wrote tools_used auto-collected from turn', row[0] && row[0].tools_used === '["memory","memory_recall"]')
  assert('runL0 excludes other-turn tool calls', row[0] && !row[0].tools_used.includes('leak_other_turn'))

  // confirm tools_used is NOT an ep_fts column (FTS indexes summary+topic only)
  const db = new DatabaseSync(st.dbPath)
  const ftsCols = db.prepare("PRAGMA table_info(ep_fts)").all().map(r => r.name)
  db.close()
  assert('ep_fts columns are summary+topic only (tools_used not indexed)', ftsCols.join(',') === 'summary,topic')
  st.close()
}

// ---------------------------------------------------------------------------
group('G9 three-level forgetting (M3)')
{
  const s = new MemoryStore(tmp)
  // demote: env tier0 importance 4
  s.batch([{ action: 'add', layer: 'memory', kind: 'env', content: '降级测试：环境配置项在某处', importance: 4 }])
  let e = s.activeEntries().find(x => x.content.includes('降级测试'))
  assert('env importance4 → tier0', e.tier === 0)
  assert('shouldDemote after 366d cold (importance<5)', shouldDemote({ ...e, last_accessed: now - 366 * DAY }, DEFAULT_FORGET_DAYS, now))

  // archive: general importance 2
  s.batch([{ action: 'add', layer: 'memory', kind: 'general', content: '归档测试的一般事实内容', importance: 2 }])
  const g = s.activeEntries().find(x => x.content.includes('归档测试'))
  assert('general importance2 → tier1', g.tier === 1)
  assert('shouldArchive after 100d cold (importance<4)', shouldArchive({ ...g, last_accessed: now - 100 * DAY }, DEFAULT_FORGET_DAYS, now))

  // run forgetRun with time fast-forward
  const future = now + 366 * DAY
  const r1 = s.forgetRun({}, future)
  assert('forgetRun demotes cold tier0', r1.demoted >= 1)
  assert('forgetRun archives cold general', r1.archivedMem >= 1)

  // hard-delete: a low-quality, low-importance archived entry past observation
  s.batch([{ action: 'add', content: '临时垃圾内容待删' }]) // quality low + short
  const junk = s.activeEntries().find(x => x.content.includes('待删'))
  // force it archived + past observation
  const future2 = future + 40 * DAY
  const r2 = s.forgetRun({}, future2)
  // after two runs, archived low-quality low-importance entries past observation should be deleted
  const still = s.get(junk ? junk.id : '')
  assert('hard-delete removed low-value archived entry (or archived)', !still || still.archived)

  // forget_runs audit written
  const audit = s.dbPath ? r1.runId > 0 : false
  assert('forget_run audit id assigned', audit)
  s.close()
}

// ---------------------------------------------------------------------------
group('G10 user-layer immortality (M3)')
{
  const t2 = mkdtempSync(join(tmpdir(), 'dsh-memory-u-'))
  const s = new MemoryStore(t2)
  s.batch([{ action: 'add', layer: 'user', content: '用户是左撇子', importance: 5 }])
  const u = s.activeEntries().find(x => x.content.includes('左撇子'))
  assert('user entry is tier0', u.tier === 0)
  assert('shouldDemote false for user', !shouldDemote({ ...u, last_accessed: now - 1000 * DAY }, DEFAULT_FORGET_DAYS, now))
  assert('shouldArchive false for user', !shouldArchive({ ...u, last_accessed: now - 1000 * DAY }, DEFAULT_FORGET_DAYS, now))
  assert('shouldDelete false for user (even archived)', !shouldDelete({ ...u, archived: true, archived_at: now - 1000 * DAY }, 30, false, now))
  const r = s.forgetRun({}, now + 1000 * DAY)
  assert('forgetRun archives/deletes nothing (only user entry present)', r.archivedMem === 0 && r.deletedMem === 0 && r.archivedEpi === 0 && r.demoted === 0)
  assert('user entry still tier0, not archived', s.get(u.id).tier === 0 && !s.get(u.id).archived)
  s.close()
  rmSync(t2, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G11 episodic forgetting (M3)')
{
  const s = new MemoryStore(tmp)
  s.addEpisode({ sessionId: 'old-sess', summary: '很久以前的会话摘要' })
  const ep = s.listEpisodes()[0]
  assert('episode present before retention', !ep.archived)
  const r = s.forgetRun({}, now + 181 * DAY) // past episodeRetentionDays=180
  assert('episode archived after retention', r.archivedEpi >= 1)
  const r2 = s.forgetRun({}, now + 181 * DAY + 31 * DAY) // past observation
  assert('archived episode hard-deleted after observation', r2.deletedEpi >= 1)
  s.close()
}

// ---------------------------------------------------------------------------
group('G12 formatting (pure, M0)')
{
  assert('writeVerdictLabel add → 已记入', writeVerdictLabel('add') === '已记入')
  assert('writeVerdictLabel replace → 已纠正', writeVerdictLabel('replace') === '已纠正')
  assert('writeFailed detects 预算已满', writeFailed('记忆预算已满') === true)
  assert('recallEmptyLabel', recallEmptyLabel() === '无匹配记忆')
  assert('formatEntries exposes id', formatEntries([{ id: 'abc123', layer: 'memory', tier: 1, low_quality: false, importance: 3, topic: 't', content: 'c' }]).includes('abc123'))
  assert('formatEpisodes renders summary', formatEpisodes([{ id: 'e1', session_id: 's', ts: 1, summary: '摘要', topic: 't', extracted: false, archived: false, created: 1 }]).includes('摘要'))
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`)
console.log(`passed: ${passed}  failed: ${failed}`)
try { rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
if (failed > 0) process.exit(1)
else process.exit(0)
