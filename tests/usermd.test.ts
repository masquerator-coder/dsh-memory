import { describe, expect, it } from 'vitest'
import { renderUserMd, groupHeading } from '../src/application/usermd-render'
import { parseUserMd } from '../src/application/usermd-parse'
import { diffUserMdEdits } from '../src/application/usermd-sync'
import type { EntityCard } from '../src/domain/card'
import type { AtomicFact } from '../src/domain/fact'

function card(over: Partial<EntityCard> = {}): EntityCard {
  return {
    entityId: 'user:alice',
    entityName: 'Alice',
    entityType: 'user',
    updatedAt: 1000,
    count: 2,
    summary: ['Alice 偏好素食'],
    groups: [
      { predicate: 'prefers_diet', title: 'prefers_diet', facts: [{ id: 'f1', predicate: 'prefers_diet', label: 'prefers_diet', content: 'Alice 偏好素食', confidence: 0.9, privacy: 'private', pii: false, type: 'semantic', updated_at: 1000 }] },
      { predicate: 'uses_technology', title: 'uses_technology', facts: [{ id: 'f2', predicate: 'uses_technology', label: 'uses_technology', content: 'Alice 使用 Go 语言', confidence: 0.8, privacy: 'private', pii: false, type: 'semantic', updated_at: 900 }] },
    ],
    ...over,
  }
}

function fact(over: Partial<AtomicFact> = {}): AtomicFact {
  return {
    schema_version: '1.0',
    id: 'f1',
    subject: { type: 'user', id: 'user:alice', name: 'Alice' },
    predicate: 'prefers_diet',
    canonical_predicate: 'prefers_diet',
    object: { type: 'concept', id: 'concept:veg', name: '素食' },
    content: 'Alice 偏好素食',
    semantic_key: 'sk-f1',
    type: 'semantic',
    scope: 'session:abc',
    entities: ['user:alice', 'concept:veg'],
    source: { type: 'conversation', credibility: 0.7 },
    confidence: 0.8,
    version: 1,
    status: 'active',
    privacy: 'private',
    pii: false,
    index_state: 'ready',
    created_at: 100,
    updated_at: 100,
    ...over,
  }
}

describe('renderUserMd', () => {
  it('renders the §8.5 structure with group predicates embedded', () => {
    const md = renderUserMd(card())
    expect(md).toContain('# User Profile: Alice')
    expect(md).toContain('## 核心摘要')
    expect(md).toContain('## 详细偏好')
    expect(md).toContain(`### prefers_diet (predicate: prefers_diet)`)
    expect(md).toContain('- Alice 偏好素食')
    expect(md).toContain('- Alice 使用 Go 语言')
  })

  it('groupHeading embeds the canonical predicate', () => {
    expect(groupHeading({ predicate: 'prefers_diet', title: '饮食', facts: [] }))
      .toBe('### 饮食 (predicate: prefers_diet)')
  })
})

describe('parseUserMd', () => {
  it('parses bullet lines into predicate/content pairs', () => {
    const md = `# User Profile: Alice

## 详细偏好
### 饮食 (predicate: prefers_diet)
- 素食，不吃香菜
- 出差偏好简餐

### 工作 (predicate: works_at)
- 后端工程师
`
    const parsed = parseUserMd(md)
    expect(parsed.entity).toBe('Alice')
    expect(parsed.lines).toHaveLength(3)
    expect(parsed.lines[0]).toEqual({ predicate: 'prefers_diet', heading: '饮食', content: '素食，不吃香菜' })
    expect(parsed.lines[2].predicate).toBe('works_at')
  })

  it('ignores bullets outside a predicate group and template placeholders', () => {
    const md = `# User Profile: Alice

## 核心摘要
- （暂无画像）
## 详细偏好
- （暂无偏好）
`
    const parsed = parseUserMd(md)
    expect(parsed.lines).toEqual([])
  })
})

describe('diffUserMdEdits', () => {
  it('produces no actions when nothing changed', () => {
    const lines = [
      { predicate: 'prefers_diet', content: 'Alice 偏好素食' },
      { predicate: 'uses_technology', content: 'Alice 使用 Go 语言' },
    ]
    const actions = diffUserMdEdits(lines, { facts: [fact(), fact({ id: 'f2', canonical_predicate: 'uses_technology', content: 'Alice 使用 Go 语言' })] })
    expect(actions).toEqual([])
  })

  it('supersedes when a line content changes and archives removed facts', () => {
    const base = [fact(), fact({ id: 'f2', canonical_predicate: 'uses_technology', content: 'Alice 使用 Go 语言' })]
    const lines = [
      { predicate: 'prefers_diet', content: 'Alice 偏好素食（不吃香菜）' }, // changed
    ]
    const actions = diffUserMdEdits(lines, { facts: base })
    expect(actions).toContainEqual({ kind: 'supersede', factId: 'f1', line: { predicate: 'prefers_diet', content: 'Alice 偏好素食（不吃香菜）' } })
    expect(actions).toContainEqual({ kind: 'archive', factId: 'f2' })
  })

  it('adds a brand-new line when the group has no facts', () => {
    const actions = diffUserMdEdits(
      [{ predicate: 'speaks', content: 'Alice 说中文' }],
      { facts: [fact()] },
    )
    expect(actions).toContainEqual({ kind: 'add', line: { predicate: 'speaks', content: 'Alice 说中文' } })
  })
})
