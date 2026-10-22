window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback

    /** Namespace for this page's texts; mirrors `locale/*.json`. */
    const NS = 'dsh-memory'

    /**
     * The page's own dictionaries. They repeat `locale/zh.json` and
     * `locale/en.json` because the browser artifact is a self-contained script:
     * the loader reads those JSON files for display metadata, but the running
     * page cannot import them. Keep the three in sync.
     */
    /** Dictionary injected at build time from locale/zh.json and locale/en.json. */
    const ZH = {
      "meta.title": "记忆",
      "meta.description": "把 memory_system 的长期记忆接入 DSH：注入记忆摘要锚点、采集会话、在设置页里生成与编辑记忆。",
      "nav.title": "记忆",
      "common.save": "保存",
      "common.saving": "保存中…",
      "common.saved": "已保存",
      "common.cancel": "取消",
      "common.close": "关闭",
      "common.refresh": "刷新",
      "common.loading": "加载中…",
      "common.empty": "暂无内容",
      "common.error": "出错了",
      "common.retry": "重试",
      "common.confirm": "确定",
      "common.delete": "删除",
      "common.copy": "复制",
      "common.copied": "已复制",
      "common.download": "下载",
      "common.keywords": "关键词",
      "common.search": "搜索",
      "common.reset": "重置",
      "status.connected": "记忆库已连接",
      "status.disconnected": "记忆库未连接",
      "status.project": "当前项目",
      "status.memories": "记忆条目",
      "status.digest": "记忆摘要",
      "status.noDigest": "还没有生成摘要",
      "status.digestAt": "{time} 生成 · {chars} 字",
      "status.digestStale": "摘要已过时，建议重新生成",
      "status.home": "存储位置",
      "status.python": "Python",
      "status.pythonMissing": "找不到可用的 Python 解释器，请在插件配置中设置 pythonPath。",
      "status.latency": "{ms} ms",
      "length.title": "记忆摘要长度",
      "length.hint": "注入系统提示词的记忆摘要预算上限。摘要由模型生成，实际长度通常远小于预算。",
      "length.preset": "{n} 字",
      "length.custom": "自定义",
      "length.customPlaceholder": "输入 1000 到 4000000 之间的字符数",
      "length.invalid": "请输入 {min} 到 {max} 之间的数字",
      "length.current": "当前预算：{n} 字（约 {tokens} tokens）",
      "auto.title": "自动生成摘要",
      "auto.hint": "开启后，每次对话回合结束后自动用当前模型生成一次记忆摘要。",
      "auto.off": "关闭",
      "auto.debounced": "回合结束后（防抖）",
      "auto.idle": "空闲时",
      "profile.title": "用户画像",
      "profile.hint": "写给人看的自我介绍：偏好、习惯、技术栈、沟通方式。记忆摘要与助手都会参考它，系统提示词里会提示模型可以查看画像。",
      "profile.placeholder": "例如：\n- 中文回答，代码注释用中文\n- 主要写 TypeScript 与 Python\n- 喜欢先给结论再展开",
      "profile.charCount": "{n} / {max} 字",
      "profile.saved": "用户画像已保存",
      "digest.title": "记忆摘要",
      "digest.generate": "记忆摘要生成",
      "digest.view": "查看记忆摘要",
      "digest.generating": "正在生成摘要…",
      "digest.generated": "摘要已更新",
      "digest.generatedAt": "生成于 {time}",
      "digest.chars": "{n} 字 · 约 {tokens} tokens",
      "digest.status": "状态",
      "digest.statusOk": "正常",
      "digest.statusTruncated": "已按预算截断",
      "digest.statusEmpty": "无内容",
      "digest.statusError": "生成失败",
      "digest.history": "历史摘要",
      "digest.historyEmpty": "还没有历史版本",
      "digest.delete": "删除这版摘要",
      "digest.deleted": "摘要已删除",
      "digest.noContent": "还没有记忆摘要。先点上方按钮生成一次。",
      "digest.needMaterials": "记忆库还没有内容；先和助手聊几轮，或手动添加记忆。",
      "digest.failed": "生成失败：{message}",
      "digest.scopeProject": "当前项目",
      "digest.scopeGlobal": "全部项目",
      "digest.viewerTitle": "记忆摘要 · {scope}",
      "memories.title": "记忆查看与编辑",
      "memories.open": "记忆查看与编辑",
      "memories.count": "共 {total} 条",
      "memories.filterState": "状态",
      "memories.allStates": "全部状态",
      "memories.active": "有效",
      "memories.archived": "已归档",
      "memories.filterType": "类型",
      "memories.allTypes": "全部类型",
      "memories.allProjects": "全部项目",
      "memories.currentProject": "当前项目",
      "memories.searchPlaceholder": "搜索记忆内容…",
      "memories.summary": "内容",
      "memories.importance": "重要度",
      "memories.eventType": "类型",
      "memories.outcome": "结果",
      "memories.state": "状态",
      "memories.tags": "标签",
      "memories.tagsHint": "用逗号分隔",
      "memories.createdAt": "创建时间",
      "memories.project": "项目",
      "memories.noOutcome": "未记录",
      "memories.edit": "编辑",
      "memories.editTitle": "编辑记忆 · {id}",
      "memories.forget": "归档",
      "memories.restore": "恢复",
      "memories.forgot": "已归档，可随时恢复",
      "memories.restored": "已恢复",
      "memories.updated": "记忆已更新",
      "memories.confirmForget": "确定归档这条记忆吗？归档后默认检索不再返回它，但可以恢复。",
      "memories.page": "第 {page} 页",
      "memories.prev": "上一页",
      "memories.next": "下一页",
      "memories.selectHint": "从左侧选择一条记忆查看详情",
      "memories.summaryRequired": "记忆内容不能为空",
      "backup.title": "备份与恢复",
      "backup.hint": "备份是一个 Markdown 文件，可以直接阅读与编辑，也可以用它恢复记忆库。",
      "backup.export": "导出 Markdown 备份",
      "backup.exporting": "正在导出…",
      "backup.exported": "已导出 {chars} 字，共 {lines} 行",
      "backup.restore": "从 Markdown 恢复",
      "backup.restoreHint": "选择之前导出的 Markdown 文件。恢复只会新增条目，不会删除现有记忆。",
      "backup.preview": "预览恢复",
      "backup.apply": "确认恢复",
      "backup.cancel": "取消",
      "backup.dryRun": "将导入 {n} 条记忆",
      "backup.dryRunProfile": "同时恢复用户画像",
      "backup.done": "导入 {n} 条记忆，跳过 {skipped} 条",
      "backup.restoredProfile": "用户画像已恢复",
      "backup.noFile": "请选择一个 Markdown 文件",
      "backup.readFailed": "读取文件失败：{message}",
      "errors.loadFailed": "加载失败：{message}",
      "errors.saveFailed": "保存失败：{message}",
      "errors.unknown": "未知错误",
    }
    const EN = {
      "meta.title": "Memory",
      "meta.description": "Brings memory_system's long-term memory into DSH: a memory anchor in the system prompt, session capture, and a settings page to generate and edit memories.",
      "nav.title": "Memory",
      "common.save": "Save",
      "common.saving": "Saving…",
      "common.saved": "Saved",
      "common.cancel": "Cancel",
      "common.close": "Close",
      "common.refresh": "Refresh",
      "common.loading": "Loading…",
      "common.empty": "Nothing here yet",
      "common.error": "Something went wrong",
      "common.retry": "Retry",
      "common.confirm": "Confirm",
      "common.delete": "Delete",
      "common.copy": "Copy",
      "common.copied": "Copied",
      "common.download": "Download",
      "common.keywords": "Keywords",
      "common.search": "Search",
      "common.reset": "Reset",
      "status.connected": "Memory store connected",
      "status.disconnected": "Memory store unavailable",
      "status.project": "Current project",
      "status.memories": "Memories",
      "status.digest": "Memory digest",
      "status.noDigest": "No digest yet",
      "status.digestAt": "Generated {time} · {chars} chars",
      "status.digestStale": "The digest looks stale; regenerating is recommended",
      "status.home": "Storage",
      "status.python": "Python",
      "status.pythonMissing": "No usable Python interpreter was found. Set pythonPath in the plugin configuration.",
      "status.latency": "{ms} ms",
      "length.title": "Digest length",
      "length.hint": "Budget ceiling for the digest injected into the system prompt. A model writes the digest, so the real length is usually far below the budget.",
      "length.preset": "{n} chars",
      "length.custom": "Custom",
      "length.customPlaceholder": "Enter a value between 1000 and 4000000",
      "length.invalid": "Enter a number between {min} and {max}",
      "length.current": "Current budget: {n} chars (about {tokens} tokens)",
      "auto.title": "Generate digests automatically",
      "auto.hint": "When enabled, each settled turn triggers one digest generation with the current model.",
      "auto.off": "Off",
      "auto.debounced": "After each turn (debounced)",
      "auto.idle": "When idle",
      "profile.title": "User profile",
      "profile.hint": "A short introduction for the assistant: preferences, habits, stack, communication style. Digests and the assistant both consult it, and the system prompt tells the model it can read it.",
      "profile.placeholder": "For example:\n- Answer in Chinese, comment code in Chinese\n- Mostly TypeScript and Python\n- Prefer the conclusion first, then the detail",
      "profile.charCount": "{n} / {max} chars",
      "profile.saved": "User profile saved",
      "digest.title": "Memory digest",
      "digest.generate": "记忆摘要生成",
      "digest.view": "查看记忆摘要",
      "digest.generating": "Generating the digest…",
      "digest.generated": "Digest updated",
      "digest.generatedAt": "Generated {time}",
      "digest.chars": "{n} chars · about {tokens} tokens",
      "digest.status": "Status",
      "digest.statusOk": "OK",
      "digest.statusTruncated": "Clipped to budget",
      "digest.statusEmpty": "Empty",
      "digest.statusError": "Failed",
      "digest.history": "Earlier digests",
      "digest.historyEmpty": "No earlier versions",
      "digest.delete": "Delete this digest",
      "digest.deleted": "Digest deleted",
      "digest.noContent": "No digest yet. Use the button above to generate one.",
      "digest.needMaterials": "The memory store is still empty; chat for a few turns or add a memory first.",
      "digest.failed": "Generation failed: {message}",
      "digest.scopeProject": "This project",
      "digest.scopeGlobal": "All projects",
      "digest.viewerTitle": "Memory digest · {scope}",
      "memories.title": "Browse and edit memories",
      "memories.open": "记忆查看与编辑",
      "memories.count": "{total} entries",
      "memories.filterState": "State",
      "memories.allStates": "All states",
      "memories.active": "Active",
      "memories.archived": "Archived",
      "memories.filterType": "Type",
      "memories.allTypes": "All types",
      "memories.allProjects": "All projects",
      "memories.currentProject": "This project",
      "memories.searchPlaceholder": "Search memory text…",
      "memories.summary": "Content",
      "memories.importance": "Importance",
      "memories.eventType": "Type",
      "memories.outcome": "Outcome",
      "memories.state": "State",
      "memories.tags": "Tags",
      "memories.tagsHint": "Comma separated",
      "memories.createdAt": "Created",
      "memories.project": "Project",
      "memories.noOutcome": "Not recorded",
      "memories.edit": "Edit",
      "memories.editTitle": "Edit memory · {id}",
      "memories.forget": "Archive",
      "memories.restore": "Restore",
      "memories.forgot": "Archived; it can be restored",
      "memories.restored": "Restored",
      "memories.updated": "Memory updated",
      "memories.confirmForget": "Archive this memory? Searches stop returning it by default, and it can be restored.",
      "memories.page": "Page {page}",
      "memories.prev": "Previous",
      "memories.next": "Next",
      "memories.selectHint": "Pick an entry on the left to see its details",
      "memories.summaryRequired": "Memory content cannot be empty",
      "backup.title": "Backup and restore",
      "backup.hint": "A backup is a Markdown file you can read and edit by hand, and restore from later.",
      "backup.export": "Export Markdown backup",
      "backup.exporting": "Exporting…",
      "backup.exported": "Exported {chars} chars over {lines} lines",
      "backup.restore": "Restore from Markdown",
      "backup.restoreHint": "Choose a Markdown file exported earlier. Restoring only adds entries; it never deletes existing memories.",
      "backup.preview": "Preview restore",
      "backup.apply": "Restore now",
      "backup.cancel": "Cancel",
      "backup.dryRun": "{n} memories will be imported",
      "backup.dryRunProfile": "The user profile will be restored too",
      "backup.done": "Imported {n} memories, skipped {skipped}",
      "backup.restoredProfile": "User profile restored",
      "backup.noFile": "Choose a Markdown file first",
      "backup.readFailed": "Could not read the file: {message}",
      "errors.loadFailed": "Could not load: {message}",
      "errors.saveFailed": "Could not save: {message}",
      "errors.unknown": "Unknown error",
    }

    /**
     * Route prefix used to detect one JSON call's failure. The client bundle
     * cannot statically import the host module that owns the paths, because it
     * runs as a separate artifact; the two lists are kept in sync by hand and
     * checked by the plugin's own smoke test.
     */
    const ROUTE_STATUS = '/dsh-memory/status'
    const ROUTE_SETTINGS = '/dsh-memory/settings'
    const ROUTE_PROFILE = '/dsh-memory/profile'
    const ROUTE_DIGEST = '/dsh-memory/digest'
    const ROUTE_MEMORIES = '/dsh-memory/memories'
    const ROUTE_BACKUP = '/dsh-memory/backup'
    const ROUTE_HEALTH = '/dsh-memory/health'

    /**
     * Call one plugin route.
     * @param {string} path - route path.
     * @param {object} [body] - JSON body; omitted for a GET.
     * @returns {Promise<any>} the `result` field.
     */
    async function api(path, body) {
      const init =
        body === undefined
          ? { method: 'GET', credentials: 'same-origin', cache: 'no-store' }
          : {
              method: 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
      const response = await fetch(path, init)
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`${path} 返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!payload || payload.ok !== true) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`)
        error.code = payload?.error?.code ?? 'HTTP'
        throw error
      }
      return payload.result
    }

    /**
     * Locale subscription used by the page components.
     *
     * `ctx.locale.bind` resolves the active dictionary on every call, but React
     * only re-renders when something tells it to. The page binds one translator
     * for the whole subtree and re-renders on the locale bump, so switching
     * language updates the labels without re-registering the slot.
     */
    let translate = (key) => key
    let localeSignal = null

    /** @returns {(key: string, vars?: object) => string} the live translator. */
    function useLocale() {
      const [, bump] = useState(0)
      useEffect(() => {
        if (!localeSignal) return undefined
        return localeSignal.subscribe(() => bump((n) => n + 1))
      }, [])
      return translate
    }

    /** Small helper: formatted date from an ISO string. */
    function formatTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleString()
    }

    /** Compact relative age, for the status line. */
    function formatAge(value) {
      if (!value) return '—'
      const then = new Date(value).getTime()
      if (!Number.isFinite(then)) return String(value)
      const minutes = Math.round((Date.now() - then) / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.round(hours / 24)} 天前`
    }

    const formatLengthValue = (value) => (value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value))

    const CSS = `
.mem-root { display: flex; flex-direction: column; gap: 18px; color: var(--dsw-alias-label-primary); }
.mem-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.mem-card > header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.mem-title { font-size: 14px; font-weight: 600; margin: 0; }
.mem-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 0; line-height: 1.6; }
.mem-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mem-kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 12px; }
.mem-kv dt { color: var(--dsw-alias-label-secondary); }
.mem-kv dd { margin: 0; word-break: break-all; }
.mem-btn { font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 8px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.mem-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.mem-btn:disabled { opacity: .55; cursor: not-allowed; }
.mem-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; font-weight: 500; }
.mem-btn-danger { color: var(--dsw-alias-state-error-primary); }
.mem-chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.mem-chip-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.mem-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.mem-chip-idle { color: var(--dsw-alias-state-idle-primary); }
.mem-chip-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.mem-input, .mem-select, .mem-textarea { font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 7px 10px; box-sizing: border-box; }
.mem-input:focus, .mem-select:focus, .mem-textarea:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; border-color: var(--dsw-alias-brand-primary); }
.mem-textarea { width: 100%; min-height: 150px; resize: vertical; line-height: 1.6; font-family: inherit; }
.mem-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.mem-range { flex: 1; min-width: 180px; accent-color: var(--dsw-alias-brand-primary); }
.mem-range-wrap { flex: 1; min-width: 220px; display: flex; flex-direction: column; }
.mem-range-rail { position: relative; padding-top: 24px; display: flex; flex-direction: column; }
.mem-range-badge { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 999px; background: var(--dsw-alias-brand-primary); color: #fff; font-variant-numeric: tabular-nums; pointer-events: none; }
.mem-list { display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow: auto; }
.mem-item { text-align: left; font: inherit; font-size: 13px; padding: 9px 11px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
.mem-item:hover { border-color: var(--dsw-alias-border-l2); }
.mem-item[aria-selected='true'] { border-color: var(--dsw-alias-brand-primary); }
.mem-item-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.mem-split { display: grid; grid-template-columns: minmax(240px, 340px) 1fr; gap: 14px; align-items: start; }
@media (max-width: 900px) { .mem-split { grid-template-columns: 1fr; } }
.mem-pre { margin: 0; padding: 12px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; max-height: 480px; overflow: auto; }
.mem-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mem-note { font-size: 12px; border-radius: 8px; padding: 8px 11px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.mem-note-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.mem-note-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.mem-note-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.mem-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.42); display: flex; align-items: center; justify-content: center; z-index: 60; padding: 24px; }
.mem-modal { background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; padding: 18px 20px; width: min(880px, 100%); max-height: 86vh; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 24px 64px rgba(0,0,0,.35); }
.mem-modal > header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.mem-spacer { flex: 1; }
.mem-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.mem-pager { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
`

    /** Inline stylesheet, mounted with the page so unmounting removes it. */
    function Styles() {
      return h('style', { 'data-dsh-memory': '' }, CSS)
    }

    /** A labelled field wrapper. */
    function Field({ label, hint, children }) {
      return h('label', { className: 'mem-field' }, h('span', null, label), children, hint ? h('span', { className: 'mem-hint' }, hint) : null)
    }

    /** A status note line. */
    function Note({ kind, children }) {
      if (!children) return null
      const cls = kind ? `mem-note mem-note-${kind}` : 'mem-note'
      return h('div', { className: cls, role: kind === 'error' ? 'alert' : 'status' }, children)
    }

    /** A modal shell with a required close affordance. */
    function Modal({ title, onClose, children, footer }) {
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(
        'div',
        {
          className: 'mem-modal-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          { className: 'mem-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('header', null, h('h3', { className: 'mem-title' }, title), h('button', { className: 'mem-btn', onClick: onClose, type: 'button' }, '✕')),
          children,
          footer ? h('div', { className: 'mem-row' }, footer) : null,
        ),
      )
    }

    /** Status chips for a digest record. */
    function DigestStatus({ digest }) {
      if (!digest) return h('span', { className: 'mem-chip mem-chip-idle' }, '无')
      const map = { ok: '正常', truncated: '已截断', empty: '无内容', error: '失败' }
      const cls = digest.status === 'ok' ? 'ok' : digest.status === 'error' ? 'error' : 'warn'
      return h('span', { className: `mem-chip mem-chip-${cls}` }, map[digest.status] ?? digest.status)
    }

    /**
     * The settings page.
     *
     * Layout: connection status, then the three requested capabilities in the
     * order a user meets them — how much summary to inject, who the user is,
     * then the digest and the memories it was built from — and finally backup.
     */
    function MemoryPage() {
      const t = useLocale()
      const [status, setStatus] = useState(null)
      const [statusError, setStatusError] = useState('')
      const [loading, setLoading] = useState(true)

      // length / auto-summary
      const [presets, setPresets] = useState([100000, 300000, 500000, 800000])
      const [bounds, setBounds] = useState({ min: 1000, max: 4000000 })
      const [length, setLength] = useState(100000)
      const [customLength, setCustomLength] = useState('')
      const [mode, setMode] = useState('off')
      const [savingLength, setSavingLength] = useState(false)
      const [lengthNote, setLengthNote] = useState(null)

      // profile
      const [profile, setProfile] = useState('')
      const [profileDirty, setProfileDirty] = useState(false)
      const [profileMax, setProfileMax] = useState(100000)
      const [savingProfile, setSavingProfile] = useState(false)
      const [profileNote, setProfileNote] = useState(null)

      // digest
      const [digestState, setDigestState] = useState({ digest: null, history: [] })
      const [generating, setGenerating] = useState(false)
      const [digestNote, setDigestNote] = useState(null)
      const [showViewer, setShowViewer] = useState(false)
      const [digestScope, setDigestScope] = useState('project')

      // memories
      const [showMemories, setShowMemories] = useState(false)

      // backup
      const [exporting, setExporting] = useState(false)
      const [backupNote, setBackupNote] = useState(null)
      const [restorePreview, setRestorePreview] = useState(null)
      const [restoring, setRestoring] = useState(false)
      const [pendingRestore, setPendingRestore] = useState(null)

      const loadStatus = React.useCallback(async () => {
        setLoading(true)
        try {
          const result = await api(ROUTE_STATUS, {})
          setStatus(result)
          setStatusError('')
          const settings = result?.settings ?? {}
          if (Array.isArray(settings.presets) && settings.presets.length > 0) setPresets(settings.presets)
          if (typeof settings.min === 'number') setBounds({ min: settings.min, max: settings.max ?? 4000000 })
          if (typeof settings.length === 'number') {
            setLength(settings.length)
            setCustomLength(String(settings.length))
          }
          setMode(settings.mode ?? 'off')
          setDigestScope('project')
        } catch (error) {
          setStatusError(error.message)
        } finally {
          setLoading(false)
        }
      }, [])

      const loadDigest = React.useCallback(async (scope) => {
        try {
          const result = await api(ROUTE_DIGEST, { action: 'view', scope })
          setDigestState({ digest: result?.digest ?? null, history: result?.history ?? [] })
        } catch (error) {
          setDigestNote({ kind: 'error', text: `读取摘要失败：${error.message}` })
        }
      }, [])

      const loadProfile = React.useCallback(async () => {
        try {
          const result = await api(ROUTE_PROFILE, {})
          setProfile(result?.content ?? '')
          if (typeof result?.max_chars === 'number') setProfileMax(result.max_chars)
          setProfileDirty(false)
        } catch (error) {
          setProfileNote({ kind: 'error', text: `读取用户画像失败：${error.message}` })
        }
      }, [])

      React.useEffect(() => {
        void loadStatus()
        void loadProfile()
        void loadDigest('project')
      }, [loadStatus, loadProfile, loadDigest])

      const isPreset = presets.includes(length)

      /** Persist the length budget. */
      async function saveLength(nextLength) {
        setSavingLength(true)
        setLengthNote(null)
        try {
          const result = await api(ROUTE_SETTINGS, { length: nextLength })
          const saved = result?.settings?.settings?.length ?? nextLength
          setLength(saved)
          setLengthNote({ kind: 'ok', text: '摘要长度已保存' })
        } catch (error) {
          setLengthNote({ kind: 'error', text: `保存失败：${error.message}` })
        } finally {
          setSavingLength(false)
        }
      }

      /** Persist the automatic generation mode. */
      async function saveMode(nextMode) {
        const previous = mode
        setMode(nextMode)
        try {
          await api(ROUTE_SETTINGS, { mode: nextMode })
          setLengthNote({ kind: 'ok', text: '自动生成设置已保存' })
        } catch (error) {
          setMode(previous)
          setLengthNote({ kind: 'error', text: `保存失败：${error.message}` })
        }
      }

      /** Persist the user profile. */
      async function saveProfile() {
        setSavingProfile(true)
        setProfileNote(null)
        try {
          await api(ROUTE_PROFILE, { content: profile })
          setProfileDirty(false)
          setProfileNote({ kind: 'ok', text: '用户画像已保存' })
        } catch (error) {
          setProfileNote({ kind: 'error', text: `保存失败：${error.message}` })
        } finally {
          setSavingProfile(false)
        }
      }

      /** Generate a digest with the model. */
      async function generateDigest() {
        setGenerating(true)
        setDigestNote({ kind: 'warn', text: '正在生成记忆摘要…这一步会调用模型，可能需要几十秒。' })
        try {
          const result = await api(ROUTE_DIGEST, { action: 'generate', scope: digestScope, length })
          setDigestState({ digest: result?.digest ?? null, history: result?.history ?? [] })
          const generated = result?.generated
          if (generated?.status === 'error') {
            setDigestNote({ kind: 'error', text: `摘要生成失败：${generated.error ?? '未知错误'}` })
          } else if (generated?.status === 'empty') {
            setDigestNote({ kind: 'warn', text: '记忆库还没有内容，未生成摘要。先和助手聊几轮，或手动添加记忆。' })
          } else {
            setDigestNote({ kind: 'ok', text: '记忆摘要已更新' })
          }
        } catch (error) {
          setDigestNote({ kind: 'error', text: `摘要生成失败：${error.message}` })
        } finally {
          setGenerating(false)
        }
      }

      /** Download the Markdown backup. */
      async function exportBackup() {
        setExporting(true)
        setBackupNote(null)
        try {
          const result = await api(ROUTE_BACKUP, { all_projects: true })
          const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = result.filename
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 5000)
          setBackupNote({ kind: 'ok', text: `已导出 ${result.chars} 字，共 ${result.lines} 行。` })
        } catch (error) {
          setBackupNote({ kind: 'error', text: `导出失败：${error.message}` })
        } finally {
          setExporting(false)
        }
      }

      /** Read a chosen file and preview what restoring it would import. */
      async function chooseRestoreFile(event) {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        setBackupNote(null)
        try {
          const text = await file.text()
          setPendingRestore(text)
          const preview = await api(ROUTE_BACKUP, { action: 'restore', markdown: text, dry_run: true })
          setRestorePreview(preview)
        } catch (error) {
          setPendingRestore(null)
          setRestorePreview(null)
          setBackupNote({ kind: 'error', text: `读取失败：${error.message}` })
        }
      }

      /** Apply the pending restore. */
      async function applyRestore() {
        if (!pendingRestore) return
        setRestoring(true)
        try {
          const result = await api(ROUTE_BACKUP, {
            action: 'restore',
            markdown: pendingRestore,
            dry_run: false,
            restore_profile: true,
          })
          setBackupNote({
            kind: 'ok',
            text: `导入 ${result?.imported ?? 0} 条记忆，跳过 ${result?.skipped ?? 0} 条。${result?.profile_restored ? '用户画像已恢复。' : ''}`,
          })
          setPendingRestore(null)
          setRestorePreview(null)
          await loadStatus()
          await loadProfile()
        } catch (error) {
          setBackupNote({ kind: 'error', text: `恢复失败：${error.message}` })
        } finally {
          setRestoring(false)
        }
      }

      const settings = status?.settings ?? {}
      const latest = digestState.digest
      const tokens = latest ? Math.round((latest.actual_chars ?? 0) / 2.2) : 0

      return h(
        React.Fragment,
        null,
        h(Styles),
        h(
          'div',
          { className: 'mem-root' },

          // ── connection status ──────────────────────────────────────────
          h(
            'section',
            { className: 'mem-card' },
            h(
              'header',
              null,
              h('h3', { className: 'mem-title' }, t('nav.title')),
              h(
                'span',
                { className: status?.probe?.ok ? 'mem-chip mem-chip-ok' : 'mem-chip mem-chip-error' },
                status?.probe?.ok ? '已连接' : loading ? '检测中…' : '未连接',
              ),
            ),
            statusError
              ? h(Note, { kind: 'error' }, `记忆库不可用：${statusError}`)
              : h(
                  'dl',
                  { className: 'mem-kv' },
                  h('dt', null, '当前项目'),
                  h('dd', { className: 'mem-mono' }, status?.project_id ?? '—'),
                  h('dt', null, '记忆条目'),
                  h('dd', null, String(status?.memories ?? 0)),
                  h('dt', null, '摘要预算'),
                  h('dd', null, `${settings.length ?? 0} 字`),
                  h('dt', null, '存储位置'),
                  h('dd', { className: 'mem-mono' }, status?.home ?? '—'),
                  h('dt', null, '检索后端'),
                  h(
                    'dd',
                    null,
                    status?.probe ? `${status.probe.provider}${status.probe.degraded ? '（降级）' : ''}` : '—',
                  ),
                ),
            h(
              'div',
              { className: 'mem-row' },
              h('button', { type: 'button', className: 'mem-btn', onClick: () => void loadStatus(), disabled: loading }, '刷新'),
            ),
          ),

          // ── digest length ──────────────────────────────────────────────
          h(
            'section',
            { className: 'mem-card' },
            h('header', null, h('h3', { className: 'mem-title' }, t('length.title'))),
            h(
              'p',
              { className: 'mem-hint' },
              '注入系统提示词的记忆摘要预算上限。摘要由模型按记忆库内容生成，实际长度通常远小于预算，所以拿不准时可以选大一点。',
            ),
            h(
              'div',
              { className: 'mem-row' },
              h(
                'div',
                { className: 'mem-range-wrap' },
                (() => {
                  const sliderMax = Math.max(1, presets.length - 1)
                  const sliderValue = Math.max(
                    0,
                    presets.indexOf(isPreset ? length : presets.reduce((best, value, index) => (Math.abs(value - length) < Math.abs(presets[best] - length) ? index : best), 0)),
                  )
                  const percent = Math.min(100, Math.max(0, (sliderValue / sliderMax) * 100))
                  return h(
                    'div',
                    {
                      className: 'mem-range-rail',
                      title: `${length.toLocaleString()} 字`,
                    },
                    h(
                      'span',
                      {
                        className: 'mem-range-badge',
                        style: { left: `calc(9px + (100% - 18px) * ${percent / 100})` },
                      },
                      formatLengthValue(length),
                    ),
                    h('input', {
                      className: 'mem-range',
                      type: 'range',
                      min: 0,
                      max: sliderMax,
                      step: 1,
                      value: sliderValue,
                      onChange: (event) => {
                        const next = presets[Number(event.target.value)]
                        setLength(next)
                        setCustomLength(String(next))
                      },
                      'aria-label': '记忆摘要长度',
                    }),
                  )
                })(),
              ),
              h(
                'div',
                { className: 'mem-row', style: { gap: '6px' } },
                ...presets.map((preset) =>
                  h(
                    'button',
                    {
                      key: preset,
                      type: 'button',
                      className: preset === length ? 'mem-btn mem-btn-primary' : 'mem-btn',
                      onClick: () => {
                        setLength(preset)
                        setCustomLength(String(preset))
                        void saveLength(preset)
                      },
                      disabled: savingLength,
                    },
                    preset >= 1000 ? `${preset / 1000}k` : String(preset),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'mem-row' },
              h(Field, { label: '自定义长度（字）' },
                h('input', {
                  className: 'mem-input',
                  type: 'number',
                  min: bounds.min,
                  max: bounds.max,
                  step: 1000,
                  value: customLength,
                  onChange: (event) => setCustomLength(event.target.value),
                  style: { width: '160px' },
                }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mem-btn',
                  disabled: savingLength,
                  onClick: () => {
                    const value = Number(customLength)
                    if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
                      setLengthNote({ kind: 'error', text: `请输入 ${bounds.min} 到 ${bounds.max} 之间的数字` })
                      return
                    }
                    setLength(value)
                    void saveLength(value)
                  },
                },
                savingLength ? '保存中…' : '应用',
              ),
              h('span', { className: 'mem-spacer' }),
              h(Field, { label: '自动生成' },
                h(
                  'select',
                  {
                    className: 'mem-select',
                    value: mode,
                    onChange: (event) => void saveMode(event.target.value),
                  },
                  h('option', { value: 'off' }, '关闭'),
                  h('option', { value: 'debounced' }, '回合结束后'),
                  h('option', { value: 'idle' }, '空闲时'),
                ),
              ),
            ),
            h(Note, { kind: lengthNote?.kind }, lengthNote?.text),
          ),

          // ── user profile ───────────────────────────────────────────────
          h(
            'section',
            { className: 'mem-card' },
            h(
              'header',
              null,
              h('h3', { className: 'mem-title' }, t('profile.title')),
              settings.profile_updated_at
                ? h('span', { className: 'mem-chip' }, `更新于 ${formatAge(settings.profile_updated_at)}`)
                : null,
            ),
            h(
              'p',
              { className: 'mem-hint' },
              '写给人看的自我介绍：偏好、习惯、技术栈、沟通方式。系统提示词里会告诉模型"需要时可以查看用户画像"，生成记忆摘要时也会参考它。',
            ),
            h('textarea', {
              className: 'mem-textarea',
              value: profile,
              placeholder: '例如：\n- 中文回答，代码注释用中文\n- 主要写 TypeScript 与 Python\n- 喜欢先给结论再展开',
              maxLength: profileMax,
              onChange: (event) => {
                setProfile(event.target.value)
                setProfileDirty(true)
                setProfileNote(null)
              },
            }),
            h(
              'div',
              { className: 'mem-row' },
              h('span', { className: 'mem-hint' }, `${profile.length} / ${profileMax} 字`),
              h('span', { className: 'mem-spacer' }),
              profileDirty ? h('span', { className: 'mem-chip mem-chip-warn' }, '未保存') : null,
              h(
                'button',
                { type: 'button', className: 'mem-btn mem-btn-primary', onClick: () => void saveProfile(), disabled: savingProfile || !profileDirty },
                savingProfile ? '保存中…' : '保存用户画像',
              ),
            ),
            h(Note, { kind: profileNote?.kind }, profileNote?.text),
          ),

          // ── digest ─────────────────────────────────────────────────────
          h(
            'section',
            { className: 'mem-card' },
            h(
              'header',
              null,
              h('h3', { className: 'mem-title' }, t('digest.title')),
              h(
                'div',
                { className: 'mem-row' },
                h(
                  'select',
                  {
                    className: 'mem-select',
                    value: digestScope,
                    onChange: (event) => {
                      setDigestScope(event.target.value)
                      void loadDigest(event.target.value)
                    },
                    'aria-label': '摘要范围',
                  },
                  h('option', { value: 'project' }, '当前项目'),
                  h('option', { value: 'global' }, '全部项目'),
                ),
                h(DigestStatus, { digest: latest }),
              ),
            ),
            latest
              ? h(
                  'dl',
                  { className: 'mem-kv' },
                  h('dt', null, '生成于'),
                  h('dd', null, formatTime(latest.created_at)),
                  h('dt', null, '规模'),
                  h('dd', null, `${latest.actual_chars ?? 0} 字 · 约 ${latest.estimated_tokens ?? tokens} tokens`),
                  h('dt', null, '预算'),
                  h('dd', null, `${latest.requested_chars ?? 0} 字`),
                  h('dt', null, '来源'),
                  h('dd', null, `${latest.materials_chars ?? 0} 字材料${latest.generator ? ` · ${latest.generator}` : ''}`),
                )
              : h('p', { className: 'mem-hint' }, '还没有生成过记忆摘要。生成后，摘要会以锚点形式进入系统提示词。'),
            h(
              'div',
              { className: 'mem-row' },
              h(
                'button',
                { type: 'button', className: 'mem-btn mem-btn-primary', onClick: () => void generateDigest(), disabled: generating },
                generating ? t('digest.generating') : t('digest.generate'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mem-btn',
                  onClick: () => setShowViewer(true),
                  disabled: !latest,
                },
                t('digest.view'),
              ),
              latest?.status === 'error' ? h('span', { className: 'mem-chip mem-chip-error' }, '上次生成失败') : null,
            ),
            h(Note, { kind: digestNote?.kind }, digestNote?.text),

            // ── memories ─────────────────────────────────────────────────
            h('div', { className: 'mem-row', style: { marginTop: '4px' } },
              h('hr', { style: { flex: 1, border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1)' } }),
            ),
            h(
              'header',
              null,
              h('h3', { className: 'mem-title' }, t('memories.title')),
              h('span', { className: 'mem-hint' }, `共 ${status?.memories ?? 0} 条`),
            ),
            h('p', { className: 'mem-hint' }, '记忆库里的原始条目：可以查看、改内容与重要度、归档（软删除，可恢复）。'),
            h(
              'div',
              { className: 'mem-row' },
              h(
                'button',
                { type: 'button', className: 'mem-btn', onClick: () => setShowMemories(true) },
                t('memories.open'),
              ),
            ),
          ),

          // ── backup ─────────────────────────────────────────────────────
          h(
            'section',
            { className: 'mem-card' },
            h('header', null, h('h3', { className: 'mem-title' }, t('backup.title'))),
            h(
              'p',
              { className: 'mem-hint' },
              '备份是一个 Markdown 文件：可以直接阅读、编辑、放进自己的笔记系统，也可以用它恢复记忆库。恢复只会新增条目，不会删除现有记忆。',
            ),
            h(
              'div',
              { className: 'mem-row' },
              h(
                'button',
                { type: 'button', className: 'mem-btn', onClick: () => void exportBackup(), disabled: exporting },
                exporting ? '正在导出…' : '导出 Markdown 备份',
              ),
              h(
                'label',
                { className: 'mem-btn', style: { display: 'inline-flex', alignItems: 'center' } },
                '从 Markdown 恢复',
                h('input', {
                  type: 'file',
                  accept: '.md,.markdown,text/markdown,text/plain',
                  style: { display: 'none' },
                  onChange: (event) => void chooseRestoreFile(event),
                }),
              ),
            ),
            restorePreview
              ? h(
                  'div',
                  { className: 'mem-card', style: { background: 'var(--dsw-alias-bg-layer-2)' } },
                  h('p', { className: 'mem-hint' }, `将导入 ${restorePreview.planned ?? 0} 条记忆${restorePreview.profile ? '，并恢复用户画像' : ''}。`),
                  h(
                    'div',
                    { className: 'mem-row' },
                    h(
                      'button',
                      { type: 'button', className: 'mem-btn mem-btn-primary', onClick: () => void applyRestore(), disabled: restoring },
                      restoring ? '恢复中…' : '确认恢复',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'mem-btn',
                        onClick: () => {
                          setRestorePreview(null)
                          setPendingRestore(null)
                        },
                        disabled: restoring,
                      },
                      '取消',
                    ),
                  ),
                )
              : null,
            h(Note, { kind: backupNote?.kind }, backupNote?.text),
          ),
        ),
        showViewer && latest
          ? h(
              Modal,
              {
                title: t('digest.viewerTitle', { scope: digestScope === 'global' ? t('digest.scopeGlobal') : t('digest.scopeProject') }),
                onClose: () => setShowViewer(false),
                footer: [
                  h('span', { key: 'meta', className: 'mem-hint' }, `${formatTime(latest.created_at)} · ${latest.actual_chars ?? 0} 字`),
                  h('span', { key: 'spacer', className: 'mem-spacer' }),
                  h(
                    'button',
                    {
                      key: 'copy',
                      type: 'button',
                      className: 'mem-btn',
                      onClick: () => void navigator.clipboard?.writeText(latest.content ?? ''),
                    },
                    '复制',
                  ),
                  h('button', { key: 'close', type: 'button', className: 'mem-btn', onClick: () => setShowViewer(false) }, '关闭'),
                ],
              },
              h('pre', { className: 'mem-pre' }, latest.content || '（摘要内容为空）'),
            )
          : null,
        showMemories ? h(MemoriesModal, { onClose: () => setShowMemories(false), onChanged: () => {
          void loadStatus()
          void loadDigest(digestScope)
        } }) : null,
      )
    }

    /** The memory browser and editor. */
    function MemoriesModal({ onClose, onChanged }) {
      const t = useLocale()
      const [items, setItems] = useState([])
      const [total, setTotal] = useState(0)
      const [offset, setOffset] = useState(0)
      const [query, setQuery] = useState('')
      const [state, setState] = useState('')
      const [eventType, setEventType] = useState('')
      const [allProjects, setAllProjects] = useState(false)
      const [selected, setSelected] = useState(null)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState(null)
      const [draft, setDraft] = useState(null)
      const limit = 20

      const load = React.useCallback(async () => {
        setBusy(true)
        try {
          const result = await api(ROUTE_MEMORIES, {
            action: 'list',
            query: query || undefined,
            state: state || undefined,
            event_type: eventType || undefined,
            all_projects: allProjects,
            limit,
            offset,
          })
          setItems(result?.items ?? [])
          setTotal(result?.total ?? 0)
          setNote(null)
        } catch (error) {
          setNote({ kind: 'error', text: `读取记忆失败：${error.message}` })
        } finally {
          setBusy(false)
        }
      }, [query, state, eventType, allProjects, offset])

      React.useEffect(() => {
        void load()
      }, [load])

      /** Open one item in the editor. */
      function edit(item) {
        setSelected(item)
        setDraft({
          summary: item.summary ?? '',
          importance: Number(item.importance ?? 0.5),
          event_type: item.event_type ?? 'note',
          outcome: item.outcome ?? '',
          tags: Array.isArray(item.tags) ? item.tags.join(', ') : '',
        })
      }

      /** Save the open draft. */
      async function save() {
        if (!selected || !draft) return
        if (!draft.summary.trim()) {
          setNote({ kind: 'error', text: '记忆内容不能为空' })
          return
        }
        setBusy(true)
        try {
          const patch = {
            summary: draft.summary.trim(),
            importance: draft.importance,
            event_type: draft.event_type,
            tags: draft.tags
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean),
          }
          if (draft.outcome) patch.outcome = draft.outcome
          const result = await api(ROUTE_MEMORIES, { action: 'update', memory_id: selected.memory_id, patch })
          setNote({ kind: 'ok', text: '记忆已更新' })
          setSelected(result?.memory ?? { ...selected, ...patch })
          onChanged()
          await load()
        } catch (error) {
          setNote({ kind: 'error', text: `保存失败：${error.message}` })
        } finally {
          setBusy(false)
        }
      }

      /** Archive or restore the open item. */
      async function toggleState() {
        if (!selected) return
        const archiving = selected.state !== 'archived'
        if (archiving && !window.confirm('确定归档这条记忆吗？归档后默认检索不再返回它，但可以恢复。')) return
        setBusy(true)
        try {
          const result = await api(ROUTE_MEMORIES, {
            action: archiving ? 'forget' : 'restore',
            memory_id: selected.memory_id,
            reason: 'settings page',
          })
          setSelected(result?.memory ?? selected)
          setNote({ kind: 'ok', text: archiving ? '已归档，可随时恢复' : '已恢复' })
          onChanged()
          await load()
        } catch (error) {
          setNote({ kind: 'error', text: `操作失败：${error.message}` })
        } finally {
          setBusy(false)
        }
      }

      const page = Math.floor(offset / limit) + 1
      const pages = Math.max(1, Math.ceil(total / limit))

      return h(
        Modal,
        {
          title: t('memories.title'),
          onClose,
          footer: [
            h('span', { key: 'count', className: 'mem-hint' }, `共 ${total} 条`),
            h('span', { key: 'spacer', className: 'mem-spacer' }),
            h('div', { key: 'pager', className: 'mem-pager' },
              h('button', { type: 'button', className: 'mem-btn', disabled: busy || offset === 0, onClick: () => setOffset(Math.max(0, offset - limit)) }, '上一页'),
              h('span', null, `第 ${page} / ${pages} 页`),
              h('button', { type: 'button', className: 'mem-btn', disabled: busy || offset + limit >= total, onClick: () => setOffset(offset + limit) }, '下一页'),
            ),
            h('button', { key: 'close', type: 'button', className: 'mem-btn', onClick: onClose }, '关闭'),
          ],
        },
        h(
          'div',
          { className: 'mem-row' },
          h('input', {
            className: 'mem-input',
            type: 'search',
            placeholder: '搜索记忆内容…',
            value: query,
            onChange: (event) => {
              setQuery(event.target.value)
              setOffset(0)
            },
            style: { flex: 1, minWidth: '160px' },
          }),
          h(
            'select',
            {
              className: 'mem-select',
              value: state,
              onChange: (event) => {
                setState(event.target.value)
                setOffset(0)
              },
              'aria-label': '状态',
            },
            h('option', { value: '' }, '全部状态'),
            h('option', { value: 'active' }, '有效'),
            h('option', { value: 'archived' }, '已归档'),
          ),
          h('input', {
            className: 'mem-input',
            type: 'text',
            placeholder: '类型（如 decision）',
            value: eventType,
            onChange: (event) => {
              setEventType(event.target.value)
              setOffset(0)
            },
            style: { width: '170px' },
          }),
          h(
            'label',
            { className: 'mem-hint', style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
            h('input', {
              type: 'checkbox',
              checked: allProjects,
              onChange: (event) => {
                setAllProjects(event.target.checked)
                setOffset(0)
              },
            }),
            '全部项目',
          ),
          h('button', { type: 'button', className: 'mem-btn', onClick: () => void load(), disabled: busy }, '刷新'),
        ),
        h(Note, { kind: note?.kind }, note?.text),
        h(
          'div',
          { className: 'mem-split' },
          h(
            'div',
            { className: 'mem-list', role: 'listbox', 'aria-label': '记忆条目' },
            items.length === 0
              ? h('p', { className: 'mem-hint' }, busy ? '加载中…' : '没有符合条件的记忆')
              : items.map((item) =>
                  h(
                    'button',
                    {
                      key: item.memory_id,
                      type: 'button',
                      role: 'option',
                      'aria-selected': selected?.memory_id === item.memory_id,
                      className: 'mem-item',
                      onClick: () => edit(item),
                    },
                    h('span', null, item.summary),
                    h(
                      'span',
                      { className: 'mem-item-meta' },
                      h('span', { className: 'mem-mono' }, item.memory_id),
                      item.event_type ? h('span', null, item.event_type) : null,
                      item.state ? h('span', null, item.state === 'archived' ? '已归档' : '有效') : null,
                      h('span', null, formatAge(item.created_at)),
                    ),
                  ),
                ),
          ),
          selected && draft
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                h('div', { className: 'mem-row' },
                  h('span', { className: 'mem-mono mem-hint' }, selected.memory_id),
                  h('span', { className: 'mem-spacer' }),
                  h('span', { className: 'mem-chip' }, selected.project_id ?? '—'),
                  h('span', { className: 'mem-chip' }, formatTime(selected.created_at)),
                ),
                h('label', { className: 'mem-field' },
                  h('span', null, '内容'),
                  h('textarea', {
                    className: 'mem-textarea',
                    value: draft.summary,
                    onChange: (event) => setDraft({ ...draft, summary: event.target.value }),
                  }),
                ),
                h('div', { className: 'mem-grid2' },
                  h('label', { className: 'mem-field' },
                    h('span', null, `重要度（${draft.importance.toFixed(2)}）`),
                    h('input', {
                      type: 'range',
                      className: 'mem-range',
                      min: 0,
                      max: 1,
                      step: 0.05,
                      value: draft.importance,
                      onChange: (event) => setDraft({ ...draft, importance: Number(event.target.value) }),
                    }),
                  ),
                  h('label', { className: 'mem-field' },
                    h('span', null, '类型'),
                    h('input', {
                      className: 'mem-input',
                      type: 'text',
                      value: draft.event_type,
                      onChange: (event) => setDraft({ ...draft, event_type: event.target.value }),
                    }),
                  ),
                  h('label', { className: 'mem-field' },
                    h('span', null, '结果'),
                    h('input', {
                      className: 'mem-input',
                      type: 'text',
                      value: draft.outcome,
                      placeholder: 'success / failure / 留空',
                      onChange: (event) => setDraft({ ...draft, outcome: event.target.value }),
                    }),
                  ),
                  h('label', { className: 'mem-field' },
                    h('span', null, '标签（逗号分隔）'),
                    h('input', {
                      className: 'mem-input',
                      type: 'text',
                      value: draft.tags,
                      onChange: (event) => setDraft({ ...draft, tags: event.target.value }),
                    }),
                  ),
                ),
                h('div', { className: 'mem-row' },
                  h('button', { type: 'button', className: 'mem-btn mem-btn-primary', onClick: () => void save(), disabled: busy }, '保存'),
                  h('button', { type: 'button', className: 'mem-btn mem-btn-danger', onClick: () => void toggleState(), disabled: busy },
                    selected.state === 'archived' ? '恢复' : '归档'),
                ),
              )
            : h('p', { className: 'mem-hint' }, '从左侧选择一条记忆查看详情'),
        ),
      )
    }

    /** What the browser half exports once the factory returns. */
    const pagePlugin = {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const bound = ctx.locale.bind(NS)
        // Publish the live translator (and its change signal, when the service
        // exposes one) for the components above, which cannot receive ctx.
        translate = (key, vars) => {
          try {
            const text = bound(key, vars)
            return text === undefined || text === null || text === '' ? key : text
          } catch {
            return key
          }
        }
        // `LocaleFace.subscribe` fires on a language switch and on a late
        // dictionary registration, so the page re-renders for both.
        localeSignal = { subscribe: (fn) => ctx.locale.subscribe(fn) }
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-memory:dictionaries')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-memory',
              order: 25,
              label: () => translate('nav.title'),
            },
            MemoryPage,
          ),
        )
      },
    }
    // The loader reads the factory's return value; without this the browser
    // half registers and serves but exports nothing usable.
    Object.assign(module.exports, pagePlugin)
    return module.exports
  },
})
