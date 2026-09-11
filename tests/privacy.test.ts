import { describe, expect, it } from 'vitest'
import { scanPii, privacyAllowed, filterByPrivacy } from '../src/application/privacy'
import { buildPolicy } from '../src/build-policy'

describe('scanPii', () => {
  it('detects a CN id number and redacts it', () => {
    const text = '身份证 110105199003078272 是我的'
    const scan = scanPii(text)
    expect(scan.detected).toBe(true)
    expect(scan.kinds).toContain('cn_id')
    expect(scan.redacted).not.toContain('110105199003078272')
  })

  it('detects a phone and email', () => {
    const scan = scanPii('联系 13800138000 或 a@b.com')
    expect(scan.kinds).toContain('phone')
    expect(scan.kinds).toContain('email')
  })

  it('flags explicit secrets', () => {
    const scan = scanPii('my api_key = sk-abc123')
    expect(scan.detected).toBe(true)
  })

  it('passes benign text', () => {
    expect(scanPii('我的偏好是素食').detected).toBe(false)
  })
})

describe('privacy filtering', () => {
  const policy = buildPolicy({})

  it('allows configured privacy tiers', () => {
    expect(privacyAllowed('public', ['public', 'private'])).toBe(true)
    expect(privacyAllowed('confidential', ['public', 'private'])).toBe(false)
  })

  it('drops secret unless explicitly allowed', () => {
    const items = [
      { privacy: 'private' as const, content: 'a', pii: false },
      { privacy: 'secret' as const, content: 'b', pii: false },
    ]
    const kept = filterByPrivacy(items, policy.privacy)
    expect(kept.map(k => k.privacy)).toEqual(['private'])
  })
})
