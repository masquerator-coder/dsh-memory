/**
 * dsh-memory — settings-UI panel (browser client, R3-ui 2026-08-31).
 *
 * Registers one `settings.section` entry ("记忆") in the dsh settings page, and
 * renders a restrained panel: master memory switch, user.md auto-maintenance
 * switch, condensation/maintenance cadence, peak-hour suppression switch, and
 * inline editors for soul.md / user.md (files stay the source of truth — the
 * editor talks to the host over /memory/identity).
 *
 * The panel reads/writes the `memory` settings namespace through
 * `ctx.settingsScope.bind({ namespace: 'memory' })`; toggles are live-applied by
 * the host plugin (scope.watch pushes into its runtime). Identity files are
 * fetched/saved over the host HTTP route.
 *
 * Kept intentionally minimal (克制): no custom chrome, no icons beyond native
 * inputs — the necessary information only.
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react'

/**
 * Memory/nav glyph — a neuron (soma + radiating dendrites + synapse nodes),
 * drawn standalone so the plugin carries its own settings icon without
 * importing any harness UI package. `currentColor` inherits the nav text
 * colour; the shell renders it ahead of its built-in gear fallback.
 */
function MemoryIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" fill="currentColor" />
      <path d="M8 5.9V3.2 M8 10.1V12.8 M5.9 8H3.2 M10.1 8H12.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="3.2" r="0.9" fill="currentColor" />
      <circle cx="8" cy="12.8" r="0.9" fill="currentColor" />
      <circle cx="3.2" cy="8" r="0.9" fill="currentColor" />
      <circle cx="12.8" cy="8" r="0.9" fill="currentColor" />
      <circle cx="4.7" cy="4.7" r="0.8" fill="currentColor" />
      <circle cx="11.3" cy="4.7" r="0.8" fill="currentColor" />
      <circle cx="4.7" cy="11.3" r="0.8" fill="currentColor" />
      <circle cx="11.3" cy="11.3" r="0.8" fill="currentColor" />
    </svg>
  )
}

interface MemorySettingsValue {
  enabled?: boolean
  forgetEnabled?: boolean
  refineIntervalMs?: number
  peakHourSuppress?: boolean
}

interface ScopeSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  value?: MemorySettingsValue
  writable: boolean
}

interface MemoryScope {
  getSnapshot(): ScopeSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

interface IdentityFiles {
  soul: string
  user: string
}

interface SaveResult {
  ok: boolean
  error?: string
}

/** Result of an immediate /memory/trigger pass. */
interface RunNowResult {
  refined: boolean
  forgetDemoted: number
  forgetArchivedMem: number
  forgetDeletedMem: number
  forgetArchivedEpi: number
  forgetDeletedEpi: number
}

/** One memory row from /memory/view. */
interface ViewMemory {
  id: string
  layer: string
  tier: number
  kind: string
  topic: string
  importance: number
  content: string
  created: number
  updated: number
}

/** Digest payload from /memory/view. */
interface ViewPayload {
  memories: ViewMemory[]
  memoryCount: number
  episodeCount: number
  topics: { topic: string; count: number }[]
  updatedMs: number
}

interface PanelProps {
  close?: () => void
  scope: MemoryScope
  loadIdentity: () => Promise<IdentityFiles>
  saveIdentity: (file: 'soul' | 'user', content: string) => Promise<SaveResult>
  /** Open one identity file in the machine's local editor. */
  openEditor: (file: 'soul' | 'user') => Promise<SaveResult>
  /** Run an immediate condensation / identity / forget pass. */
  runNow: () => Promise<RunNowResult>
  /** Fetch the memory digest for the viewer window. */
  loadMemoryView: () => Promise<ViewPayload>
}

/** Reactive snapshot value via the framework seat (scope.getSnapshot/subscribe). */
function useScope(scope: MemoryScope): ScopeSnapshot {
  const [snap, setSnap] = useState<ScopeSnapshot>(() => scope.getSnapshot())
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope])
  return snap
}

/** A labelled on/off switch backed by a scope field (live-applied). */
function Toggle(props: { label: string; hint: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void }): JSX.Element {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span style={{ flex: 1 }}>
        <div>{props.label}</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>{props.hint}</div>
      </span>
    </label>
  )
}

/** A textarea editor with a save button and an "open in local editor" button.
 *  Save is optimistic-free (revert on error).
 *  A8 (2026-09-01): show error feedback when save fails (e.g. 403 on LAN bind).
 *  2026-09-02: the 打开编辑 button opens the on-disk file in the machine's
 *  default editor via the host; the file stays the source of truth. */
function FileEditor(props: { label: string; value: string; onSave: (content: string) => Promise<{ ok: boolean; error?: string }>; onOpen?: () => Promise<{ ok: boolean; error?: string }> }): JSX.Element {
  const [draft, setDraft] = useState(props.value)
  const [saving, setSaving] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { setDraft(props.value); setError(null) }, [props.value])
  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const result = await props.onSave(draft)
    setSaving(false)
    if (!result.ok) {
      setDraft(props.value) // rollback on failure
      setError(result.error ?? '保存失败，请检查网络或权限')
    } else {
      setNote('已保存')
    }
  }
  const open = async (): Promise<void> => {
    if (!props.onOpen) return
    setOpening(true)
    setError(null)
    setNote(null)
    const result = await props.onOpen()
    setOpening(false)
    if (!result.ok) {
      setError(result.error ?? '无法打开本地编辑器')
    } else {
      setNote('已在本地编辑器中打开。外部修改后请点“保存”同步，或刷新页面。')
    }
  }
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{props.label}</div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 13, padding: 8 }}
      />
      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" disabled={saving} onClick={() => { void save() }}>
          {saving ? '保存中…' : '保存'}
        </button>
        {props.onOpen && (
          <button type="button" disabled={opening} onClick={() => { void open() }}>
            {opening ? '打开中…' : '打开编辑'}
          </button>
        )}
        {note && <span style={{ fontSize: 12, opacity: 0.8 }}>{note}</span>}
      </div>
      {error && <div style={{ marginTop: 6, color: '#c00', fontSize: 12 }}>{error}</div>}
    </div>
  )
}

/** A simple modal overlay used to show the memory viewer. */
function PanelModal(props: { title: string; onClose: () => void; children: ReactNode }): JSX.Element {
  return (
    <div
      onClick={props.onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#1e1e1e', color: '#eee', width: 'min(760px, 92vw)', maxHeight: '80vh', borderRadius: 8, display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.12)' }}>
          <div style={{ fontWeight: 600 }}>{props.title}</div>
          <button type="button" onClick={props.onClose} style={{ background: 'none', border: 'none', color: '#ccc', fontSize: 18, cursor: 'pointer' }} aria-label="关闭">×</button>
        </div>
        <div style={{ overflow: 'auto', padding: 14 }}>{props.children}</div>
      </div>
    </div>
  )
}

function MemorySettingsPanel(props: PanelProps): JSX.Element {
  const snap = useScope(props.scope)
  const value = snap.value ?? {}
  const ready = snap.status === 'ready' && snap.writable
  const [identity, setIdentity] = useState<IdentityFiles>({ soul: '', user: '' })
  const [triggering, setTriggering] = useState(false)
  const [triggerResult, setTriggerResult] = useState<string | null>(null)
  const [triggerError, setTriggerError] = useState<string | null>(null)
  const [viewOpen, setViewOpen] = useState(false)
  const [viewLoading, setViewLoading] = useState(false)
  const [view, setView] = useState<ViewPayload | null>(null)
  const [viewError, setViewError] = useState<string | null>(null)
  useEffect(() => {
    props.loadIdentity().then(setIdentity).catch(() => { /* route absent: keep empty */ })
  }, [props.loadIdentity])

  const set = (field: string, next: unknown): void => { void props.scope.set(field, next) }

  const runNow = async (): Promise<void> => {
    setTriggering(true)
    setTriggerResult(null)
    setTriggerError(null)
    try {
      const r = await props.runNow()
      setTriggerResult(
        `整理完成：凝练${r.refined ? '已执行' : '已跳过（无待整理或无 LLM 路由）'}；` +
        `遗忘：降级 ${r.forgetDemoted}、归档记忆 ${r.forgetArchivedMem}、删除记忆 ${r.forgetDeletedMem}、归档会话 ${r.forgetArchivedEpi}、删除会话 ${r.forgetDeletedEpi}`,
      )
    } catch (e) {
      setTriggerError(e instanceof Error ? e.message : '触发失败')
    } finally {
      setTriggering(false)
    }
  }

  const openViewer = async (): Promise<void> => {
    setViewOpen(true)
    setViewLoading(true)
    setViewError(null)
    try {
      setView(await props.loadMemoryView())
    } catch (e) {
      setViewError(e instanceof Error ? e.message : '读取记忆失败')
    } finally {
      setViewLoading(false)
    }
  }

  const layerLabel = (l: string): string => l === 'user' ? '用户' : l === 'memory' ? '记忆' : l
  const kindLabel = (k: string): string =>
    k === 'preference' ? '偏好' : k === 'env' ? '环境' : k === 'lesson' ? '经验' : k === 'decision' ? '决策' : '一般'

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Toggle
        label="记忆总开关"
        hint="关闭后新会话不注入任何记忆（清洁会话），后台整理/遗忘/维护全停"
        checked={value.enabled ?? true}
        disabled={!ready}
        onChange={(next) => set('enabled', next)}
      />
      <Toggle
        label="忙闲时段抑制扫描"
        hint="峰时（默认北京 09–12 / 14–18）跳过后台 LLM 凝练，省 API 费用"
        checked={value.peakHourSuppress ?? true}
        disabled={!ready}
        onChange={(next) => set('peakHourSuppress', next)}
      />
      <Toggle
        label="主动遗忘"
        hint="关闭后暂停热度衰减记忆的降级/归档/硬删（仅暂停，不清理已有记忆）"
        checked={value.forgetEnabled ?? true}
        disabled={!ready}
        onChange={(next) => set('forgetEnabled', next)}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
        <span style={{ flex: 1 }}>
          <div>凝练整理时间间隔（小时）</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>后台 L1/L2 抽取与去重的周期扫描；改小更及时、更费 API，改大更省。新会话后 10 秒内仍会即时凝练一次</div>
        </span>
        <input
          type="number"
          min={0.1}
          step={0.5}
          disabled={!ready}
          value={Math.round(((value.refineIntervalMs ?? 3600_000) / 3600_000) * 10) / 10}
          onChange={(e) => {
            const h = Math.max(0.1, Number(e.target.value) || 1)
            set('refineIntervalMs', Math.round(h * 3600_000))
          }}
          style={{ width: 64 }}
        />
      </label>

      <div style={{ display: 'flex', gap: 8, padding: '10px 0', borderTop: '1px solid rgba(128,128,128,0.25)', marginTop: 4 }}>
        <button type="button" disabled={triggering} onClick={() => { void runNow() }} style={{ padding: '6px 10px' }}>
          {triggering ? '整理中…' : '立即整理记忆'}
        </button>
        <button type="button" onClick={() => { void openViewer() }} style={{ padding: '6px 10px' }}>
          {'查看记忆'}
        </button>
      </div>
      {triggerResult && <div style={{ fontSize: 12, color: '#0a7a2f', whiteSpace: 'pre-wrap' }}>{triggerResult}</div>}
      {triggerError && <div style={{ fontSize: 12, color: '#c00' }}>{triggerError}</div>}

      <FileEditor
        label="soul.md（AI 人格/行为准则，人写）"
        value={identity.soul}
        onSave={(content) => props.saveIdentity('soul', content)}
        onOpen={() => props.openEditor('soul')}
      />
      <FileEditor
        label="user.md（用户画像，可编辑）"
        value={identity.user}
        onSave={(content) => props.saveIdentity('user', content)}
        onOpen={() => props.openEditor('user')}
      />

      {viewOpen && (
        <PanelModal title="记忆查看" onClose={() => setViewOpen(false)}>
          {viewLoading && <div style={{ opacity: 0.7 }}>读取中…</div>}
          {viewError && <div style={{ color: '#c00', fontSize: 12 }}>{viewError}</div>}
          {!viewLoading && view && (
            <>
              <div style={{ display: 'flex', gap: 16, opacity: 0.85, fontSize: 13, marginBottom: 8 }}>
                <span>有效记忆 <b>{view.memoryCount}</b> 条</span>
                <span>会话摘要 <b>{view.episodeCount}</b> 条</span>
                <span>主题 <b>{view.topics.length}</b> 个</span>
              </div>
              {view.topics.length > 0 && (
                <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                  主题：{view.topics.slice(0, 12).map((t) => `${t.topic}(${t.count})`).join('、')}
                </div>
              )}
              {view.memories.length === 0
                ? <div style={{ opacity: 0.6, fontSize: 13 }}>暂无有效记忆。</div>
                : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>层级</th>
                        <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>类型</th>
                        <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>主题</th>
                        <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>内容</th>
                        <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>重要</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.memories.map((m) => (
                        <tr key={m.id}>
                          <td style={{ padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.06)', whiteSpace: 'nowrap' }}>
                            {layerLabel(m.layer)}{m.tier === 0 ? '·T0' : ''}
                          </td>
                          <td style={{ padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.06)', whiteSpace: 'nowrap' }}>{kindLabel(m.kind)}</td>
                          <td style={{ padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{m.topic}</td>
                          <td style={{ padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{m.content}</td>
                          <td style={{ padding: '4px 6px', borderBottom: '1px solid rgba(255,255,255,0.06)', textAlign: 'right' }}>{m.importance}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </>
          )}
        </PanelModal>
      )}
    </div>
  )
}

export const inject = ['slots', 'settingsScope']

/**
 * P3-10 (review 2026-08-31): minimal structural types for the host seams the
 * client entry consumes — replaced the old `apply(ctx: any)` + eslint-disable,
 * so client-side checking stays on without importing any harness package.
 * (Same idea as the server entry's `declare module` augmentation.)
 */
interface ClientSlots {
  inject(slot: string, factory: () => unknown): () => void
  register(registration: Record<string, unknown>, component: (props: PanelProps) => JSX.Element): unknown
}

interface ClientContext {
  settingsScope: { bind(opts: { namespace: string }): MemoryScope }
  slots: ClientSlots
}

export function apply(ctx: ClientContext): () => void {
  const scope: MemoryScope = ctx.settingsScope.bind({ namespace: 'memory' })

  const loadIdentity = async (): Promise<IdentityFiles> => {
    const resp = await fetch('/memory/identity', { cache: 'no-store' })
    if (!resp.ok) return { soul: '', user: '' }
    const data = await resp.json() as Partial<IdentityFiles>
    return { soul: typeof data.soul === 'string' ? data.soul : '', user: typeof data.user === 'string' ? data.user : '' }
  }
  const saveIdentity = async (file: 'soul' | 'user', content: string): Promise<SaveResult> => {
    try {
      const resp = await fetch('/memory/identity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, content }),
      })
      if (resp.ok) return { ok: true }
      const data = await resp.json().catch(() => ({}))
      return { ok: false, error: data.error ?? `HTTP ${resp.status}: ${resp.statusText}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '网络错误' }
    }
  }

  /** Open one identity file in the machine's default editor (host spawns it). */
  const openEditor = async (file: 'soul' | 'user'): Promise<SaveResult> => {
    try {
      const resp = await fetch('/memory/identity/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file }),
      })
      if (resp.ok) return { ok: true }
      const data = await resp.json().catch(() => ({}))
      return { ok: false, error: data.error ?? `HTTP ${resp.status}: ${resp.statusText}` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '网络错误' }
    }
  }

  /** Trigger an immediate condensation / identity / forget pass. */
  const runNow = async (): Promise<RunNowResult> => {
    const resp = await fetch('/memory/trigger', { method: 'POST', headers: { 'content-type': 'application/json' } })
    const data = await resp.json().catch(() => ({})) as Partial<{ ok: boolean; result: RunNowResult; error: string }>
    if (!resp.ok || !data.ok) throw new Error(data.error ?? `HTTP ${resp.status}`)
    return data.result ?? {
      refined: false,
      forgetDemoted: 0, forgetArchivedMem: 0, forgetDeletedMem: 0,
      forgetArchivedEpi: 0, forgetDeletedEpi: 0,
    }
  }

  /** Fetch the memory digest for the viewer window. */
  const loadMemoryView = async (): Promise<ViewPayload> => {
    const resp = await fetch('/memory/view', { cache: 'no-store' })
    const data = await resp.json().catch(() => ({})) as { ok?: boolean; memories?: ViewMemory[]; memoryCount?: number; episodeCount?: number; topics?: { topic: string; count: number }[]; updatedMs?: number; error?: string }
    if (!resp.ok || !data.ok) throw new Error(data.error ?? `HTTP ${resp.status}`)
    return {
      memories: Array.isArray(data.memories) ? data.memories : [],
      memoryCount: data.memoryCount ?? 0,
      episodeCount: data.episodeCount ?? 0,
      topics: Array.isArray(data.topics) ? data.topics : [],
      updatedMs: data.updatedMs ?? Date.now(),
    }
  }

  const dispose = ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'memory',
      order: 50,
      label: () => '记忆',
      icon: <MemoryIcon />,
      inject: () => ({ scope, loadIdentity, saveIdentity, openEditor, runNow, loadMemoryView }),
    },
    MemorySettingsPanel,
  ))
  return () => { dispose() }
}
