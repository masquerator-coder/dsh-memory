/**
 * dsh-memory smoke test — runs without dsh, drives the compiled lib/.
 * Assertion groups mirror the v3 milestones:
 *   G1   idempotent schema                   (M0)
 *   G2   global direct-write + cross-session recall  (M1)
 *   G3   content dedup                       (M0)
 *   G4   quality filter                      (M0)
 *   G5   failure_memories trail              (M3)
 *   G6   exponential heat decay              (M2)
 *   G7   frequency sliding window            (M2)
 *   G8   episodes + recall                   (M1)
 *   G8.5 L0 episodic condensation            (M1, new)
 *   G8.6 tools_used collection               (tools_used column realism)
 *   G9   three-level forgetting              (M3)
 *   G10  user-layer immortality              (M3)
 *   G11  episodic forgetting                 (M3)
 *   G12  formatting (pure)                   (M0)
 *   G13  L1 episodic → semantic extraction   (LLM-decided)
 *   G14  L2 semantic merge/arbitration       (LLM-decided)
 *   G15  refine_runs audit schema + isolation
 *   G16  auto-route resolution               (explicit → learned → host default)
 *   G17  budget enforcement + delete snapshot
 *   G17b review fixes 2026-08-30 (P1-5/P2-7/P2-9/P2-10/P3)
 *   G18  M5 session-level LLM settle         (idle consolidation)
 *   G19  M7 L2 incremental fingerprint       (zero-LLM stable clusters)
 *   G20  M8 peak-hour LLM suppression        (isSuppressedRaw)
 *   G21  M9 identity sections                (soul.md / user.md)
 *   G22  R3-i identity file auto-maintenance
 *   G23  R3-ui identity file read/write
 *   G24  review fixes 2026-08-31 (P1-1/P2-1/P2-3/P3-4)
 *   G25  review fixes 2026-09-02 (S1 truncation / G4 cross-layer flip)
 *
 * Run: node smoke.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from './lib/store.js'
import { DAY_MS, DEFAULT_FORGET_DAYS, heatOf, shouldArchive, shouldDelete, shouldDemote } from './lib/heat.js'
import { isLowQuality, qualityScore } from './lib/quality.js'
import { formatEntries, formatEpisodes, recallEmptyLabel, writeFailed, writeVerdictLabel } from './lib/format.js'
import { collectTurnTexts, collectTurnTools, condenseSession, dedupe, episodeWorthWriting, isCompletedTurnEnd, runL0, summarizeLlm, summarizeRules } from './lib/l0.js'
import { buildL1Prompt, buildL2Prompt, isSuppressedRaw, parseL1Json, parseL2Json, resolveRefineRoute, runRefineL1, runRefineL2, runRefineLessonPromote } from './lib/refine.js'
import { buildIdentitySection, buildSection, PROTOCOL_TEXT, protocolSectionText } from './lib/inject.js'
import { readIdentityFiles, writeIdentityFile } from './lib/identity.js'
import { readFileSync, existsSync } from 'node:fs'
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
  s.batch([{ action: 'add', content: '临时垃圾内容待删', importance: 2 }]) // quality low + short + importance 2 (deletable)
  const junk = s.activeEntries().find(x => x.content.includes('待删'))
  const future2 = future + 40 * DAY
  const r2 = s.forgetRun({}, future2) // archives it
  s.forgetRun({}, future2 + 40 * DAY) // past observation → must hard-delete (P2-34: tightened, not "or archived")
  const still = s.get(junk ? junk.id : '')
  assert('hard-delete removed low-value archived entry', !still)

  // P0-4 regression lock: hard-delete must be reachable for a NORMAL (high-quality)
  // low-value entry — the old `quality < 60` gate floored every real memory at 60+
  // and made deletion unreachable. Production-ish params: importance=2, quality≈100.
  s.batch([{ action: 'add', layer: 'memory', kind: 'general', content: '普通低价值事实正文不含临时等扣分词组保持满分质量分数', importance: 2 }])
  const prod = s.activeEntries().find(x => x.content.includes('普通低价值'))
  assert('P0-4 prod entry importance2 & high quality', prod && prod.importance === 2 && prod.quality >= 60)
  s.batch([{ action: 'remove', id: prod.id }]) // soft-archive
  const r3 = s.forgetRun({}, future2 + 40 * DAY)
  const still3 = s.get(prod.id)
  assert('P0-4 normal high-quality entry hard-deleted (quality must NOT gate delete)', !still3 && r3.deletedMem >= 1)

  // P0-2 regression lock: after replace (by id), re-adding the same content must
  // dedup onto the existing row, never create a duplicate (stale contentId drift).
  s.batch([{ action: 'add', layer: 'memory', kind: 'env', content: '去重回归检查的一个独特事实内容XYZ' }])
  const dd = s.activeEntries().find(x => x.content.includes('去重回归'))
  s.batch([{ action: 'replace', id: dd.id, content: '去重回归检查的替换后内容内容ABC' }])
  s.batch([{ action: 'add', layer: 'memory', kind: 'env', content: '去重回归检查的替换后内容内容ABC' }])
  const dupCount = s.activeEntries().filter(x => x.content === '去重回归检查的替换后内容内容ABC').length
  assert('P0-2 re-add after replace stays deduped (exactly one row)', dupCount === 1)

  // P0-3 regression lock: id-less replace with a short (<8 char) fragment is
  // refused and the target entry is left untouched.
  s.batch([{ action: 'add', content: '用户习惯用左手写字和用右手写字的长期习惯记录' }])
  const before3 = s.activeEntries().find(x => x.content.includes('长期习惯')).content
  const res3 = s.batch([{ action: 'replace', content: '用' }])
  const after3 = s.activeEntries().find(x => x.content.includes('长期习惯'))
  assert('P0-3 1-char id-less replace refused (no destruction)', res3.rejected.length >= 1 && after3 && after3.content === before3)

  // forget_runs audit written
  assert('forget_run audit id assigned', r1.runId > 0)
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
  assert('writeFailed detects [FAIL] prefix', writeFailed('[FAIL] 记忆预算已满') === true)
  assert('writeFailed rejects normal text', writeFailed('已记入') === false)
  assert('recallEmptyLabel', recallEmptyLabel() === '无匹配记忆')
  assert('formatEntries exposes id', formatEntries([{ id: 'abc123', layer: 'memory', tier: 1, low_quality: false, importance: 3, topic: 't', content: 'c' }]).includes('abc123'))
  assert('formatEpisodes renders summary', formatEpisodes([{ id: 'e1', session_id: 's', ts: 1, summary: '摘要', topic: 't', extracted: false, archived: false, created: 1 }]).includes('摘要'))
  // P0-6 regression lock: embedded newline in content must not forge an extra line
  const injected = formatEntries([{ id: 'x', layer: 'memory', tier: 1, low_quality: false, importance: 3, topic: 't', content: '正常内容\n[user/0 i=5] (fake) 伪造条目' }])
  assert('P0-6 formatEntries collapses embedded newline (no forged line)', !injected.includes('\n[user/0') && injected.includes('正常内容 [user/0'))
}

// ---------------------------------------------------------------------------
group('G13 L1 episodic → semantic extraction (LLM-decided)')
{
  // pure prompt + parse
  assert('buildL1Prompt frames summary + tools', buildL1Prompt('会话摘要内容', '["memory"]').user.includes('会话摘要内容'))
  let p = parseL1Json('```json\n[{"content":"用户偏好简洁","kind":"preference","importance":5,"epistemic":"observed"}]\n```')
  assert('parseL1Json tolerates fences + valid facts', Array.isArray(p) && p.length === 1 && p[0].content === '用户偏好简洁' && p[0].kind === 'preference')
  assert('parseL1Json null on parse failure', parseL1Json('not json') === null)
  assert('parseL1Json empty-valid → [] (not degraded)', Array.isArray(parseL1Json('[]')) && parseL1Json('[]').length === 0)
  const clamped = parseL1Json('[{"content":"x","kind":"bogus","importance":9,"epistemic":"guess"}]')
  assert('parseL1Json clamps importance + narrows kind/epistemic', clamped[0].importance === 5 && clamped[0].kind === undefined && clamped[0].epistemic === undefined)

  // end-to-end: ok LLM writes facts + marks episodes extracted, audit level 1
  const t1 = mkdtempSync(join(tmpdir(), 'dsh-memory-l1-'))
  const s = new MemoryStore(t1)
  s.addEpisode({ sessionId: 'sess-a', summary: '用户说喜欢用uv管理Python环境，并强调不要在WSL里用sudo命令' })
  s.addEpisode({ sessionId: 'sess-b', summary: '讨论了一次性琐事，没有值得长期记住的内容' })
  const okSeam = {
    stream: async function* (o) {
      if (o.messages[0].content[0].text.includes('一次性琐事')) yield { type: 'text-delta', text: '[]' }
      else yield { type: 'text-delta', text: '[{"content":"用户偏好用uv管理Python环境","kind":"preference","importance":4,"epistemic":"observed"},{"content":"WSL内禁止使用sudo命令","kind":"lesson","importance":5,"epistemic":"observed"}]' }
    },
  }
  const stats = await runRefineL1(s, { llm: okSeam, provider: 'p', model: 'm' })
  assert('L1 processed both episodes', stats.processed === 2)
  assert('L1 degraded neither', stats.degraded === 0)
  assert('L1 wrote uv preference fact', s.activeEntries().some(e => e.content.includes('uv管理Python环境')))
  assert('L1 wrote WSL sudo lesson fact', s.activeEntries().some(e => e.content.includes('使用sudo命令')))
  assert('L1 empty-facts episode leaves no memory', !s.activeEntries().some(e => e.content.includes('一次性琐事')))
  assert('L1 both episodes no longer pending (extracted=1)', s.listEpisodesForRefine().length === 0)
  const db1 = new DatabaseSync(s.dbPath)
  const r1 = db1.prepare("SELECT COUNT(*) AS c FROM refine_runs WHERE level=1 AND status='ok' AND llm_route='p/m'").get()
  assert('L1 audit rows level1 ok with route', Number(r1.c) === 2)
  db1.close()

  // degrade: LLM down → zero writes, episodes marked extracted=2, audit degraded
  const badSeam = { stream: async function* () { throw new Error('down') } }
  s.addEpisode({ sessionId: 'sess-c', summary: '这条用于测试LLM故障时的降级路径行为' })
  const beforeC = s.count()
  const badStats = await runRefineL1(s, { llm: badSeam, provider: 'p', model: 'm' })
  assert('L1 llm-down writes 0 memories', s.count() === beforeC)
  assert('L1 llm-down marks episode degraded', badStats.degraded === 1 && s.listEpisodesForRefine().length === 0)
  const db2 = new DatabaseSync(s.dbPath)
  const r2 = db2.prepare("SELECT status FROM refine_runs ORDER BY id DESC LIMIT 1").get()
  assert('L1 llm-down audit status degraded', r2.status === 'degraded')
  db2.close()

  // no route: pending episode degraded with null route (no hot-loop retry)
  s.addEpisode({ sessionId: 'sess-d', summary: '没有任何路由配置时也应降级跳过且审计留空路由' })
  const noRoute = await runRefineL1(s, {})
  assert('L1 no-route degrades pending episode', noRoute.degraded === 1)
  assert('L1 no-route episode not pending (no retry loop)', s.listEpisodesForRefine().length === 0)
  const db3 = new DatabaseSync(s.dbPath)
  const r3 = db3.prepare('SELECT status, llm_route FROM refine_runs ORDER BY id DESC LIMIT 1').get()
  assert('L1 no-route audit route null + degraded', r3.status === 'degraded' && r3.llm_route === null)
  db3.close()
  s.close()
  rmSync(t1, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G14 L2 semantic merge/arbitration (LLM-decided)')
{
  const t2 = mkdtempSync(join(tmpdir(), 'dsh-memory-l2-'))
  const s = new MemoryStore(t2)
  s.batch([{ action: 'add', topic: 'db', content: '数据库连接串在env文件的DB_URL变量' }])
  s.batch([{ action: 'add', topic: 'db', content: '数据库连接信息放在环境变量DB_URL' }])
  const cluster = s.semanticClusters({ min: 2 })
  assert('L2 semanticClusters groups same-topic ≥2', cluster.length >= 1 && cluster[0].facts.length >= 2)
  const id0 = cluster[0].facts[0].id
  const okSeam = { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify([{ action: 'merge', targetIds: [id0], content: '数据库连接串在环境变量 DB_URL', kind: 'env' }]) } } }
  const stats = await runRefineL2(s, { llm: okSeam, provider: 'p', model: 'm', minCluster: 2 })
  assert('L2 applied merge verdict', stats.verdictsApplied >= 1)
  assert('L2 merged fact written', s.activeEntries().some(e => e.content.includes('环境变量 DB_URL')))
  const merged = s.activeEntries().find(e => e.content.includes('环境变量 DB_URL'))
  assert('L2 merged fact inherits cluster topic (not general)', merged && merged.topic === 'db')
  const archivedTarget = s.get(id0)
  assert('L2 merge archived the targeted original (soft)', !archivedTarget || archivedTarget.archived === true)
  const db = new DatabaseSync(s.dbPath)
  const r = db.prepare('SELECT level, status, llm_route FROM refine_runs WHERE level=2 ORDER BY id DESC LIMIT 1').get()
  assert('L2 audit level2 ok with route', r.level === 2 && r.status === 'ok' && r.llm_route === 'p/m')
  db.close()

  // degrade: LLM down → memories untouched; no route → no-op entirely
  const s3 = new MemoryStore(t2)
  s3.batch([{ action: 'add', topic: 't', content: '降级第一条相同话题记忆内容AAA' }])
  s3.batch([{ action: 'add', topic: 't', content: '降级第二条相同话题记忆内容BBB' }])
  const before = s3.count()
  const badSeam = { stream: async function* () { throw new Error('down') } }
  const badStats = await runRefineL2(s3, { llm: badSeam, provider: 'p', model: 'm' })
  assert('L2 llm-down leaves memories unchanged', s3.count() === before)
  assert('L2 llm-down degraded audit', badStats.degraded >= 1)
  const noRoute = await runRefineL2(s3, {})
  assert('L2 no-route → no-op (0 clusters, no audit spam)', noRoute.clusters === 0)
  s3.close()

  // edge case: merged content collides onto a source id → that source is the
  // merged entry (kept active), other sources removed; exactly one active left
  const t4 = mkdtempSync(join(tmpdir(), 'dsh-memory-l2c-'))
  const s4 = new MemoryStore(t4)
  s4.batch([{ action: 'add', topic: 'edge', importance: 4, content: '甲事实内容完全一致X' }])
  s4.batch([{ action: 'add', topic: 'edge', importance: 4, content: '乙事实内容重复Y' }])
  const cl4 = s4.semanticClusters({ min: 2 })
  const idA = cl4[0].facts[0].id
  const repSeam = { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify([{ action: 'merge', targetIds: [idA], content: '甲事实内容完全一致X', kind: 'env' }]) } } }
  const st4 = await runRefineL2(s4, { llm: repSeam, provider: 'p', model: 'm', minCluster: 2 })
  assert('L2 merge-worded-as-source replays no active-loss', st4.verdictsApplied >= 1)
  const active4 = s4.activeEntries()
  assert('L2 dedup-collided merge keeps one active fact', active4.length === 1 && active4[0].content === '甲事实内容完全一致X')
  assert('L2 dedup-collided merge keeps the surviving source topic', active4[0].topic === 'edge')
  s4.close()
  rmSync(t4, { recursive: true, force: true })

  s.close()
  rmSync(t2, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G15 refine_runs audit schema + isolation')
{
  const t3 = mkdtempSync(join(tmpdir(), 'dsh-memory-runs-'))
  const s = new MemoryStore(t3)
  const db = new DatabaseSync(s.dbPath)
  const cols = db.prepare('PRAGMA table_info(refine_runs)').all().map(r => r.name)
  assert('refine_runs has audit columns', ['level', 'source_id', 'prompt_sha', 'llm_route', 'decisions', 'status'].every(c => cols.includes(c)))
  db.close()
  // L1/L2 inactivated: episodes stay pending; no refine_runs rows written (the
  // enable guard lives in index.ts wiring — here we confirm pending surfaces).
  s.addEpisode({ sessionId: 's', summary: 'L1未启用时这条会话应保持待抽取状态不自动处理' })
  assert('inactive L1 leaves episode pending', s.listEpisodesForRefine().length === 1)
  const db2 = new DatabaseSync(s.dbPath)
  const runCount = db2.prepare('SELECT COUNT(*) AS c FROM refine_runs').get()
  db2.close()
  assert('no refine_runs written when not driven', Number(runCount.c) === 0)
  s.close()
  rmSync(t3, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G16 auto-route resolution (explicit → learned session → host default)')
{
  const E = { provider: 'p-explicit', model: 'm-explicit' }
  const L = { provider: 'p-learned', model: 'm-learned' }
  const H = { provider: 'p-host', model: 'm-host' }
  const r1 = resolveRefineRoute(E, L, H)
  assert('explicit config wins over learned + host', r1?.provider === 'p-explicit' && r1?.model === 'm-explicit')
  const r2 = resolveRefineRoute(undefined, L, H)
  assert('learned session route wins over host default', r2?.provider === 'p-learned' && r2?.model === 'm-learned')
  const r3 = resolveRefineRoute(undefined, undefined, H)
  assert('host default model used when no explicit/learned', r3?.provider === 'p-host' && r3?.model === 'm-host')
  const r4 = resolveRefineRoute({ provider: 'p1' }, undefined, H)
  assert('incomplete explicit (provider only) ignored → host default', r4?.provider === 'p-host')
  const r5 = resolveRefineRoute(undefined, undefined, undefined)
  assert('no route → null (caller degrades)', r5 === null)
  const r6 = resolveRefineRoute(E, L, undefined)
  assert('explicit wins without host default too', r6?.provider === 'p-explicit')
}

// ---------------------------------------------------------------------------
group('G17 budget enforcement (P1-7/8/9) + delete snapshot (P1-13)')
{
  // P1-7: budgetUser is now enforced — over-budget user entries are demoted to
  // tier1 (still recallable, never deleted), not left resident.
  const ud = mkdtempSync(join(tmpdir(), 'dsh-memory-bu-'))
  const u = new MemoryStore(ud, { tier0: 500, user: 80, memory: 500 })
  for (let i = 0; i < 6; i++) u.batch([{ action: 'add', layer: 'user', importance: 4, content: '用户长期偏好事项的具体正文内容编号' + i + '此处补足长度超过预算' }])
  const uUsg = u.usage()
  const uTier1 = u.list({ tier: 1, includeArchived: false }).filter(e => e.layer === 'user').length
  assert('P1-7 budgetUser enforced (over-budget user entries demoted to tier1)', uUsg.user <= 80 && uTier1 >= 1)
  u.close(); rmSync(ud, { recursive: true, force: true })

  // P1-8: overflow is now truly reachable — a protected (importance≥5) resident
  // core that alone exceeds a bucket cannot be demoted → the batch is rejected.
  const od = mkdtempSync(join(tmpdir(), 'dsh-memory-bo-'))
  const o = new MemoryStore(od, { tier0: 500, user: 500, memory: 30 })
  o.batch([{ action: 'add', layer: 'memory', kind: 'env', importance: 5, content: '最高优先级常驻记忆第一条内容正文补足长度到四十个字符左右吧' }])
  const o2 = o.batch([{ action: 'add', layer: 'memory', kind: 'env', importance: 5, content: '最高优先级常驻记忆第二条内容正文补足长度超过内存预算门槛值了' }])
  assert('P1-8 overflow reachable (importance-5 core exceeds memory budget → rejected)', o2.overflowed === true)
  o.close(); rmSync(od, { recursive: true, force: true })

  // P1-9: silent demotion is now surfaced — ApplyResult.demoted is populated.
  const dd = mkdtempSync(join(tmpdir(), 'dsh-memory-bd-'))
  const dv = new MemoryStore(dd, { tier0: 500, user: 500, memory: 50 })
  dv.batch([{ action: 'add', layer: 'memory', kind: 'env', importance: 4, content: '可降级的普通环境事实正文补足到三十个字符左右长度一二三四五' }])
  const r2 = dv.batch([{ action: 'add', layer: 'memory', kind: 'env', importance: 4, content: '又一条可降级环境事实正文补足到三十个字符左右长度六七八九十' }])
  assert('P1-9 silent demotion reported (ApplyResult.demoted non-empty)', Array.isArray(r2.demoted) && r2.demoted.length >= 1)
  dv.close(); rmSync(dd, { recursive: true, force: true })

  // P1-13: hard delete is snapshotted into forget_deleted (content preserved).
  const fd = mkdtempSync(join(tmpdir(), 'dsh-memory-bf-'))
  const f = new MemoryStore(fd)
  f.batch([{ action: 'add', layer: 'memory', kind: 'general', content: '删除快照审计检查用的一条普通低价值事实内容正文', importance: 2 }])
  const fe = f.activeEntries().find(x => x.content.includes('删除快照'))
  f.batch([{ action: 'remove', id: fe.id }])
  f.forgetRun({}, Date.now() + 400 * DAY)
  const db4 = new DatabaseSync(f.dbPath)
  const snap = db4.prepare('SELECT * FROM forget_deleted WHERE memory_id = ?').get(fe.id)
  db4.close()
  assert('P1-13 hard-deleted content snapshotted in forget_deleted', snap && String(snap.content).includes('删除快照'))
  f.close(); rmSync(fd, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G17 review fixes 2026-08-30 — second batch (P1-5 / P2-7 / P2-9 / P2-10 / P3)')
{
  // P2-9: a low-quality write is surfaced on ApplyResult, not a silent "已记入".
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-g17a-'))
    const s = new MemoryStore(t)
    const r = s.batch([{ action: 'add', content: '临时记忆一次性的垃圾' }])
    assert('P2-9 low-quality add surfaced in ApplyResult.lowQuality', Array.isArray(r.lowQuality) && r.lowQuality.length === 1)
    const r2 = s.batch([{ action: 'add', content: '一条足够长的正常环境事实内容用于对照检查低质标记逻辑' }])
    assert('P2-9 normal add has no lowQuality id', Array.isArray(r2.lowQuality) && r2.lowQuality.length === 0)
    s.close(); rmSync(t, { recursive: true, force: true })
  }

  // P2-10: episode hard-delete is snapshotted into forget_deleted_episodes (DESIGN §5.2).
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-g17b-'))
    const s = new MemoryStore(t)
    s.addEpisode({ sessionId: 'snap-sess', summary: '这条情景摘要应在硬删后仍可从快照审计表查回' })
    s.forgetRun({}, Date.now() + 181 * DAY)
    s.forgetRun({}, Date.now() + 181 * DAY + 31 * DAY)
    const db5 = new DatabaseSync(s.dbPath)
    const row = db5.prepare('SELECT * FROM forget_deleted_episodes').get()
    db5.close()
    assert('P2-10 episode hard-delete snapshotted (summary recoverable)', row && String(row.summary).includes('快照审计'))
    s.close(); rmSync(t, { recursive: true, force: true })
  }

  // P2-7: runL0 reports program errors via onError instead of swallowing them.
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-g17c-'))
    const s = new MemoryStore(t)
    s.close()
    let seen = null
    const ep = await runL0(s, {
      events: [{ type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: '这是一段足够长的正常回合文本内容' }] } }],
      turn: 1, summarize: 'rules', sessionId: 's',
      onError: (e) => { seen = e },
    })
    assert('P2-7 runL0 surfaces program error via onError', seen !== null)
    assert('P2-7 runL0 still returns null (never throws)', ep === null)
    rmSync(t, { recursive: true, force: true })
  }

  // P1-5: recallEpisodes correctness after the SQL push-down (archived excluded,
  // substring + FTS layers both hit, no false positives).
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-g17d-'))
    const s = new MemoryStore(t)
    s.addEpisode({ sessionId: 'a', summary: '讨论了数据库备份策略的细节与注意事项' })
    s.addEpisode({ sessionId: 'b', summary: '完全无关的闲聊内容关于天气和晚餐' })
    const hits = s.recallEpisodes('数据库')
    assert('P1-5 recallEpisodes finds substring hit', hits.length === 1 && hits[0].episode.summary.includes('数据库'))
    const none = s.recallEpisodes('量子纠缠')
    assert('P1-5 recallEpisodes no false positives', none.length === 0)
    s.close(); rmSync(t, { recursive: true, force: true })
  }

  // P3-13: episode `extracted` is a three-state number (2 ≠ 0 after read-back).
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-g17e-'))
    const s = new MemoryStore(t)
    s.addEpisode({ sessionId: 'x', summary: '用于验证 extracted 三态读写不会坍缩为布尔' })
    const ep = s.listEpisodes()[0]
    assert('P3-13 new episode extracted === 0', ep.extracted === 0)
    s.markEpisodeExtracted(ep.id, 2)
    const back = s.listEpisodes({ includeArchived: true }).find(e => e.id === ep.id)
    assert('P3-13 degraded state 2 survives read-back', back.extracted === 2)
    s.close(); rmSync(t, { recursive: true, force: true })
  }

  // P3-15: remove force cascades failure_memories cleanup (no orphan references).
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-g17f-'))
    const s = new MemoryStore(t)
    s.batch([{ action: 'add', content: '将被物理删除并检查留痕级联清理的一条事实正文', topic: 't' }])
    const id = s.activeEntries().find(e => e.content.includes('级联清理')).id
    s.batch([{ action: 'replace', id, content: '改写后的替换正文内容长度足够不会被误判为片段' }])
    assert('P3-15 correction trail recorded before force-delete', s.failureTrail().length === 1)
    s.batch([{ action: 'remove', id, force: true }])
    assert('P3-15 force delete cascades failure_memories cleanup', s.failureTrail().length === 0)
    s.close(); rmSync(t, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
group('G18 M5 session-level LLM settle (idle consolidation)')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-memory-m5-'))
  const s = new MemoryStore(t)
  // turn-end realtime RULE summary (zero LLM) — mimics the wiring.
  await runL0(s, {
    events: [{ type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: '用户说明喜欢用极简风格的界面设计' }] } }],
    turn: 1, summarize: 'rules', sessionId: 'm5-sess',
  })
  assert('M5 realtime rule episode written (zero LLM)', s.listEpisodes({ includeArchived: true }).some(e => e.session_id === 'm5-sess' && e.summary.includes('极简')))
  // idle settle upgrades the freshest pending episode with ONE LLM call.
  const seam = { stream: async function* () { yield { type: 'text-delta', text: '会话级精炼：用户偏好极简界面，记录一次关键设计决策' } } }
  const out = await condenseSession(s, { texts: ['用户说明喜欢用极简风格的界面设计'], llm: seam, provider: 'p', model: 'm', sessionId: 'm5-sess' })
  assert('M5 settle returns a consolidated episode', out !== null && !!out.id)
  const eps = s.listEpisodes({ includeArchived: true }).filter(e => e.session_id === 'm5-sess')
  assert('M5 settle upgraded in place (no duplicate row)', eps.length === 1)
  assert('M5 upgraded summary is the LLM consolidation', eps[0].summary.includes('会话级') || eps[0].summary.includes('极简界面'))
  // store helpers under test.
  const last = s.lastEpisodeForSession('m5-sess')
  assert('store.lastEpisodeForSession finds it', last && last.id === eps[0].id)
  const repl = s.replaceEpisodeSummary(last.id, '覆盖后的总结内容ABCXYZ')
  const back = s.getEpisode(last.id)
  assert('store.replaceEpisodeSummary overwrites summary', repl && back.summary === '覆盖后的总结内容ABCXYZ')
  // no route → no LLM burn, returns null, no duplicate.
  const calm = s.listEpisodes({ includeArchived: true }).length
  const none = await condenseSession(s, { texts: ['有文本但没有任何LLM路由可用的情况'], sessionId: 'm5-sess' })
  assert('M5 no-route settle returns null (no burn)', none === null)
  assert('M5 no-route settle adds no row', s.listEpisodes({ includeArchived: true }).length === calm)
  s.close(); rmSync(t, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G19 M7 L2 incremental fingerprint (zero-LLM stable clusters)')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-memory-m7-'))
  const s = new MemoryStore(t)
  s.batch([{ action: 'add', topic: 'inc', content: '增量簇第一条事实内容甲AAAA' }])
  s.batch([{ action: 'add', topic: 'inc', content: '增量簇第二条事实内容乙BBBB' }])
  const seam = { stream: async function* (o) { yield { type: 'text-delta', text: '[]' } } }
  // 1st incremental pass: never-audited cluster is audited.
  const st1 = await runRefineL2(s, { llm: seam, provider: 'p', model: 'm', minCluster: 2, incremental: true })
  assert('M7 first incremental pass audits the fresh cluster', st1.clusters === 1)
  // 2nd pass: stable → skipped, LLM not even called.
  let called = 0
  const counting = { stream: async function* () { called++; yield { type: 'text-delta', text: '[]' } } }
  const st2 = await runRefineL2(s, { llm: counting, provider: 'p', model: 'm', minCluster: 2, incremental: true })
  assert('M7 stable cluster skipped on 2nd pass (0 clusters)', st2.clusters === 0)
  assert('M7 stable cluster burned zero LLM calls', called === 0)
  // incremental:false audits everything regardless.
  const st3 = await runRefineL2(s, { llm: counting, provider: 'p', model: 'm', minCluster: 2, incremental: false })
  assert('M7 incremental:false audits anyway', st3.clusters === 1)
  // A changed member re-enters the audit queue. NB: replace omits topic on
  // purpose — P2-37 must keep the original 'inc' (no general fallback), so the
  // cluster still holds AND the changed member triggers a re-audit.
  await new Promise(r => setTimeout(r, 2))
  const m = s.activeEntries().find(e => e.content.includes('甲'))
  s.batch([{ action: 'replace', id: m.id, content: '增量簇第一条事实内容甲CCCC新版' }])
  const agg = s.activeEntries().find(e => e.content.includes('甲'))
  assert('P2-37 replace keeps topic when not provided', agg !== undefined && agg.topic === 'inc')
  const st4 = await runRefineL2(s, { llm: counting, provider: 'p', model: 'm', minCluster: 2, incremental: true })
  assert('M7 changed member (topic preserved) → cluster re-audited', st4.clusters === 1)
  // degraded (LLM down) does NOT record refined_at → still eligible later.
  const t2 = mkdtempSync(join(tmpdir(), 'dsh-memory-m7b-'))
  const s2 = new MemoryStore(t2)
  s2.batch([{ action: 'add', topic: 'deg', content: '降级簇第一条事实内容甲ASYNC' }])
  s2.batch([{ action: 'add', topic: 'deg', content: '降级簇第二条事实内容乙BTTT' }])
  const bad = { stream: async function* () { throw new Error('down') } }
  const stDeg = await runRefineL2(s2, { llm: bad, provider: 'p', model: 'm', minCluster: 2, incremental: true })
  assert('M7 LLM-down pass degrades (no audit fingerprint)', stDeg.degraded === 1 && s2.l2RefinedTs('deg') === undefined)
  const stRec = await runRefineL2(s2, { llm: seam, provider: 'p', model: 'm', minCluster: 2, incremental: true })
  assert('M7 recovered pass re-audits + records fingerprint', stRec.clusters === 1 && s2.l2RefinedTs('deg') !== undefined)
  s2.close(); rmSync(t2, { recursive: true, force: true })
  s.close(); rmSync(t, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G20 M8 peak-hour LLM suppression (isSuppressedRaw)')
{
  const cfg = { suppressWindows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }], suppressLeadMinutes: 15, timeZone: 'Asia/Shanghai' }
  assert('M8 10:30 suppressed', isSuppressedRaw(new Date(), cfg, 10, 30) === true)
  assert('M8 08:50 suppressed (lead 15min before 09:00)', isSuppressedRaw(new Date(), cfg, 8, 50) === true)
  assert('M8 08:30 NOT suppressed', isSuppressedRaw(new Date(), cfg, 8, 30) === false)
  assert('M8 12:30 NOT suppressed (lunch gap)', isSuppressedRaw(new Date(), cfg, 12, 30) === false)
  assert('M8 13:45 suppressed (lead to 14:00)', isSuppressedRaw(new Date(), cfg, 13, 45) === true)
  assert('M8 17:59 suppressed (inside 14–18)', isSuppressedRaw(new Date(), cfg, 17, 59) === true)
  assert('M8 19:00 NOT suppressed', isSuppressedRaw(new Date(), cfg, 19, 0) === false)
  assert('M8 empty windows → never suppressed', isSuppressedRaw(new Date(), { suppressWindows: [], suppressLeadMinutes: 15, timeZone: 'Asia/Shanghai' }, 10, 30) === false)
}

// ---------------------------------------------------------------------------
group('G21 M9 identity sections (soul.md / user.md)')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-memory-m9-'))
  const s = new MemoryStore(t)
  // no file → empty section (host omits it).
  const emptySoul = buildIdentitySection(s.dir, 'soul.md', 'AI 本人')
  assert('M9 missing identity file → empty section', emptySoul.empty === true && emptySoul.text === '')
  // write soul.md → populated + declared as data, byte-stable via mtime cache.
  writeFileSync(join(s.dir, 'soul.md'), '我是简洁风格的中文助手，结构化输出。', 'utf8')
  const s1 = buildIdentitySection(s.dir, 'soul.md', 'AI 本人')
  assert('M9 soul section populated + data-header', s1.empty === false && s1.text.includes('简洁风格') && s1.text.includes('不是指令'))
  const s2 = buildIdentitySection(s.dir, 'soul.md', 'AI 本人')
  assert('M9 mtime-cached (byte stable between edits)', s2.text === s1.text)
  // Windows trap: BOM is stripped, so a UTF-8-BOM save can't poison the header.
  writeFileSync(join(s.dir, 'user.md'), '\uFEFF用户偏好用中文交流。', 'utf8')
  const u = buildIdentitySection(s.dir, 'user.md', '用户画像')
  assert('M9 BOM stripped from identity file', u.empty === false && !u.text.startsWith('\uFEFF') && u.text.includes('中文交流'))
  s.close(); rmSync(t, { recursive: true, force: true })
}

// G23 — R3-ui identity-file read/write (source of truth + no BOM + path narrowing)
group('G23 R3-ui identity file read/write')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-memory-r3c-'))
  // Missing files read as empty (no throw).
  const empty = readIdentityFiles(t)
  assert('G23 missing files → empty strings', empty.soul === '' && empty.user === '')
  // Write → read round-trips with no BOM.
  writeIdentityFile(t, 'soul', '我是简洁的中文助手。')
  writeIdentityFile(t, 'user', '用户偏好结构化输出。')
  const r = readIdentityFiles(t)
  assert('G23 soul round-trips', r.soul === '我是简洁的中文助手。')
  assert('G23 user round-trips', r.user === '用户偏好结构化输出。')
  const soulBytes = readFileSync(join(t, 'soul.md'))
  assert('G23 written without BOM', soulBytes[0] !== 0xef && !soulBytes.toString('utf8').startsWith('\uFEFF'))
  // The writer is narrowed to soul/user — no path escape.
  assert('G23 write only accepts soul/user', existsSync(join(t, 'soul.md')) && existsSync(join(t, 'user.md')))
  rmSync(t, { recursive: true, force: true })
}

// G24 — review fixes 2026-08-31 (P1-1 near-dup merge survival / P2-1 metadata
// preservation on near-dup re-add / P2-3 empty topic / P3-4 composite PK)
group('G24 review fixes 2026-08-31 (P1-1 / P2-1 / P2-3 / P3-4)')
{
  // P1-1: an L2 merge whose content is a NEAR-duplicate (not byte-identical)
  // of one of its own targets must NOT archive that target — store.add merges
  // the text INTO the canonical row (keeping its id), so the old
  // `id !== contentId(merged)` guard removed the very row it had just updated.
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-f1-'))
    const s = new MemoryStore(t)
    s.batch([{ action: 'add', topic: 'fixdup', content: '数据库连接串在环境变量DB_URL里' }])
    s.batch([{ action: 'add', topic: 'fixdup', content: '会议室的投影仪需要提前一天预约登记' }])
    const cl = s.semanticClusters({ min: 2 })
    assert('G24 P1-1 cluster assembled', cl.length >= 1 && cl[0].facts.length === 2)
    const idA = s.activeEntries().find(e => e.content.includes('DB_URL')).id
    const idB = s.activeEntries().find(e => e.content.includes('投影仪')).id
    // merged text is a prefix-substring of target A → contentSimilarity = 1 ≥ SIM_DUP
    const mergedContent = '数据库连接串在环境变量DB_URL'
    const seam = { stream: async function* () { yield { type: 'text-delta', text: JSON.stringify([{ action: 'merge', targetIds: [idA, idB], content: mergedContent, kind: 'env' }]) } } }
    const st = await runRefineL2(s, { llm: seam, provider: 'p', model: 'm', minCluster: 2 })
    assert('G24 P1-1 near-dup merge verdict applied', st.verdictsApplied >= 1)
    const active = s.activeEntries()
    assert('G24 P1-1 exactly one active row survives the merge', active.length === 1)
    assert('G24 P1-1 surviving row carries the merged content', active[0].content === mergedContent)
    assert('G24 P1-1 canonical target NOT self-archived', s.get(idA).archived === false)
    assert('G24 P1-1 the other target WAS archived', s.get(idB).archived === true)
    s.close(); rmSync(t, { recursive: true, force: true })
  }

  // P2-1: re-adding a near-worded fact WITHOUT explicit importance must keep
  // the canonical row's importance — a default 3 used to pierce the
  // importance>=5 never-hard-delete immunity.
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-f2-'))
    const s = new MemoryStore(t)
    s.batch([{ action: 'add', layer: 'memory', kind: 'env', importance: 5, topic: 'imm', content: '最高保护级别的关键环境事实正文内容保持唯一' }])
    s.batch([{ action: 'add', layer: 'memory', content: '最高保护级别的关键环境事实正文内容保持唯一性' }]) // near-dup, no importance/kind
    const rows = s.activeEntries().filter(e => e.content.includes('关键环境事实'))
    assert('G24 P2-1 near-dup re-add merged into one row', rows.length === 1)
    assert('G24 P2-1 importance=5 preserved (immunity not pierced)', rows[0].importance === 5)
    assert('G24 P2-1 kind preserved on near-dup merge', rows[0].kind === 'env')
    s.close(); rmSync(t, { recursive: true, force: true })
  }

  // P2-3: an explicit empty-string topic falls back to 'general' — no '' bucket.
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-f3-'))
    const s = new MemoryStore(t)
    s.batch([{ action: 'add', topic: '', content: '显式空话题的条目应当回落到默认分组去' }])
    const e = s.activeEntries().find(x => x.content.includes('显式空话题'))
    assert('G24 P2-3 empty topic → DEFAULT_TOPIC (no empty bucket)', e && e.topic === 'general')
    assert('G24 P2-3 topicsIndex shows no empty label', s.topicsIndex().every(ti => ti.topic !== ''))
    s.close(); rmSync(t, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// G25 — review fixes 2026-09-02 (S1 residual truncation / G4 cross-layer flip)
group('G25 review fixes 2026-09-02 (S1 / G4)')
{
  // G4: re-adding identical content under a different layer must never silently
  // change the existing row's layer. A user-layer re-add as `memory` used to
  // drop the row's immortality (tier0 guard was a no-op because the content-hash
  // id is deterministic → the ON CONFLICT(id) upsert still flipped the layer).
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-g1-'))
    const s = new MemoryStore(t)
    const C = '用户偏好的永生保护画像条目唯一正文'
    s.batch([{ action: 'add', layer: 'user', importance: 5, content: C, topic: 'p' }])
    s.batch([{ action: 'add', layer: 'memory', content: C }])
    const rows = s.activeEntries().filter(e => e.content === C)
    assert('G25 G4 cross-layer re-add stays a single row', rows.length === 1)
    assert('G25 G4 user fact NOT silently downgraded to memory', rows[0].layer === 'user')
    assert('G25 G4 immortality tier preserved (tier 0)', rows[0].tier === 0)
    assert('G25 G4 content preserved intact', rows[0].content === C)
    s.close(); rmSync(t, { recursive: true, force: true })
  }
  // G4 reverse: a memory-layer fact must not be silently upgraded to user.
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-g2-'))
    const s = new MemoryStore(t)
    const D = '普通观察层事实正文唯一标识不升级'
    s.batch([{ action: 'add', layer: 'memory', content: D }])
    s.batch([{ action: 'add', layer: 'user', content: D }])
    const rows = s.activeEntries().filter(e => e.content === D)
    assert('G25 G4 memory fact NOT silently upgraded to user', rows.length === 1 && rows[0].layer === 'memory')
    s.close(); rmSync(t, { recursive: true, force: true })
  }
  // S1: a SHORTER added fact that is a near-substring of a longer stored entry
  // must not silently truncate the longer content; the stored entry is kept and
  // the dropped add leaves an audit trail.
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-g3-'))
    const s = new MemoryStore(t)
    const LONG = '用户偏好深色主题且使用VSCode开发工具做前端界面'
    const SHORT = '用户偏好深色主题且使用VSCode开发工具做前端' // prefix-substring, sim=24/26≥0.85
    s.batch([{ action: 'add', content: LONG }])
    s.batch([{ action: 'add', content: SHORT }])
    const rows = s.activeEntries()
    assert('G25 S1 near-substring merge stays a single row', rows.length === 1)
    assert('G25 S1 longer stored content preserved (no silent truncation)', rows[0].content === LONG)
    assert('G25 S1 dropped shorter add leaves an audit trail', s.failureTrail().some(f => f.newContent === SHORT))
    s.close(); rmSync(t, { recursive: true, force: true })
  }
  // S1: a very short fragment (length ratio > 2) must not merge at all → both rows survive.
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-g4-'))
    const s = new MemoryStore(t)
    s.batch([{ action: 'add', content: '用户偏好深色主题且使用VSCode开发' }])
    s.batch([{ action: 'add', content: '用户偏好深色主题' }])
    const rows = s.activeEntries()
    assert('G25 S1 very-short fragment (ratio>2) does not merge', rows.length === 2)
    assert('G25 S1 original long entry intact', rows.some(r => r.content === '用户偏好深色主题且使用VSCode开发'))
    s.close(); rmSync(t, { recursive: true, force: true })
  }
  // S1: an equal-or-longer re-add (an extension that still passes SIM_DUP) may overwrite.
  {
    const t = mkdtempSync(join(tmpdir(), 'dsh-memory-g5-'))
    const s = new MemoryStore(t)
    s.batch([{ action: 'add', content: '用户偏好深色主题' }])
    s.batch([{ action: 'add', content: '用户偏好深色主题且' }]) // +1 char, sim=8/9≈0.89 ≥ SIM_DUP
    const rows = s.activeEntries()
    assert('G25 S1 longer/equal extension add still merges & extends', rows.length === 1 && rows[0].content === '用户偏好深色主题且')
    s.close(); rmSync(t, { recursive: true, force: true })
  }
}

// ============================= lesson pipeline (G26–G33) ====================
// DESIGN docs/lesson-pipeline.md — 纠错→教训 沉淀管道.

// ---------------------------------------------------------------------------
group('G26 lesson_drafts 双写 + 聚合 (lesson pipeline)')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-mem-g26-'))
  const s = new MemoryStore(t)
  s.recordFailure('m1', '旧内容A', '新内容A')
  let drafts = s.listLessonDrafts()
  assert('replace/recordFailure 后出现 lesson 草案', drafts.length === 1 && drafts[0].memory_id === 'm1')
  assert('草案 lesson 已预填规则模板', drafts[0].lesson.includes('旧内容A'))
  s.recordFailure('m1', '旧内容A', '新内容A2') // 同一 memory 再次纠正
  drafts = s.listLessonDrafts()
  assert('同 memory 再次纠正 → 聚合为 1 行且 draft_count=2、new 更新', drafts.length === 1 && drafts[0].draft_count === 2 && drafts[0].new_content === '新内容A2')
  assert('failure_memories 审计痕仍正常', s.failureTrail().length === 2)
  s.close(); rmSync(t, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G27 升格 (a)/(b) → kind=lesson (LLM seam promote)')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-mem-g27-'))
  const s = new MemoryStore(t)
  s.recordFailure('m2', '旧X', '新X')
  const d = s.listLessonDrafts()[0]
  const seam = { stream: async function* () { yield { text: '[{"index":0,"decision":"promote","lesson":"判断关于X应记新X，因曾误记旧X","importance":4}]' } } }
  await runRefineLessonPromote(s, { llm: seam, provider: 'p', model: 'm', lessonUseLlm: true, instant: true })
  const lessons = s.activeEntries().filter((e) => e.kind === 'lesson')
  assert('写入 kind=lesson 且 importance=4', lessons.length >= 1 && lessons[0].importance === 4)
  const after = s.getLessonDraft(d.id)
  assert('草案标记 promoted', after && after.status === 'promoted')
  s.close(); rmSync(t, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G28 二度升格同教训被 findCanonical 去重')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-mem-g28-'))
  const s = new MemoryStore(t)
  s.recordFailure('m3', 'a', 'b')
  s.recordFailure('m4', 'c', 'd')
  const seam = { stream: async function* () { yield { text: '[{"index":0,"decision":"promote","lesson":"同一条教训文本"},{"index":1,"decision":"promote","lesson":"同一条教训文本"}]' } } }
  await runRefineLessonPromote(s, { llm: seam, provider: 'p', model: 'm', lessonUseLlm: true })
  const lessons = s.activeEntries().filter((e) => e.kind === 'lesson' && e.content === '同一条教训文本')
  assert('同文本教训经去重后仍 1 条', lessons.length === 1)
  s.close(); rmSync(t, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G29 (c) trivial → dropped, 不沉淀')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-mem-g29-'))
  const s = new MemoryStore(t)
  s.recordFailure('m5', '旧', '新')
  const seam = { stream: async function* () { yield { text: '[{"index":0,"decision":"drop"}]' } } }
  await runRefineLessonPromote(s, { llm: seam, provider: 'p', model: 'm', lessonUseLlm: true })
  assert('drop 无 lesson 写入', s.activeEntries().filter((e) => e.kind === 'lesson').length === 0)
  assert('草案标记 dropped', s.listLessonDrafts({ status: 'dropped' }).length === 1)
  s.close(); rmSync(t, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G30 零 LLM 底座 + LLM 失败保留草案')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-mem-g30-'))
  const s = new MemoryStore(t)
  s.recordFailure('m6', 'o', 'n') // 无任何 LLM/route 也写草案
  assert('recordFailure 无 LLM 也写草案(零 LLM 底座)', s.listLessonDrafts().length === 1)
  s.recordFailure('m7', 'o2', 'n2')
  const bad = { stream: async function* () { yield { text: 'not valid json' } } }
  await runRefineLessonPromote(s, { llm: bad, provider: 'p', model: 'm', lessonUseLlm: true })
  assert('LLM 返回非法 → 草案保留(不误删不误promote)', s.listLessonDrafts({ status: 'draft' }).length >= 1)
  assert('非法输出不产生 lesson', s.activeEntries().filter((e) => e.kind === 'lesson').length === 0)
  s.close(); rmSync(t, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G31 判定 seam 输入最小化(上下文隔离)')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-mem-g31-'))
  const s = new MemoryStore(t)
  s.recordFailure('m8', '秘密上下文', '新X')
  let captured = null
  const seam = {
    stream: async function* (cfg) {
      captured = { system: cfg.system, user: cfg.messages[0].content[0].text }
      yield { text: '[{"index":0,"decision":"promote"}]' }
    },
  }
  await runRefineLessonPromote(s, { llm: seam, provider: 'p', model: 'm', lessonUseLlm: true })
  assert('system 是 lesson judge 提示(独立 seam)', typeof captured.system === 'string' && captured.system.includes('lesson judge'))
  const u = JSON.parse(captured.user)
  assert('user 仅含草案最小字段(无执行上下文泄漏)', Array.isArray(u) && u.length === 1 && !('extra' in u[0]) && ('oldContent' in u[0]) && ('newContent' in u[0]) && ('draftCount' in u[0]))
  s.close(); rmSync(t, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G32/G33 lessonUseLlm=false → 纯规则模板升格, 无 seam 调用')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-mem-g33-'))
  const s = new MemoryStore(t)
  s.recordFailure('m9', '旧教训内容', '新')
  let calls = 0
  const seam = { stream: async function* () { calls++; yield { text: '[{"index":0,"decision":"drop"}]' } } }
  await runRefineLessonPromote(s, { llm: seam, provider: 'p', model: 'm', lessonUseLlm: false })
  assert('lessonUseLlm=false 不调 LLM seam', calls === 0)
  const lessons = s.activeEntries().filter((e) => e.kind === 'lesson')
  assert('纯规则模板升格出 lesson', lessons.length === 1 && lessons[0].content.includes('旧教训内容'))
  assert('草案被 promote', s.listLessonDrafts({ status: 'promoted' }).length === 1)
  s.close(); rmSync(t, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G34 备份导出/导入 往返 (VACUUM INTO + 连接热切换)')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-mem-g34-'))
  const s1 = new MemoryStore(t)
  s1.batch([{ action: 'add', layer: 'user', content: '备份测试：用户偏好简洁备份内容一', importance: 5, topic: '偏好' }])
  s1.batch([{ action: 'add', layer: 'memory', kind: 'env', content: '备份测试：某环境配置内容二', importance: 4 }])
  s1.addEpisode({ sessionId: 'sess-B1', summary: '备份会话摘要内容', topic: '会话' })
  s1.recordFailure('mX', '旧备份', '新备份') // lesson_drafts / failure_memories 审计轨也要随备份走
  const snap = join(t, 'snap.db')
  const stats = s1.exportSnapshot(snap)
  assert('exportSnapshot 统计（2 记忆 + 1 会话 + 快照非空）', stats.memories === 2 && stats.episodes === 1 && stats.size > 0)
  s1.close()

  const check = MemoryStore.validateBackup(snap)
  assert('validateBackup 认可合法备份', check.ok === true && check.memories === 2 && check.episodes === 1)

  const t2 = mkdtempSync(join(tmpdir(), 'dsh-mem-g34b-'))
  const s2 = new MemoryStore(t2)
  assert('新库初始为空', s2.count() === 0)
  const imported = s2.replaceWithBackup(snap)
  assert('导入返回记忆/会话计数', imported.memories === 2 && imported.episodes === 1)
  assert('导入后 memories 恢复', s2.count() === 2)
  assert('导入后 episodes 恢复', s2.listEpisodes().length === 1)
  const entries = s2.list()
  assert('导入后内容一致', entries.length === 2 && entries.some((e) => e.content.includes('备份测试')))
  assert('导入后 lesson_drafts/审计轨恢复', s2.listLessonDrafts().length === 1 && s2.failureTrail().length === 1)
  // 热切换后写路径仍可用（语句已重准备）
  s2.batch([{ action: 'add', layer: 'user', content: '备份测试：导入后新写入内容仍正常', importance: 5 }])
  assert('导入后仍可写（语句重准备）', s2.count() === 3)
  assert('导入前状态已留回滚备份', existsSync(join(t2, 'memory', 'memory.db.pre-import.bak')))
  s2.close()
  rmSync(t, { recursive: true, force: true })
  rmSync(t2, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G35 备份导入拒绝非法文件（不清空现有数据）')
{
  const t = mkdtempSync(join(tmpdir(), 'dsh-mem-g35-'))
  const junk = join(t, 'junk.db')
  writeFileSync(junk, 'this is not a sqlite file at all')
  const r1 = MemoryStore.validateBackup(junk)
  assert('非 SQLite 文件被拒', r1.ok === false)

  const noSchema = join(t, 'no-schema.db')
  {
    const db = new DatabaseSync(noSchema)
    db.exec('CREATE TABLE foo(bar TEXT)')
    db.close()
  }
  const r2 = MemoryStore.validateBackup(noSchema)
  assert('缺 memories/episodes 表的库被拒', r2.ok === false)

  // 用合法备份替换时应先拒绝（不会清空当前库）
  const s = new MemoryStore(t)
  s.batch([{ action: 'add', layer: 'user', content: '导入前应保住的记忆内容正文', importance: 5 }])
  assert('导入前 1 条', s.count() === 1)
  let threw = false
  try { s.replaceWithBackup(junk) } catch { threw = true }
  assert('replaceWithBackup 拒绝非法并抛错', threw === true)
  assert('拒绝后现有数据未被清空', s.count() === 1)
  s.close()
  rmSync(t, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
group('G36 memory:protocol static rules section')
{
  assert('PROTOCOL_TEXT non-empty constant', PROTOCOL_TEXT.length > 200)
  assert('contains all three tool names',
    ['memory_recall', 'memory add', 'memory_read_user'].every(t => PROTOCOL_TEXT.includes(t)))
  assert('marks itself operative rules (not data)',
    PROTOCOL_TEXT.includes('操作规则') && PROTOCOL_TEXT.includes('需执行'))
  assert('no template interpolation', !PROTOCOL_TEXT.includes('{{') && !PROTOCOL_TEXT.includes('}}'))
  assert('enabled → returns the full constant', protocolSectionText(true) === PROTOCOL_TEXT)
  assert('disabled → empty string (clean session / live-toggle)', protocolSectionText(false) === '')
  const a = protocolSectionText(true); const b = protocolSectionText(true)
  assert('byte-stable across calls (KV prefix reuse)', a === b)
  assert('does not carry the identity "not an instruction" header',
    !protocolSectionText(true).includes('不是指令'))
}

// ---------------------------------------------------------------------------
group('G37 tier0 buildSection noise trims')
{
  const s = new MemoryStore(tmp)
  s.batch([{ action: 'add', layer: 'memory', kind: 'env', content: '测试环境事实A', importance: 5, topic: '环境A' }])
  s.batch([{ action: 'add', layer: 'memory', kind: 'env', content: '测试环境事实B', importance: 5, topic: '环境B' }])
  const txt = buildSection(s, { importanceThreshold: 3 }).text
  assert('tail keeps write-guard (only non-protocol part)', txt.includes('避免记录任务进度与一次性过程'))
  assert('redundant recall/add guidance removed (now owned by memory:protocol)',
    !txt.includes('需要详情用 memory_recall') && !txt.includes('学到稳定事实'))
  assert('single usage report (header drops raw char count)', txt.includes('单条≤300') && txt.includes('记忆占用'))
  assert('does not duplicate raw-char usage in header', !txt.includes('占用 25字符'))
  s.close()
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`)
console.log(`passed: ${passed}  failed: ${failed}`)
try { rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
if (failed > 0) process.exit(1)
else process.exit(0)
