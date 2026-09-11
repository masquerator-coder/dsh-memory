import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UserMdFile } from '../src/infrastructure/usermd-file'

const temps: string[] = []

async function tempPath() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-umd-'))
  temps.push(dir)
  return join(dir, 'user.md')
}

afterEach(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true })
  temps.length = 0
})

describe('UserMdFile', () => {
  it('reads an absent file as empty and round-trips write/read', async () => {
    const path = await tempPath()
    const file = new UserMdFile(path)
    expect(await file.read()).toBe('')
    await file.write('# User Profile: Alice\n- 诉求\n')
    expect(await file.read()).toContain('# User Profile: Alice')
  })

  it('ignores its own writes in hasExternalChange, flags external edits', async () => {
    const path = await tempPath()
    const file = new UserMdFile(path)
    await file.write('A\n')
    expect(await file.hasExternalChange()).toBe(false)
    // Simulate an external editor writing different content.
    await writeFile(path, 'B\n', 'utf8')
    expect(await file.hasExternalChange()).toBe(true)
  })
})
