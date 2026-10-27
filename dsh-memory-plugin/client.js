window.__ModuleLoader__.load({
  // Must equal the name of the package that owns `exports["./client"]`
  // (`dsh-memory-plugin/package.json`), because the client module id is
  // derived from that package. Do NOT use the `dsh-memory` bundle name or the
  // `cordis.patch.yml` row id here: the host asks the loader for
  // `dsh-memory-plugin`, and a mismatch fails with
  // "loaded without registering \"dsh-memory-plugin\"" while still serving.
  // (The `settings.section` registration further down keeps id 'dsh-memory';
  // that one is a slot key in its own right, unrelated to the module id.)
  id: 'dsh-memory-plugin',
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
      "common.unsaved": "未保存",
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
      "status.up": "已连接",
      "status.checking": "检测中…",
      "status.down": "未连接",
      "status.unavailable": "记忆库不可用：{message}",
      "status.digestBudget": "摘要预算",
      "status.backend": "检索后端",
      "status.degraded": "（降级）",
      "length.title": "记忆摘要长度",
      "length.hint": "全局摘要的生成预算：预算越大，模型写出的工作摘要越详细；预算越小，摘要越简洁。摘要不会再被截断。",
      "length.preset": "{n} 字",
      "length.custom": "自定义",
      "length.customPlaceholder": "输入 1000 到 4000000 之间的字符数",
      "length.invalid": "请输入 {min} 到 {max} 之间的数字",
      "length.current": "当前预算：{n} 字（约 {tokens} tokens）",
      "length.saved": "摘要长度已保存",
      "length.unit": "字",
      "profile.title": "用户画像",
      "profile.hint": "写给人看的自我介绍：偏好、习惯、技术栈、沟通方式。记忆摘要与助手都会参考它，系统提示词里会提示模型可以查看画像。",
      "profile.placeholder": "例如：\n- 中文回答，代码注释用中文\n- 主要写 TypeScript 与 Python\n- 喜欢先给结论再展开",
      "profile.charCount": "{n} / {max} 字",
      "profile.saved": "用户画像已保存",
      "profile.loadFailed": "读取用户画像失败：{message}",
      "profile.updatedAt": "更新于 {time}",
      "profile.save": "保存用户画像",
      "digest.title": "记忆摘要",
      "digest.generate": "记忆摘要生成",
      "digest.view": "查看记忆摘要",
      "digest.generating": "正在生成摘要…",
      "digest.generated": "摘要已更新",
      "digest.generatedAt": "生成于 {time}",
      "digest.chars": "{n} 字 · 约 {tokens} tokens",
      "digest.status": "状态",
      "digest.statusOk": "正常",
      "digest.statusTruncated": "旧版按预算截断",
      "digest.statusEmpty": "无内容",
      "digest.statusError": "生成失败",
      "digest.history": "历史摘要",
      "digest.historyEmpty": "还没有历史版本",
      "digest.delete": "删除这版摘要",
      "digest.deleted": "摘要已删除",
      "digest.noContent": "还没有记忆摘要。先点上方按钮生成一次。",
      "digest.needMaterials": "记忆库还没有内容；先和助手聊几轮，或手动添加记忆。",
      "digest.failed": "生成失败：{message}",
      "digest.viewerTitle": "全局记忆摘要",
      "digest.globalHint": "摘要覆盖所有项目，只记录已经做过的工作（不记录经验教训与偏好）；预算越大越详细，不会被截断。",
      "digest.loadFailed": "读取摘要失败：{message}",
      "digest.generatingHint": "正在生成全局记忆摘要…这一步会调用模型，可能需要几十秒。",
      "digest.generatedLabel": "生成于",
      "digest.size": "规模",
      "digest.budget": "预算",
      "digest.sourcesLabel": "来源",
      "digest.materials": "{n} 字材料",
      "digest.emptyHint": "还没有生成过记忆摘要。生成后，摘要会以锚点形式进入系统提示词。",
      "digest.lastFailed": "上次生成失败",
      "digest.statusNone": "无",
      "digest.emptyBody": "（摘要内容为空）",
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
      "memories.hint": "记忆库里的原始条目：可以查看、改内容与重要度、归档（软删除，可恢复）。列表默认显示全部项目的记忆；取消勾选「全部项目」只看当前项目。",
      "memories.unscoped": "当前没有活动会话的工作目录，无法判定“当前项目”，因此列表为空；取消勾选「全部项目」可查看全部记忆。",
      "memories.loadFailed": "读取记忆失败：{message}",
      "memories.opFailed": "操作失败：{message}",
      "memories.pageOf": "第 {page} / {pages} 页",
      "memories.typePlaceholder": "类型（如 decision）",
      "memories.emptyFiltered": "没有符合条件的记忆",
      "memories.importanceValue": "重要度（{value}）",
      "memories.outcomePlaceholder": "success / failure / 留空",
      "memories.tagsLabel": "标签（逗号分隔）",
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
      "backup.dryRun": "将导入 {n} 条记忆。",
      "backup.dryRunProfile": "同时恢复用户画像",
      "backup.done": "导入 {n} 条记忆，跳过 {skipped} 条",
      "backup.restoredProfile": "用户画像已恢复",
      "backup.noFile": "请选择一个 Markdown 文件",
      "backup.readFailed": "读取文件失败：{message}",
      "backup.exportFailed": "导出失败：{message}",
      "backup.restoreFailed": "恢复失败：{message}",
      "backup.dryRunProfileLine": "将导入 {n} 条记忆，并恢复用户画像。",
      "backup.restoring": "恢复中…",
      "errors.loadFailed": "加载失败：{message}",
      "errors.saveFailed": "保存失败：{message}",
      "errors.unknown": "未知错误",
      "errors.badResponse": "{path} 返回了非 JSON 响应（HTTP {status}）",
      "time.justNow": "刚刚",
      "time.minutesAgo": "{n} 分钟前",
      "time.hoursAgo": "{n} 小时前",
      "time.daysAgo": "{n} 天前",
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
      "common.unsaved": "Unsaved",
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
      "status.up": "Connected",
      "status.checking": "Checking…",
      "status.down": "Disconnected",
      "status.unavailable": "Memory store unavailable: {message}",
      "status.digestBudget": "Digest budget",
      "status.backend": "Retrieval backend",
      "status.degraded": "(degraded)",
      "length.title": "Digest length",
      "length.hint": "Generation budget for the global digest: a larger budget yields a more detailed work summary, a smaller one a terser summary. The output is never clipped.",
      "length.preset": "{n} chars",
      "length.custom": "Custom",
      "length.customPlaceholder": "Enter a value between 1000 and 4000000",
      "length.invalid": "Enter a number between {min} and {max}",
      "length.current": "Current budget: {n} chars (about {tokens} tokens)",
      "length.saved": "Digest length saved",
      "length.unit": "chars",
      "profile.title": "User profile",
      "profile.hint": "A short introduction for the assistant: preferences, habits, stack, communication style. Digests and the assistant both consult it, and the system prompt tells the model it can read it.",
      "profile.placeholder": "For example:\n- Answer in Chinese, comment code in Chinese\n- Mostly TypeScript and Python\n- Prefer the conclusion first, then the detail",
      "profile.charCount": "{n} / {max} chars",
      "profile.saved": "User profile saved",
      "profile.loadFailed": "Could not read the user profile: {message}",
      "profile.updatedAt": "Updated {time}",
      "profile.save": "Save profile",
      "digest.title": "Memory digest",
      "digest.generate": "Generate digest",
      "digest.view": "View digest",
      "digest.generating": "Generating the digest…",
      "digest.generated": "Digest updated",
      "digest.generatedAt": "Generated {time}",
      "digest.chars": "{n} chars · about {tokens} tokens",
      "digest.status": "Status",
      "digest.statusOk": "OK",
      "digest.statusTruncated": "Clipped by an older version",
      "digest.statusEmpty": "Empty",
      "digest.statusError": "Failed",
      "digest.history": "Earlier digests",
      "digest.historyEmpty": "No earlier versions",
      "digest.delete": "Delete this digest",
      "digest.deleted": "Digest deleted",
      "digest.noContent": "No digest yet. Use the button above to generate one.",
      "digest.needMaterials": "The memory store is still empty; chat for a few turns or add a memory first.",
      "digest.failed": "Generation failed: {message}",
      "digest.viewerTitle": "Global memory digest",
      "digest.globalHint": "The digest spans every project and records only work already done (no lessons or preferences). A larger budget means more detail; it is never clipped.",
      "digest.loadFailed": "Could not read the digest: {message}",
      "digest.generatingHint": "Generating the global digest… this calls the model and can take a few tens of seconds.",
      "digest.generatedLabel": "Generated",
      "digest.size": "Size",
      "digest.budget": "Budget",
      "digest.sourcesLabel": "Sources",
      "digest.materials": "{n} chars of material",
      "digest.emptyHint": "No digest has been generated yet. Once generated, it enters the system prompt as an anchor.",
      "digest.lastFailed": "The last generation failed",
      "digest.statusNone": "None",
      "digest.emptyBody": "(the digest is empty)",
      "memories.title": "Browse and edit memories",
      "memories.open": "Browse and edit memories",
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
      "memories.hint": "The raw entries behind the digest: inspect them, edit the text and importance, or archive them (a soft delete that can be undone). The list spans every project by default; uncheck “All projects” to narrow it to the current one.",
      "memories.unscoped": "No live session names a working directory, so “this project” cannot be decided and the list is empty; uncheck “All projects” to see every memory.",
      "memories.loadFailed": "Could not load memories: {message}",
      "memories.opFailed": "Action failed: {message}",
      "memories.pageOf": "Page {page} / {pages}",
      "memories.typePlaceholder": "Type (e.g. decision)",
      "memories.emptyFiltered": "No memories match these filters",
      "memories.importanceValue": "Importance ({value})",
      "memories.outcomePlaceholder": "success / failure / leave empty",
      "memories.tagsLabel": "Tags (comma separated)",
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
      "backup.dryRun": "{n} memories will be imported.",
      "backup.dryRunProfile": "The user profile will be restored too",
      "backup.done": "Imported {n} memories, skipped {skipped}",
      "backup.restoredProfile": "User profile restored",
      "backup.noFile": "Choose a Markdown file first",
      "backup.readFailed": "Could not read the file: {message}",
      "backup.exportFailed": "Export failed: {message}",
      "backup.restoreFailed": "Restore failed: {message}",
      "backup.dryRunProfileLine": "{n} memories will be imported, and the user profile will be restored.",
      "backup.restoring": "Restoring…",
      "errors.loadFailed": "Could not load: {message}",
      "errors.saveFailed": "Could not save: {message}",
      "errors.unknown": "Unknown error",
      "errors.badResponse": "{path} returned a non-JSON response (HTTP {status})",
      "time.justNow": "just now",
      "time.minutesAgo": "{n} min ago",
      "time.hoursAgo": "{n} h ago",
      "time.daysAgo": "{n} d ago",
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
        throw new Error(callTranslate('errors.badResponse', { path, status: response.status }))
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
    // The live translator and its change signal live in one mutable box,
    // filled in by `apply` below. Components never close over a stale
    // function: `callTranslate` reads whatever the box holds at call time.
    const localeState = {
      translate: (key) => key,
      signal: null,
    }

    /**
     * @param {string} key
     * @param {object} [vars]
     * @returns {string}
     */
    function callTranslate(key, vars) {
      return localeState.translate(key, vars)
    }

    /** @returns {(key: string, vars?: object) => string} the live translator. */
    function useLocale() {
      const [, bump] = useState(0)
      useEffect(() => {
        const { signal } = localeState
        if (!signal) return undefined
        return signal.subscribe(() => bump((n) => n + 1))
      }, [])
      return callTranslate
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
      if (minutes < 1) return callTranslate('time.justNow')
      if (minutes < 60) return callTranslate('time.minutesAgo', { n: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return callTranslate('time.hoursAgo', { n: hours })
      return callTranslate('time.daysAgo', { n: Math.round(hours / 24) })
    }

    // Bare digits: seven labels share one rail, and a thousands separator would
    // make each one wide enough to crowd its neighbours.
    const formatLengthValue = (value) => String(value)

    /**
     * Where a preset sits on the rail, as a percentage of the track.
     *
     * The rail is linear in the *value*, not in the preset's index: 300 and 500
     * are close together and 2000 and 3000 are far apart, which is what makes
     * the ticks read as a scale instead of as decorations. Clamped, so a stored
     * budget outside the rail's ends cannot push the bubble off the card.
     * @param {number} value - a budget.
     * @param {number} min - the rail's low end.
     * @param {number} max - the rail's high end.
     * @returns {number} 0–100.
     */
    function railPercent(value, min, max) {
      if (!(max > min)) return 0
      const percent = ((value - min) / (max - min)) * 100
      return Math.min(100, Math.max(0, percent))
    }

    /**
     * The preset a value lands on, or the value itself.
     *
     * The rail is continuous, so any budget is reachable; but a preset is a
     * round number a user aims for, and a native range input cannot stop there
     * by itself. Within the snap window the preset wins, outside it the exact
     * value does — that is what "slides onto the ticks, and anywhere else" means.
     * @param {number} value - raw budget from the input.
     * @param {number[]} presets - the tick values.
     * @param {number} min - the rail's low end.
     * @param {number} max - the rail's high end.
     * @param {number} [tolerance] - window as a percentage of the track.
     * @returns {{value: number, snapped: boolean}} the value to keep.
     */
    function snapToPreset(value, presets, min, max, tolerance = 2) {
      let best = value
      let bestDistance = Number.POSITIVE_INFINITY
      for (const preset of presets) {
        const distance = Math.abs(railPercent(preset, min, max) - railPercent(value, min, max))
        if (distance < bestDistance) {
          bestDistance = distance
          best = preset
        }
      }
      return bestDistance <= tolerance ? { value: best, snapped: true } : { value, snapped: false }
    }

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
/* ── digest-length rail ────────────────────────────────────────────────
   A continuous rail with a tick per preset value, laid out by VALUE rather than
   by index: 300 and 500 are close, 2000 and 3000 are not, and the ticks have to
   show that. Three stacked lanes share one vertical anchor:
     bubble   the value the thumb currently stands on (the one in the picture)
     groove   the rail itself, with one tick per preset drawn under it
     labels   one label per preset, each centred on its own tick
   --rail-y is the distance from the rail box's top to the groove's centre;
   --thumb/2 is the inset the native thumb adds at each end, so the painted
   ticks, the fill, the bubble and the thumb all read from one coordinate. */
.mem-rail-wrap { flex: 1; min-width: 260px; display: flex; flex-direction: row; align-items: center; }
.mem-rail { --thumb: 16px; --rail-y: 48px; --ticks: 10px; --labels: 18px; --edge: calc(var(--thumb) / 2); position: relative; flex: 1 1 auto; min-width: 0; height: calc(var(--rail-y) + var(--ticks) + var(--labels)); padding-inline: var(--edge); }
/* The track is the whole rail width; --pos (set inline per part) is how far
   along it that part stands, in % of the track. */
.mem-rail-groove { position: absolute; top: calc(var(--rail-y) - 2px); left: var(--edge); right: var(--edge); height: 4px; border-radius: 999px; background: var(--dsw-alias-border-l1); }
.mem-rail-fill { position: absolute; top: 0; bottom: 0; left: 0; width: var(--pos, 0%); border-radius: 999px; background: var(--dsw-alias-brand-primary); }
.mem-rail-ticks { position: absolute; top: calc(var(--rail-y) + 2px); left: var(--edge); right: var(--edge); height: var(--ticks); pointer-events: none; }
/* One tick per preset, a hairline hanging below the groove so the groove and
   the thumb still read as the rail while the ticks stay visible. */
.mem-rail-tick { position: absolute; top: 0; left: var(--pos, 0%); width: 1px; height: 8px; margin-left: -.5px; background: var(--dsw-alias-border-l2); }
.mem-rail-tick[data-reached='true'] { background: var(--dsw-alias-brand-primary); }
.mem-rail-labels { position: absolute; top: calc(var(--rail-y) + var(--ticks) + 4px); left: var(--edge); right: var(--edge); height: var(--labels); }
/* A label is centred on its own value instead of filling a slot: the values are
   unevenly spaced, and only its centre has to line up with its tick. */
.mem-rail-label { position: absolute; left: var(--pos, 0%); transform: translateX(-50%); white-space: nowrap; font-size: 11px; line-height: 13px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.mem-rail-label[data-current='true'] { color: var(--dsw-alias-brand-primary); font-weight: 600; }
/* Value bubble above the thumb, pointing down at it with a rotated square. */
.mem-rail-bubble { position: absolute; left: var(--pos, 0%); top: 0; transform: translateX(-50%); padding: 3px 8px; border-radius: 6px; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-1); font-size: 12px; font-weight: 600; line-height: 18px; white-space: nowrap; font-variant-numeric: tabular-nums; pointer-events: none; }
.mem-rail-bubble::after { content: ''; position: absolute; left: 50%; bottom: -4px; width: 8px; height: 8px; margin-left: -4px; transform: rotate(45deg); border-radius: 1px; background: inherit; }
/* The native input sits exactly on the groove, so its thumb lands on it: the
   full-thumb inset of its own track cancels the rail's padding of the same
   size, which gives the input and the painted groove identical geometry. */
.mem-rail input { position: absolute; top: calc(var(--rail-y) - 12px); left: 0; z-index: 1; box-sizing: border-box; width: 100%; height: 24px; margin: 0; padding: 0; background: transparent; -webkit-appearance: none; appearance: none; cursor: pointer; }
.mem-rail input:focus-visible { outline: none; }
.mem-rail input::-webkit-slider-runnable-track { height: 4px; border-radius: 999px; background: transparent; }
.mem-rail input::-moz-range-track { height: 4px; border-radius: 999px; background: transparent; }
/* The thumb: a solid dot on the groove line, with a halo so it reads as
   grabbable. The halo is the brand colour thinned out via color-mix, so it
   follows the theme; the plain rgba line above it is the fallback for a
   renderer without color-mix. */
.mem-rail input::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; box-sizing: border-box; width: var(--thumb); height: var(--thumb); border-radius: 50%; border: 2px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 4px rgba(37, 99, 235, .18); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.mem-rail input::-moz-range-thumb { box-sizing: border-box; width: var(--thumb); height: var(--thumb); border-radius: 50%; border: 2px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 4px rgba(37, 99, 235, .18); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.mem-rail input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 5px rgba(37, 99, 235, .3); box-shadow: 0 0 0 5px color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }
.mem-rail input:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 5px rgba(37, 99, 235, .3); box-shadow: 0 0 0 5px color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent); }
/* The unit sits beside the rail on the groove's line: same centre as the
   thumb, so it reads as the rail's unit rather than as a stray word. */
.mem-rail-unit { flex: 0 0 auto; align-self: flex-start; margin-top: calc(var(--rail-y, 48px) - 8px); padding-left: 8px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
/* The current budget, stated in words beside the rail (the bubble only shows
   the number and the hint only explains what the number means). */
.mem-length-current { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mem-list { display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow: auto; }
/* One row, always one line high: a row of different heights made the list
   impossible to scan, so the text is clipped with an ellipsis and the meta is
   one short phrase pinned to the right. The full text is the row's tooltip. */
.mem-item { flex: 0 0 auto; min-width: 0; display: flex; align-items: center; gap: 10px; text-align: left; font: inherit; font-size: 13px; line-height: 18px; height: 38px; padding: 0 11px; box-sizing: border-box; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: inherit; cursor: pointer; }
.mem-item:hover { border-color: var(--dsw-alias-border-l2); }
.mem-item[aria-selected='true'] { border-color: var(--dsw-alias-brand-primary); }
.mem-item-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mem-item-meta { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
/* Inside a row the chip has to fit a single 18px line, so it gives up the
   999px pill radius and its vertical padding for a compact tag. */
.mem-item .mem-chip { padding: 0 6px; border-radius: 4px; font-size: 11px; line-height: 16px; }
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
      const t = useLocale()
      if (!digest) return h('span', { className: 'mem-chip mem-chip-idle' }, t('digest.statusNone'))
      const map = {
        ok: t('digest.statusOk'),
        truncated: t('digest.statusTruncated'),
        empty: t('digest.statusEmpty'),
        error: t('digest.statusError'),
      }
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
      const [presets, setPresets] = useState([300, 500, 800, 1000, 1500, 2000, 3000])
      const [bounds, setBounds] = useState({ min: 300, max: 3000 })
      const [length, setLength] = useState(1000)
      const [savingLength, setSavingLength] = useState(false)
      const [lengthNote, setLengthNote] = useState(null)
      // Last value the server confirmed. The slider only updates `length`, so
      // a drag never writes; the debounced effect below commits on settle.
      const [savedLength, setSavedLength] = useState(1000)

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
          // `/status` returns the settings payload flattened: `length` sits directly
          // beside `presets`. (`/settings` nests it under `settings.settings`.)
          const settings = result?.settings ?? {}
          if (Array.isArray(settings.presets) && settings.presets.length > 0) setPresets(settings.presets)
          if (typeof settings.min === 'number') setBounds({ min: settings.min, max: settings.max ?? 3000 })
          if (typeof settings.length === 'number') {
            setLength(settings.length)
            setSavedLength(settings.length)
          }
        } catch (error) {
          setStatusError(error.message)
        } finally {
          setLoading(false)
        }
      }, [])

      const loadDigest = React.useCallback(async () => {
        try {
          const result = await api(ROUTE_DIGEST, { action: 'view' })
          setDigestState({ digest: result?.digest ?? null, history: result?.history ?? [] })
        } catch (error) {
          setDigestNote({ kind: 'error', text: t('digest.loadFailed', { message: error.message }) })
        }
      }, [])

      const loadProfile = React.useCallback(async () => {
        try {
          const result = await api(ROUTE_PROFILE, {})
          setProfile(result?.content ?? '')
          if (typeof result?.max_chars === 'number') setProfileMax(result.max_chars)
          setProfileDirty(false)
        } catch (error) {
          setProfileNote({ kind: 'error', text: t('profile.loadFailed', { message: error.message }) })
        }
      }, [])

      React.useEffect(() => {
        void loadStatus()
        void loadProfile()
        void loadDigest()
      }, [loadStatus, loadProfile, loadDigest])

      // Debounced commit: once the slider settles on a new preset for a beat,
      // write it. A range input fires `onChange` on every step, so writing
      // directly there would send one request per tick.
      //
      // Refs hold the newest values so the timer and the unmount flush never
      // read a stale closure, and neither effect depends on `savedLength`
      // (a landed save must not re-arm the timer).
      const savedLengthRef = React.useRef(savedLength)
      savedLengthRef.current = savedLength
      const lengthRef = React.useRef(length)
      lengthRef.current = length

      React.useEffect(() => {
        if (typeof length !== 'number' || length === savedLengthRef.current) return undefined
        const timer = setTimeout(() => {
          // Re-check: a save may have landed while the timer was pending.
          if (lengthRef.current !== savedLengthRef.current) void saveLength(lengthRef.current)
        }, 400)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [length])

      // Flush a pending change if the page unmounts before the timer fires.
      // The component is going away, so this deliberately skips React state:
      // calling setState on an unmounted tree is a no-op warning, and there is
      // no UI left to update. A keepalive POST survives the navigation.
      React.useEffect(() => {
        return () => {
          const pending = lengthRef.current
          if (pending === savedLengthRef.current) return
          try {
            void fetch(ROUTE_SETTINGS, {
              method: 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
              keepalive: true,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ length: pending }),
            })
          } catch {
            // Best effort: the next load reconciles from the server.
          }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      /** Persist the length budget. */
      async function saveLength(nextLength) {
        setSavingLength(true)
        setLengthNote(null)
        try {
          const result = await api(ROUTE_SETTINGS, { length: nextLength })
          // Trust the server's echo, falling back to what we sent.
          const saved = result?.settings?.settings?.length ?? nextLength
          setSavedLength(saved)
          // Only reconcile the slider if the user has not moved it since this
          // request went out; otherwise the echo would yank the thumb back
          // mid-drag.
          setLength((current) => (current === nextLength ? saved : current))
          setLengthNote({ kind: 'ok', text: t('length.saved') })
        } catch (error) {
          // Keep the slider where the user put it; the note explains why the
          // value will not survive a reload.
          setLengthNote({ kind: 'error', text: t('errors.saveFailed', { message: error.message }) })
        } finally {
          setSavingLength(false)
        }
      }

      /** Persist the user profile. */
      async function saveProfile() {
        setSavingProfile(true)
        setProfileNote(null)
        try {
          await api(ROUTE_PROFILE, { content: profile })
          setProfileDirty(false)
          setProfileNote({ kind: 'ok', text: t('profile.saved') })
        } catch (error) {
          setProfileNote({ kind: 'error', text: t('errors.saveFailed', { message: error.message }) })
        } finally {
          setSavingProfile(false)
        }
      }

      /** Generate a digest with the model. */
      async function generateDigest() {
        setGenerating(true)
        setDigestNote({ kind: 'warn', text: t('digest.generatingHint') })
        try {
          const result = await api(ROUTE_DIGEST, { action: 'generate', length })
          setDigestState({ digest: result?.digest ?? null, history: result?.history ?? [] })
          const generated = result?.generated
          if (generated?.status === 'error') {
            setDigestNote({
              kind: 'error',
              text: t('digest.failed', { message: generated.error ?? t('errors.unknown') }),
            })
          } else if (generated?.status === 'empty') {
            setDigestNote({ kind: 'warn', text: t('digest.needMaterials') })
          } else {
            setDigestNote({ kind: 'ok', text: t('digest.generated') })
          }
        } catch (error) {
          setDigestNote({ kind: 'error', text: t('digest.failed', { message: error.message }) })
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
          setBackupNote({
            kind: 'ok',
            text: t('backup.exported', { chars: result.chars, lines: result.lines }),
          })
        } catch (error) {
          setBackupNote({ kind: 'error', text: t('backup.exportFailed', { message: error.message }) })
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
          setBackupNote({ kind: 'error', text: t('backup.readFailed', { message: error.message }) })
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
            text: t(result?.profile_restored ? 'backup.dryRunProfileLine' : 'backup.done', {
              n: result?.imported ?? 0,
              skipped: result?.skipped ?? 0,
            }),
          })
          setPendingRestore(null)
          setRestorePreview(null)
          await loadStatus()
          await loadProfile()
        } catch (error) {
          setBackupNote({ kind: 'error', text: t('backup.restoreFailed', { message: error.message }) })
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
                status?.probe?.ok
                  ? t('status.up')
                  : loading
                    ? t('status.checking')
                    : t('status.down'),
              ),
            ),
            statusError
              ? h(Note, { kind: 'error' }, t('status.unavailable', { message: statusError }))
              : h(
                  'dl',
                  { className: 'mem-kv' },
                  h('dt', null, t('status.project')),
                  h('dd', { className: 'mem-mono' }, status?.project_id ?? '—'),
                  h('dt', null, t('status.memories')),
                  h('dd', null, String(status?.memories ?? 0)),
                  h('dt', null, t('status.digestBudget')),
                  h('dd', null, t('length.preset', { n: settings.length ?? 0 })),
                  h('dt', null, t('status.home')),
                  h('dd', { className: 'mem-mono' }, status?.home ?? '—'),
                  h('dt', null, t('status.backend')),
                  h(
                    'dd',
                    null,
                    status?.probe
                      ? `${status.probe.provider}${status.probe.degraded ? ` ${t('status.degraded')}` : ''}`
                      : '—',
                  ),
                ),
            h(
              'div',
              { className: 'mem-row' },
              h('button', { type: 'button', className: 'mem-btn', onClick: () => void loadStatus(), disabled: loading }, t('common.refresh')),
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
              t('length.hint'),
            ),
            h(
              'div',
              { className: 'mem-row' },
              h(
                'div',
                { className: 'mem-rail-wrap' },
                (() => {
                  // The rail is continuous over [min, max]; the presets are only
                  // ticks on it. `rangeStep` is the browser's own step (1 char),
                  // `keyStep` what an arrow key moves by — a one-char arrow key
                  // would take 2700 presses to cross the rail.
                  const { min, max } = bounds
                  const rangeStep = 1
                  const keyStep = Math.max(1, Math.round((max - min) / 100))
                  const at = (value) => `${railPercent(value, min, max)}%`
                  const pins = presets.map((preset) => ({ preset, pos: at(preset) }))
                  return h(
                    'div',
                    { className: 'mem-rail', 'data-preset-count': presets.length },
                    // The bubble is the value under the thumb — the one thing
                    // the picture's rail makes visible that a bare track does not.
                    h('span', {
                      key: 'bubble',
                      className: 'mem-rail-bubble',
                      style: { '--pos': at(length) },
                      'aria-hidden': 'true',
                    }, formatLengthValue(length)),
                    // The painted track: a groove plus the part already travelled.
                    h(
                      'span',
                      { key: 'groove', className: 'mem-rail-groove', 'aria-hidden': 'true' },
                      h('span', { className: 'mem-rail-fill', style: { '--pos': at(length) } }),
                    ),
                    // One tick per preset, each at its VALUE's position: the gap
                    // between 2000 and 3000 is visibly wider than 300 → 500.
                    h(
                      'span',
                      { key: 'ticks', className: 'mem-rail-ticks', 'aria-hidden': 'true' },
                      ...pins.map(({ preset, pos }) =>
                        h('i', {
                          key: preset,
                          className: 'mem-rail-tick',
                          'data-reached': String(length >= preset),
                          style: { '--pos': pos },
                        }),
                      ),
                    ),
                    h('input', {
                      key: 'input',
                      type: 'range',
                      min,
                      max,
                      step: rangeStep,
                      value: length,
                      onChange: (event) => {
                        // Snap only near a tick; everywhere else the exact value
                        // the user dragged to is kept.
                        const raw = Number(event.target.value)
                        setLength(snapToPreset(raw, presets, min, max).value)
                      },
                      onKeyDown: (event) => {
                        const keys = {
                          ArrowUp: keyStep,
                          ArrowRight: keyStep,
                          ArrowDown: -keyStep,
                          ArrowLeft: -keyStep,
                          PageUp: keyStep * 5,
                          PageDown: -keyStep * 5,
                        }
                        const delta = keys[event.key]
                        if (delta === undefined) return
                        // Let the browser compute the step from the raw event so
                        // focus, IME and repeat behaviour stay native.
                        const base = Number(event.currentTarget.value)
                        event.preventDefault()
                        const next = Math.min(max, Math.max(min, base + delta))
                        setLength(snapToPreset(next, presets, min, max).value)
                      },
                      title: t('length.preset', { n: length.toLocaleString() }),
                      'aria-label': t('length.title'),
                      'aria-valuetext': t('length.preset', { n: length.toLocaleString() }),
                    }),
                    // Labels share one row; each is centred on its own tick.
                    h(
                      'div',
                      { key: 'labels', className: 'mem-rail-labels', 'aria-hidden': 'true' },
                      ...pins.map(({ preset, pos }) =>
                        h('span', {
                          key: preset,
                          className: 'mem-rail-label',
                          'data-current': String(preset === length),
                          style: { '--pos': pos },
                        }, formatLengthValue(preset)),
                      ),
                    ),
                  )
                })(),
                // The unit is rendered once, beside the rail, instead of on
                // every tick label.
                h('span', { className: 'mem-rail-unit' }, t('length.unit')),
              ),
            ),
            // The bubble carries the number only; this line says what it means.
            h('span', { className: 'mem-length-current' }, t('length.current', {
              n: length.toLocaleString(),
              tokens: Math.round(length / 2.2).toLocaleString(),
            })),
            h(
              Note,
              { kind: savingLength ? 'warn' : lengthNote?.kind },
              savingLength ? t('common.saving') : lengthNote?.text,
            ),
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
                ? h('span', { className: 'mem-chip' }, t('profile.updatedAt', { time: formatAge(settings.profile_updated_at) }))
                : null,
            ),
            h(
              'p',
              { className: 'mem-hint' },
              t('profile.hint'),
            ),
            h('textarea', {
              className: 'mem-textarea',
              value: profile,
              placeholder: t('profile.placeholder'),
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
              h('span', { className: 'mem-hint' }, t('profile.charCount', { n: profile.length, max: profileMax })),
              h('span', { className: 'mem-spacer' }),
              profileDirty ? h('span', { className: 'mem-chip mem-chip-warn' }, t('common.unsaved')) : null,
              h(
                'button',
                { type: 'button', className: 'mem-btn mem-btn-primary', onClick: () => void saveProfile(), disabled: savingProfile || !profileDirty },
                savingProfile ? t('common.saving') : t('profile.save'),
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
              h(DigestStatus, { digest: latest }),
            ),
            h('p', { className: 'mem-hint' }, t('digest.globalHint')),
            latest
              ? h(
                  'dl',
                  { className: 'mem-kv' },
                  h('dt', null, t('digest.generatedLabel')),
                  h('dd', null, formatTime(latest.created_at)),
                  h('dt', null, t('digest.size')),
                  h('dd', null, t('digest.chars', {
                    n: latest.actual_chars ?? 0,
                    tokens: latest.estimated_tokens ?? tokens,
                  })),
                  h('dt', null, t('digest.budget')),
                  h('dd', null, t('length.preset', { n: latest.requested_chars ?? 0 })),
                  h('dt', null, t('digest.sourcesLabel')),
                  h('dd', null, `${t('digest.materials', { n: latest.materials_chars ?? 0 })}${latest.generator ? ` · ${latest.generator}` : ''}`),
                )
              : h('p', { className: 'mem-hint' }, t('digest.emptyHint')),
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
              latest?.status === 'error' ? h('span', { className: 'mem-chip mem-chip-error' }, t('digest.lastFailed')) : null,
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
              h('span', { className: 'mem-hint' }, t('memories.count', { total: status?.memories ?? 0 })),
            ),
            h('p', { className: 'mem-hint' }, t('memories.hint')),
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
              t('backup.hint'),
            ),
            h(
              'div',
              { className: 'mem-row' },
              h(
                'button',
                { type: 'button', className: 'mem-btn', onClick: () => void exportBackup(), disabled: exporting },
                exporting ? t('backup.exporting') : t('backup.export'),
              ),
              h(
                'label',
                { className: 'mem-btn', style: { display: 'inline-flex', alignItems: 'center' } },
                t('backup.restore'),
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
                  h('p', {
                    className: 'mem-hint',
                  }, t(restorePreview.profile ? 'backup.dryRunProfileLine' : 'backup.dryRun', {
                    n: restorePreview.planned ?? 0,
                  })),
                  h(
                    'div',
                    { className: 'mem-row' },
                    h(
                      'button',
                      { type: 'button', className: 'mem-btn mem-btn-primary', onClick: () => void applyRestore(), disabled: restoring },
                      restoring ? t('backup.restoring') : t('backup.apply'),
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
                      t('backup.cancel'),
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
                title: t('digest.viewerTitle'),
                onClose: () => setShowViewer(false),
                footer: [
                  h('span', { key: 'meta', className: 'mem-hint' }, `${formatTime(latest.created_at)} · ${t('length.preset', { n: latest.actual_chars ?? 0 })}`),
                  h('span', { key: 'spacer', className: 'mem-spacer' }),
                  h(
                    'button',
                    {
                      key: 'copy',
                      type: 'button',
                      className: 'mem-btn',
                      onClick: () => void navigator.clipboard?.writeText(latest.content ?? ''),
                    },
                    t('common.copy'),
                  ),
                  h('button', { key: 'close', type: 'button', className: 'mem-btn', onClick: () => setShowViewer(false) }, t('common.close')),
                ],
              },
              h('pre', { className: 'mem-pre' }, latest.content || t('digest.emptyBody')),
            )
          : null,
        showMemories ? h(MemoriesModal, { onClose: () => setShowMemories(false), onChanged: () => {
          void loadStatus()
          void loadDigest()
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
      // Default on: this list is the memory store, and scoping it to whatever
      // project the host resolved made a fresh project's two entries look like
      // they had replaced five from another project. Narrowing is one click.
      const [allProjects, setAllProjects] = useState(true)
      /** Project the listing is narrowed to, or null when it spans the store. */
      const [scope, setScope] = useState(null)
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
          setScope(result?.scoped_to_project ? (result?.project_id ?? null) : null)
          // Asked to narrow to a project the host could not resolve: the bridge answers
          // for the literal project `unknown`, so say why the count is empty
          // instead of letting it read as "my memories are gone".
          setNote(
            !allProjects && result && result.scoped_to_project === false
              ? { kind: 'info', text: t('memories.unscoped') }
              : null,
          )
        } catch (error) {
          setNote({ kind: 'error', text: t('memories.loadFailed', { message: error.message }) })
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
          setNote({ kind: 'error', text: t('memories.summaryRequired') })
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
          setNote({ kind: 'ok', text: t('memories.updated') })
          setSelected(result?.memory ?? { ...selected, ...patch })
          onChanged()
          await load()
        } catch (error) {
          setNote({ kind: 'error', text: t('errors.saveFailed', { message: error.message }) })
        } finally {
          setBusy(false)
        }
      }

      /** Archive or restore the open item. */
      async function toggleState() {
        if (!selected) return
        const archiving = selected.state !== 'archived'
        if (archiving && !window.confirm(t('memories.confirmForget'))) return
        setBusy(true)
        try {
          const result = await api(ROUTE_MEMORIES, {
            action: archiving ? 'forget' : 'restore',
            memory_id: selected.memory_id,
            reason: 'settings page',
          })
          setSelected(result?.memory ?? selected)
          setNote({ kind: 'ok', text: t(archiving ? 'memories.forgot' : 'memories.restored') })
          onChanged()
          await load()
        } catch (error) {
          setNote({ kind: 'error', text: t('memories.opFailed', { message: error.message }) })
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
            h('span', { key: 'count', className: 'mem-hint' },
              t('memories.count', { total }),
              scope ? ` · ${scope}` : '',
            ),
            h('span', { key: 'spacer', className: 'mem-spacer' }),
            h('div', { key: 'pager', className: 'mem-pager' },
              h('button', { type: 'button', className: 'mem-btn', disabled: busy || offset === 0, onClick: () => setOffset(Math.max(0, offset - limit)) }, t('memories.prev')),
              h('span', null, t('memories.pageOf', { page, pages })),
              h('button', { type: 'button', className: 'mem-btn', disabled: busy || offset + limit >= total, onClick: () => setOffset(offset + limit) }, t('memories.next')),
            ),
            h('button', { key: 'close', type: 'button', className: 'mem-btn', onClick: onClose }, t('common.close')),
          ],
        },
        h(
          'div',
          { className: 'mem-row' },
          h('input', {
            className: 'mem-input',
            type: 'search',
            placeholder: t('memories.searchPlaceholder'),
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
              'aria-label': t('memories.filterState'),
            },
            h('option', { value: '' }, t('memories.allStates')),
            h('option', { value: 'active' }, t('memories.active')),
            h('option', { value: 'archived' }, t('memories.archived')),
          ),
          h('input', {
            className: 'mem-input',
            type: 'text',
            placeholder: t('memories.typePlaceholder'),
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
            t('memories.allProjects'),
          ),
          h('button', { type: 'button', className: 'mem-btn', onClick: () => void load(), disabled: busy }, t('common.refresh')),
        ),
        h(Note, { kind: note?.kind }, note?.text),
        h(
          'div',
          { className: 'mem-split' },
          h(
            'div',
            { className: 'mem-list', role: 'listbox', 'aria-label': t('status.memories') },
            items.length === 0
              ? h('p', { className: 'mem-hint' }, busy ? t('common.loading') : t('memories.emptyFiltered'))
              : items.map((item) =>
                  h(
                    'button',
                    {
                      key: item.memory_id,
                      type: 'button',
                      role: 'option',
                      'aria-selected': selected?.memory_id === item.memory_id,
                      className: 'mem-item',
                      // The whole text stays reachable: the row is clipped to
                      // one line, so the tooltip is where the full entry lives.
                      title: item.summary,
                      onClick: () => edit(item),
                    },
                    // One line per entry: the text is abridged and the meta is
                    // one short phrase, so every row is the same height and the
                    // list can be scanned instead of read.
                    h('span', { className: 'mem-item-text' }, item.summary),
                    h(
                      'span',
                      { className: 'mem-item-meta' },
                      h('span', null, formatAge(item.created_at)),
                      item.state === 'archived'
                        ? h('span', { className: 'mem-chip mem-chip-idle' }, t('memories.archived'))
                        : null,
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
                  // The list rows show one line only, so the details the rows
                  // no longer print (project, type, creation time) live here.
                  h('span', { className: 'mem-chip' }, selected.project_id ?? '—'),
                  selected.event_type ? h('span', { className: 'mem-chip' }, selected.event_type) : null,
                  h('span', { className: 'mem-chip' }, formatTime(selected.created_at)),
                ),
                h('label', { className: 'mem-field' },
                  h('span', null, t('memories.summary')),
                  h('textarea', {
                    className: 'mem-textarea',
                    value: draft.summary,
                    onChange: (event) => setDraft({ ...draft, summary: event.target.value }),
                  }),
                ),
                h('div', { className: 'mem-grid2' },
                  h('label', { className: 'mem-field' },
                    h('span', null, t('memories.importanceValue', { value: draft.importance.toFixed(2) })),
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
                    h('span', null, t('memories.eventType')),
                    h('input', {
                      className: 'mem-input',
                      type: 'text',
                      value: draft.event_type,
                      onChange: (event) => setDraft({ ...draft, event_type: event.target.value }),
                    }),
                  ),
                  h('label', { className: 'mem-field' },
                    h('span', null, t('memories.outcome')),
                    h('input', {
                      className: 'mem-input',
                      type: 'text',
                      value: draft.outcome,
                      placeholder: t('memories.outcomePlaceholder'),
                      onChange: (event) => setDraft({ ...draft, outcome: event.target.value }),
                    }),
                  ),
                  h('label', { className: 'mem-field' },
                    h('span', null, t('memories.tagsLabel')),
                    h('input', {
                      className: 'mem-input',
                      type: 'text',
                      value: draft.tags,
                      onChange: (event) => setDraft({ ...draft, tags: event.target.value }),
                    }),
                  ),
                ),
                h('div', { className: 'mem-row' },
                  h('button', { type: 'button', className: 'mem-btn mem-btn-primary', onClick: () => void save(), disabled: busy }, t('common.save')),
                  h('button', { type: 'button', className: 'mem-btn mem-btn-danger', onClick: () => void toggleState(), disabled: busy },
                    t(selected.state === 'archived' ? 'memories.restore' : 'memories.forget')),
                ),
              )
            : h('p', { className: 'mem-hint' }, t('memories.selectHint')),
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
        localeState.translate = (key, vars) => {
          try {
            const text = bound(key, vars)
            return text === undefined || text === null || text === '' ? key : text
          } catch {
            return key
          }
        }
        // `LocaleFace.subscribe` fires on a language switch and on a late
        // dictionary registration, so the page re-renders for both.
        localeState.signal = { subscribe: (fn) => ctx.locale.subscribe(fn) }
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-memory:dictionaries')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-memory',
              order: 25,
              label: () => callTranslate('nav.title'),
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
