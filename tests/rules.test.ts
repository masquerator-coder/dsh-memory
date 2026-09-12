import { describe, expect, it } from 'vitest'
import { matchRules, looksFactWorthy, looksLikeTerminalDump } from '../src/extraction/rules'

const TRIGGERS = ['记住', '以后都', '我的偏好是', '我一般', '我不太', '别再', '以后别']

describe('matchRules', () => {
  it('captures an explicit preference statement', () => {
    const m = matchRules('我的偏好是简洁回答', TRIGGERS)
    expect(m).not.toBeNull()
    expect(m!.statement).toContain('简洁回答')
    expect(m!.type).toBe('semantic')
  })

  it('captures a "记住" note', () => {
    const m = matchRules('记住，项目部署在阿里云 ACK', TRIGGERS)
    expect(m!.statement).toContain('阿里云 ACK')
  })

  it('returns null for non-memory messages', () => {
    expect(matchRules('今天天气怎么样', TRIGGERS)).toBeNull()
    expect(matchRules('帮我写一段代码', TRIGGERS)).toBeNull()
  })

  it('strips the trigger and trailing punctuation', () => {
    const m = matchRules('我不太喜欢吃香菜', TRIGGERS)
    expect(m!.statement).toBe('喜欢吃香菜')
  })

  it('strips the separator left behind by the trigger', () => {
    expect(matchRules('记住，项目部署在阿里云 ACK', TRIGGERS)!.statement).toBe('项目部署在阿里云 ACK')
    expect(matchRules('请记住: 项目用 pnpm 管理', TRIGGERS)!.statement).toBe('项目用 pnpm 管理')
    expect(matchRules('记住， 我 偏好简短回答', TRIGGERS)!.statement).toBe('偏好简短回答')
  })
})

describe('looksFactWorthy', () => {
  it('detects version/entity-rich statements', () => {
    expect(looksFactWorthy('版本是 v2.3')).toBe(true)
    expect(looksFactWorthy('普通闲聊')).toBe(false)
  })
})

describe('looksLikeTerminalDump', () => {
  it('rejects a multi-line pasted shell/command transcript', () => {
    const dump = [
      'PS D:\\Apps\\deepseek-harness> pnpm test',
      '$ vitest run',
      ' Test Files  16 passed (16)',
      '      Tests  84 passed (84)',
      'PS D:\\Apps\\deepseek-harness>',
    ].join('\n')
    expect(looksLikeTerminalDump(dump)).toBe(true)
  })

  it('rejects a pasted build/install error transcript without a prompt', () => {
    const dump = [
      'Tests  1 failed | 83 passed (84)',
      'error TS2345: Argument of type X',
      'ELIFECYCLE] Command failed',
    ].join('\n')
    expect(looksLikeTerminalDump(dump)).toBe(true)
  })

  it('passes single-line commands and ordinary queries', () => {
    expect(looksLikeTerminalDump('跑一下 pnpm test')).toBe(false)
    expect(looksLikeTerminalDump('为什么 EPERM 报错？')).toBe(false)
    expect(looksLikeTerminalDump('我的偏好是简洁回答')).toBe(false)
  })

  it('passes a multi-line normal preference statement', () => {
    const note = '记住：\n1. 项目部署在阿里云\n2. 用 pnpm 管理依赖'
    expect(looksLikeTerminalDump(note)).toBe(false)
  })
})
