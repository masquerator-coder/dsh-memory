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
import { useEffect, useState, type JSX } from 'react'

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
  identityAuto?: boolean
  identityIntervalMs?: number
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

interface PanelProps {
  close?: () => void
  scope: MemoryScope
  loadIdentity: () => Promise<IdentityFiles>
  saveIdentity: (file: 'soul' | 'user', content: string) => Promise<boolean>
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

/** A textarea editor with a save button; save is optimistic-free (revert on error). */
function FileEditor(props: { label: string; value: string; onSave: (content: string) => Promise<boolean> }): JSX.Element {
  const [draft, setDraft] = useState(props.value)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(props.value), [props.value])
  const save = async (): Promise<void> => {
    setSaving(true)
    const ok = await props.onSave(draft)
    setSaving(false)
    if (!ok) setDraft(props.value) // rollback on failure
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
      <button type="button" disabled={saving} onClick={() => { void save() }} style={{ marginTop: 6 }}>
        {saving ? '保存中…' : '保存'}
      </button>
    </div>
  )
}

function MemorySettingsPanel(props: PanelProps): JSX.Element {
  const snap = useScope(props.scope)
  const value = snap.value ?? {}
  const ready = snap.status === 'ready' && snap.writable
  const [identity, setIdentity] = useState<IdentityFiles>({ soul: '', user: '' })
  useEffect(() => {
    props.loadIdentity().then(setIdentity).catch(() => { /* route absent: keep empty */ })
  }, [props.loadIdentity])

  const set = (field: string, next: unknown): void => { void props.scope.set(field, next) }

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
          <div>身份维护扫描间隔（小时）</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>身份维护扫描周期（在配置中开启 identityAuto 后生效）</div>
        </span>
        <input
          type="number"
          min={1}
          step={1}
          disabled={!ready}
          value={Math.round((value.identityIntervalMs ?? 6 * 3600_000) / 3600_000)}
          onChange={(e) => {
            const h = Math.max(1, Math.round(Number(e.target.value) || 1))
            set('identityIntervalMs', h * 3600_000)
          }}
          style={{ width: 64 }}
        />
      </label>
      <FileEditor label="soul.md（AI 人格/行为准则，人写）" value={identity.soul} onSave={(content) => props.saveIdentity('soul', content)} />
      <FileEditor label="user.md（用户画像，可编辑）" value={identity.user} onSave={(content) => props.saveIdentity('user', content)} />
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
  const saveIdentity = async (file: 'soul' | 'user', content: string): Promise<boolean> => {
    try {
      const resp = await fetch('/memory/identity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file, content }),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  const dispose = ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'memory',
      order: 50,
      label: () => '记忆',
      icon: <MemoryIcon />,
      inject: () => ({ scope, loadIdentity, saveIdentity }),
    },
    MemorySettingsPanel,
  ))
  return () => { dispose() }
}
