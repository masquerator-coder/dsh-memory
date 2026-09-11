import { describe, expect, it } from 'vitest'
import { matchRules, looksFactWorthy } from '../src/extraction/rules'

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
})

describe('looksFactWorthy', () => {
  it('detects version/entity-rich statements', () => {
    expect(looksFactWorthy('版本是 v2.3')).toBe(true)
    expect(looksFactWorthy('普通闲聊')).toBe(false)
  })
})
