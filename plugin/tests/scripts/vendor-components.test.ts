// Tests for plugin/scripts/vendor-components.sh: the refresh of the vendored
// html-components packs. The script runs from a COPY inside a temp tree (so
// the real plugin/vendor folder is never touched) and reads a local tarball
// via HTML_COMPONENTS_TARBALL; a dead proxy makes any accidental download
// fail fast instead of reaching the network.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, linkSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'vendor-components.sh')
const SHA = 'a'.repeat(40)
const PREFIX = `html-components-${SHA}`

let root: string
let dest: string

function run(args: string[], tarball?: string): { code: number; out: string } {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    https_proxy: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
  }
  if (tarball !== undefined) env.HTML_COMPONENTS_TARBALL = tarball
  const res = spawnSync('bash', [join(root, 'scripts', 'vendor-components.sh'), ...args], { env, encoding: 'utf8' })
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` }
}

// Stage an upstream-shaped tree and pack it; `extra` adds hostile entries.
function stageUpstream(): string {
  const stage = join(root, 'stage')
  mkdirSync(join(stage, PREFIX, 'telegram'), { recursive: true })
  writeFileSync(join(stage, PREFIX, 'telegram', 'index.mjs'), 'export const ok = 1\n')
  writeFileSync(join(stage, PREFIX, 'telegram', 'x.test.mjs'), 'test file\n')
  writeFileSync(join(stage, PREFIX, 'LICENSE'), 'MIT\n')
  return stage
}

function tar(stage: string, extraArgs: string[], members: string[]): string {
  const out = join(root, 'src.tgz')
  const res = spawnSync('tar', ['-C', stage, ...extraArgs, '-czf', out, ...members], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`tar failed: ${res.stderr}`)
  return out
}

function listing(tarball: string): string {
  return spawnSync('tar', ['-tzvf', tarball], { encoding: 'utf8' }).stdout
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vendor-components-'))
  mkdirSync(join(root, 'scripts'))
  copyFileSync(SCRIPT, join(root, 'scripts', 'vendor-components.sh'))
  dest = join(root, 'vendor', 'html-components')
  mkdirSync(join(dest, 'telegram'), { recursive: true })
  writeFileSync(join(dest, 'telegram', 'index.mjs'), 'export const previous = 1\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function previousCopyIntact(): void {
  expect(readFileSync(join(dest, 'telegram', 'index.mjs'), 'utf8')).toBe('export const previous = 1\n')
}

describe('vendor-components.sh — sha argument', () => {
  test('a sha followed by a second line is refused (the regex is anchored to the whole argument)', () => {
    const r = run([`${SHA}\nextra`])
    expect(r.code).toBe(2)
    expect(r.out).toContain('full 40-character commit sha')
  })

  test('a short sha is refused', () => {
    expect(run(['abc1234']).code).toBe(2)
  })
})

describe('vendor-components.sh — archive safety (checked before extraction)', () => {
  test('a clean archive is vendored: telegram/ replaced, upstream tests dropped, VENDOR.md pinned', () => {
    const tgz = tar(stageUpstream(), [], [PREFIX])
    const r = run([SHA], tgz)
    expect(r.code).toBe(0)
    expect(readFileSync(join(dest, 'telegram', 'index.mjs'), 'utf8')).toBe('export const ok = 1\n')
    expect(existsSync(join(dest, 'telegram', 'x.test.mjs'))).toBe(false)
    expect(readFileSync(join(dest, 'VENDOR.md'), 'utf8')).toContain(SHA)
  })

  test('a symlink inside the archive: refused, nothing extracted or replaced', () => {
    const stage = stageUpstream()
    symlinkSync('/etc/passwd', join(stage, PREFIX, 'telegram', 'leak.mjs'))
    const tgz = tar(stage, [], [PREFIX])
    expect(listing(tgz)).toContain('-> /etc/passwd')
    const r = run([SHA], tgz)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('unsafe archive')
    previousCopyIntact()
  })

  test('a hardlink inside the archive: refused', () => {
    const stage = stageUpstream()
    linkSync(join(stage, PREFIX, 'LICENSE'), join(stage, PREFIX, 'telegram', 'copy.mjs'))
    const tgz = tar(stage, [], [PREFIX])
    expect(listing(tgz)).toContain(' link to ')
    const r = run([SHA], tgz)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('unsafe archive')
    previousCopyIntact()
  })

  test('a member path climbing out of the archive root (..): refused', () => {
    const stage = stageUpstream()
    writeFileSync(join(stage, 'evil'), 'x\n')
    const tgz = tar(stage, ['--transform', `s,^evil$,${PREFIX}/../../evil,`], [PREFIX, 'evil'])
    expect(listing(tgz)).toContain(`${PREFIX}/../../evil`)
    const r = run([SHA], tgz)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('unsafe archive')
    expect(existsSync(join(root, 'evil'))).toBe(false)
    previousCopyIntact()
  })

  test('a member outside the expected top folder: refused', () => {
    const stage = stageUpstream()
    writeFileSync(join(stage, 'other'), 'x\n')
    const tgz = tar(stage, [], [PREFIX, 'other'])
    const r = run([SHA], tgz)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('unsafe archive')
    previousCopyIntact()
  })
})
