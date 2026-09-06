/** Collapse newlines/control chars + trim (single-line safety for list bodies). */
function oneLine(s) {
    return String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/** Escape every Markdown structure character so content cannot forge structure.
 *  Mirrors format.ts's intent but for a one-line list body (no <br> needed).
 *  `-` is escaped too: a body that starts a line with `- ` (only reachable if a
 *  caller ever stops collapsing newlines) would otherwise forge a nested list. */
export function mdSafe(text) {
    return oneLine(text)
        .replace(/[\\`*_[\]<>#|-]/g, (ch) => `\\${ch}`);
}
/** Render one semantic memory as a Markdown list item (used by every state block). */
function entryItem(e) {
    const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');
    return [
        `- **${mdSafe(e.topic)}**`,
        `  - 内容：${mdSafe(e.content)}`,
        `  - 元数据：\`${e.id}\` ｜ layer=${e.layer} ｜ kind=${e.kind} ｜ tier=${e.tier} ｜ 重要度=${e.importance} ｜ 认知=${e.epistemic}`,
        `  - 时间：创建 ${when(e.created)} ｜ 更新 ${when(e.updated)} ｜ 最近访问 ${when(e.last_accessed)} ｜ 召回(w${e.window_freq})`,
    ].join('\n');
}
/** Group memories by layer → kind → importance desc. */
function groupByLayerKind(entries) {
    const layers = ['user', 'memory'];
    const layerLabel = { user: '用户记忆（layer=user，永生）', memory: '一般记忆（layer=memory）' };
    const kinds = ['preference', 'env', 'lesson', 'decision', 'general'];
    const blocks = [];
    for (const layer of layers) {
        const layerRows = entries.filter((e) => e.layer === layer);
        if (layerRows.length === 0)
            continue;
        blocks.push(`### ${layerLabel[layer]}`);
        for (const kind of kinds) {
            const kindRows = layerRows
                .filter((e) => e.kind === kind)
                .sort((a, b) => b.importance - a.importance);
            if (kindRows.length === 0)
                continue;
            blocks.push(`#### ${kind}`);
            blocks.push(kindRows.map(entryItem).join('\n'));
        }
    }
    return blocks;
}
/** 01-memories.md — ALL semantic memories by state. */
export function renderMemoriesMarkdown(entries) {
    const valid = entries.filter((e) => !e.archived && !e.low_quality);
    const archived = entries.filter((e) => e.archived); // archived takes priority over low-quality
    const lowQuality = entries.filter((e) => !e.archived && e.low_quality);
    const section = (title, rows) => {
        const body = groupByLayerKind(rows);
        if (body.length === 0)
            return [`## ${title}`, '', '（暂无）', ''];
        return [`## ${title}`, ...body, ''];
    };
    const header = [
        '# dsh-memory 导出 — 语义记忆（全量）',
        '',
        `> 导出时间：${stamp()} ｜ 有效 ${valid.length} 条 ／ 已归档 ${archived.length} 条 ／ 低质量 ${lowQuality.length} 条`,
        '',
    ];
    const parts = [
        ...header,
        ...section('一、有效记忆（未归档，非低质）', valid),
        ...section('二、已归档记忆（archived=1，软删待遗忘）', archived),
        ...section('三、低质量记忆（low_quality=1，被排除出召回/注入）', lowQuality),
    ];
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
/** Render one episode as a Markdown block. */
function episodeBlock(ep) {
    const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');
    const state = ep.archived ? '（已归档）' : '';
    const extract = ep.extracted === 1 ? '已抽取' : ep.extracted === 2 ? '降级跳过' : '未处理';
    return [
        `### ${when(ep.ts)} · ${mdSafe(ep.topic)} ${state}`,
        `- 摘要：${mdSafe(ep.summary)}`,
        `- 会话：\`${ep.session_id}\` ｜ 凝练：${extract}${ep.tools_used ? ` ｜ 工具：${mdSafe(ep.tools_used)}` : ''}`,
        '',
    ].join('\n');
}
/** 02-episodes.md — ALL session summaries, time descending. */
export function renderEpisodesMarkdown(episodes) {
    const header = [
        '# dsh-memory 导出 — 情景会话摘要（全量）',
        '',
        `> 导出时间：${stamp()} ｜ 会话摘要 ${episodes.length} 条`,
        '',
    ];
    if (episodes.length === 0) {
        return [...header, '（暂无会话摘要）', ''].join('\n');
    }
    return [...header, ...episodes.map(episodeBlock)].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
/** 03-identity.md — soul.md / user.md verbatim. */
export function renderIdentityMarkdown(soul, user) {
    const head = '# dsh-memory 导出 — 身份文件';
    const soulBody = soul.trim() ? soul : '（未创建）';
    const userBody = user.trim() ? user : '（未创建）';
    return [
        head,
        '',
        '> 导出时间：' + stamp(),
        '',
        '## soul.md（AI 人格 / 行为准则，人写）',
        '',
        soulBody,
        '',
        '## user.md（用户画像，人写）',
        '',
        userBody,
        '',
    ].join('\n').trimEnd() + '\n';
}
/** Local-clock timestamp (Asia/Shanghai rendering follows the host's local tz). */
function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
/** Assemble the full three-file bundle + summary from the raw store data.
 *  Keep the signature store-agnostic: pass in the three data slices. */
export function buildMarkdownBundle(deps) {
    const { memories, episodes, soul, user } = deps;
    const memoryMd = renderMemoriesMarkdown(memories);
    const episodeMd = renderEpisodesMarkdown(episodes);
    const identityMd = renderIdentityMarkdown(soul, user);
    const valid = memories.filter((e) => !e.archived && !e.low_quality).length;
    const archived = memories.filter((e) => e.archived).length;
    const lowQuality = memories.filter((e) => !e.archived && e.low_quality).length;
    const files = [
        { name: '01-memories.md', label: '语义记忆', content: memoryMd, counts: { memories: memories.length } },
        { name: '02-episodes.md', label: '情景会话摘要', content: episodeMd, counts: { episodes: episodes.length } },
        { name: '03-identity.md', label: '身份文件', content: identityMd, counts: {} },
    ];
    return {
        files,
        effective: valid,
        archived,
        lowQuality,
        episodes: episodes.length,
        hasIdentity: Boolean(soul.trim() || user.trim()),
    };
}
