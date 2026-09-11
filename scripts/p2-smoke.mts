/**
 * P2 smoke check — Node-native type-stripping run of the core pure paths that
 * vitest cannot execute inside this sandbox (esbuild service EPERM). Verifies
 * that card aggregation, user.md render→parse→sync round-trip, procedural
 * normalization, and the full service write-back path behave as designed.
 *
 * Run:  node scripts/p2-smoke.mts
 * Exit 0 on success, non-zero with a message on failure.
 */
import { buildEntityCard } from '../src/application/card.ts'
import { renderUserMd } from '../src/application/usermd-render.ts'
import { parseUserMd } from '../src/application/usermd-parse.ts'
import { diffUserMdEdits } from '../src/application/usermd-sync.ts'
import { normalizeProcedure, stepsFromContent } from '../src/domain/procedural.ts'
import { EntityResolver } from '../src/domain/entity.ts'
import { buildPolicy } from '../src/build-policy.ts'
import { JsonFileMemoryRepository } from '../src/infrastructure/json-repo.ts'
import { MemoryService } from '../src/service.ts'
import type { RawAssertion } from '../src/domain/factory.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}`, detail ?? '')
  }
}

const policy = buildPolicy({})

function makeResolver(): EntityResolver {
  const r = new EntityResolver()
  r.upsert({ id: 'user:alice', type: 'user', name: 'Alice', aliases: ['Alice'] })
  r.upsert({ id: 'diet:vegetarian', type: 'concept', name: '素食', aliases: ['素食'] })
  r.upsert({ id: 'diet:keto', type: 'concept', name: '生酮', aliases: ['生酮'] })
  r.upsert({ id: 'lang:go', type: 'concept', name: 'Go 语言', aliases: ['Go'] })
  return r
}

async function main(): Promise<void> {
  console.log('== P2-1 entity card ==')
  {
    const repo = new JsonFileMemoryRepository()
    const res = makeResolver()
    const base: Omit<RawAssertion, 'content' | 'confidence'> = {
      subject: { type: 'user', name: 'Alice' },
      predicate: 'prefers_diet',
      object: { type: 'concept', name: '素食' },
      type: 'semantic',
      scope: 'global',
      source: { type: 'conversation', credibility: 0.7 },
    }
    const service = new MemoryService({ repo, resolver: res, policy: () => policy, captureEnabled: false, llmExtractionEnabled: false })
    await service.remember({ content: 'Alice 偏好素食', scope: 'global', subject: { type: 'user', name: 'Alice' }, predicate: 'prefers_diet' })
    await service.remember({ content: 'Alice 使用 Go 语言', scope: 'global', subject: { type: 'user', name: 'Alice' }, predicate: 'uses_technology' })
    const card = await service.getCard('user:alice')
    check('card groups 2 predicates', card.groups.length === 2, card.groups.map(g => g.predicate))
    check('card summary non-empty', card.summary.length >= 1, card.summary)
    const md = await service.renderUserMd('global')
    check('user.md contains profile heading', md.includes('# User Profile: Alice'), md)
    check('user.md contains both bullets', md.includes('偏好素食') && md.includes('Go 语言'))
    // Procedural wiring via remember.
    await service.remember({
      content: '发布流程：先跑测试再灰度',
      scope: 'global',
      type: 'procedural',
      predicate: 'deploy_procedure',
      subject: { type: 'user', name: 'Alice' },
      procedure: { steps: ['跑测试', '灰度发布'], preconditions: ['tests_passed'] },
    })
    const facts = await repo.listScope('global')
    const proc = facts.find(f => f.type === 'procedural')
    check('procedural fact has 2 steps', proc?.steps?.length === 2, proc?.steps)
    check('procedural tool_chain derived', JSON.stringify(proc?.tool_chain) === JSON.stringify(['跑测试', '灰度发布']), proc?.tool_chain)
  }

  console.log('== P2-2 user.md write-back round trip ==')
  {
    const repo = new JsonFileMemoryRepository()
    const res = makeResolver()
    const service = new MemoryService({ repo, resolver: res, policy: () => policy, captureEnabled: false, llmExtractionEnabled: false })
    await service.remember({ content: 'Alice 偏好素食', scope: 'u', predicate: 'prefers_diet' })
    await service.remember({ content: 'Alice 使用 Go 语言', scope: 'u', predicate: 'uses_technology' })

    const rendered1 = await service.renderUserMd('u')
    check('rendered includes detailed heading', rendered1.includes('### prefers_diet (predicate: prefers_diet)'), rendered1)
    // Simulate a user edit: rewrite the detailed section — change one
    // preference and add a new group. (摘要 section lines carry no predicate
    // and are intentionally ignored by the parser.)
    const edited = `# User Profile: Alice

## 核心摘要
- Alice 偏好素食（不吃香菜）

## 详细偏好

### prefers_diet (predicate: prefers_diet)
- Alice 偏好素食（不吃香菜）

### uses_technology (predicate: uses_technology)
- Alice 使用 Go 语言

### speaks (predicate: speaks)
- Alice 说中文
`
    const parsed = parseUserMd(edited)
    check('parse picks up 3 lines', parsed.lines.length === 3, parsed.lines)
    const report = await service.applyUserMdEdits('u', edited)
    check('superseded + added both reported', report.superseded >= 1 && report.added >= 1, report)  // 1 supersede (prefers_diet) + 1 add (speaks)


    const facts = await repo.listScope('u')
    const changed = facts.find(f => f.content.includes('不吃香菜'))
    check('edited line persisted', changed !== undefined, facts.map(f => f.content))
    const superseded = facts.find(f => f.content === 'Alice 偏好素食' && f.status === 'superseded')
    check('old fact superseded', superseded !== undefined, facts.map(f => `${f.status}:${f.content}`))
    const keptGo = facts.find(f => f.content.includes('Go 语言') && f.status === 'active')
    check('unchanged line kept active (not archived)', keptGo !== undefined, facts.map(f => `${f.status}:${f.content}`))
    check('added speaks fact present', facts.some(f => f.content === 'Alice 说中文'), facts.map(f => f.content))

    // user_edit credibility must be 1.0 on the new/changed fact.
    check('user_edit credibility 1.0', changed?.source.credibility === 1, changed?.source)
  }

  console.log('== P2-3 procedural normalization ==')
  {
    const p = normalizeProcedure({ steps: [{ id: 't', tool: 'ci.run' }, { id: 'c', tool: 'k8s.canary', depends_on: ['t'], on_failure: 'rollback' }], preconditions: ['approved'] })
    check('steps tool_chain', JSON.stringify(p.tool_chain) === JSON.stringify(['ci.run', 'k8s.canary']), p.tool_chain)
    check('depends_on kept', JSON.stringify(p.steps[1].depends_on) === JSON.stringify(['t']))
    check('on_failure rollback', p.steps[1].on_failure === 'rollback')
    const migrated = stepsFromContent('部署：\n1. 跑测试\n2. 灰度')
    check('content migration detects steps', migrated.length === 2, migrated)
  }

  console.log(`\n${failures === 0 ? 'ALL P2 SMOKE CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  if (failures > 0) process.exit(1)
}

void main()
