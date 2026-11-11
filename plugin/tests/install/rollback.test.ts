import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../../..')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(stashFails = false) {
  const dir = mkdtempSync(join(tmpdir(), 'channel rollback ')); dirs.push(dir)
  const repo = join(dir, 'repo'); mkdirSync(repo)
  cpSync(join(root, 'scripts'), join(repo, 'scripts'), { recursive: true })
  cpSync(join(root, 'update.sh'), join(repo, 'update.sh'))
  mkdirSync(join(repo, 'plugin'))
  writeFileSync(join(repo, 'user-file'), 'original\n')
  writeFileSync(join(repo, 'staged-file'), 'original staged\n')
  writeFileSync(join(repo, 'deleted-file'), 'original deleted\n')
  function git(...args: string[]) {
    const p = Bun.spawnSync(['/usr/bin/git', ...args], {
      cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }, stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  git('init', '-q')
  // Build fixture history with plumbing; never invoke the user's prohibited add/commit commands.
  for (const file of git('ls-files', '--others', '--exclude-standard').split('\n')) {
    const mode = statSync(join(repo, file)).mode & 0o111 ? '100755' : '100644'
    git('update-index', '--add', '--cacheinfo', mode, git('hash-object', '-w', '--', file), file)
  }
  const before = git('commit-tree', git('write-tree'), '-m', 'Initial fixture')
  git('update-ref', 'HEAD', before)
  writeFileSync(join(repo, 'new-version'), 'updated\n')
  git('update-index', '--add', '--cacheinfo', '100644', git('hash-object', '-w', '--', 'new-version'), 'new-version')
  const after = git('commit-tree', git('write-tree'), '-p', before, '-m', 'Updated fixture')
  git('update-ref', 'HEAD', after)
  git('checkout', '-q', before)
  const state = join(dir, 'state'); mkdirSync(state)
  const workspace = join(dir, 'workspace'); mkdirSync(workspace)
  const envFile = join(state, 'channel.env')
  writeFileSync(envFile, 'TELEGRAM_ALLOWED_USER_IDS=123456\n')
  writeFileSync(join(state, 'install.json'), JSON.stringify({
    agent: 'student', workspace, settings: join(workspace, 'settings.json'), envFile,
    pluginDir: join(repo, 'plugin'), serviceFile: join(state, 'channel-student.service'), session: 'channel-student',
  }))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  const log = join(dir, 'calls')
  function command(name: string, body: string) {
    writeFileSync(join(bin, name), `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 })
  }
  command('claude', 'echo "2.1.80 (Claude Code)"')
  command('tmux', 'echo "tmux 3.4"')
  command('uname', 'echo Linux')
  command('git', `echo "git $*" >> "$TEST_LOG"
if [[ "\${1:-}" == pull ]]; then exec /usr/bin/git merge --ff-only "$TEST_NEW_COMMIT"; fi
if [[ "\${1:-}" == stash && "\${2:-}" == push && "\${TEST_STASH_FAIL:-}" == 1 ]]; then echo 'simulated stash failure' >&2; exit 1; fi
exec /usr/bin/git "$@"`)
  command('bun', `if [[ "\${1:-}" == --version ]]; then echo 1.3.14
elif [[ "\${1:-}" == install ]]; then exit 0
elif [[ "\${1:-}" == test ]]; then
  echo 'bun test v1.3.14'; echo 'tests/fixture.test.ts:'
  if [[ -f "$TEST_REPO/new-version" ]]; then
    echo 'edited during tests' > "$TEST_REPO/user-file"
    echo 'staged during tests' > "$TEST_REPO/staged-file"
    staged_blob="$(/usr/bin/git -C "$TEST_REPO" hash-object -w -- staged-file)"
    /usr/bin/git -C "$TEST_REPO" update-index --cacheinfo "100644,$staged_blob,staged-file"
    rm "$TEST_REPO/deleted-file"
    echo 'runner failed after editing a tracked file' >&2; exit 127
  fi
  echo ' 1 pass'; echo ' 0 fail'; echo 'Ran 1 test across 1 file. [1.00ms]'
else exec '${process.execPath.replace(/'/g, "'\\''")}' "$@"; fi`)
  function run() {
    const p = Bun.spawnSync(['bash', join(repo, 'update.sh'), '--state-dir', state], {
      cwd: repo, env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log,
        TEST_NEW_COMMIT: after, TEST_REPO: repo, TEST_STASH_FAIL: stashFails ? '1' : '0' },
      stdout: 'pipe', stderr: 'pipe',
    })
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
  }
  return { repo, log, before, after, git, run }
}

describe('update rollback preserves tracked edits made during tests', () => {
  test('stashes edits before resetting and prints a timestamped stash and restore command', () => {
    const f = fixture(); const r = f.run()
    expect(r.code).not.toBe(0)
    expect(f.git('rev-parse', 'HEAD')).toBe(f.before)
    expect(f.git('stash', 'list')).toMatch(/channel-update-rollback-\d{8}T\d{6}Z/)
    const stash = f.git('rev-parse', 'refs/stash')
    expect(f.git('show', `${stash}:user-file`)).toBe('edited during tests')
    expect(f.git('show', `${stash}^2:staged-file`)).toBe('staged during tests')
    expect(f.git('ls-tree', '--name-only', stash)).not.toContain('deleted-file')
    expect(readFileSync(join(f.repo, 'user-file'), 'utf8')).toBe('original\n')
    expect(readFileSync(join(f.repo, 'staged-file'), 'utf8')).toBe('original staged\n')
    expect(existsSync(join(f.repo, 'deleted-file'))).toBe(true)
    expect(r.out).toContain(stash)
    expect(r.out).toContain(`git stash apply ${stash}`)
    const calls = readFileSync(f.log, 'utf8')
    expect(calls.indexOf('git stash push')).toBeLessThan(calls.indexOf('git reset --hard'))
  })

  test('stash failure leaves the updated commit and tracked edits intact without resetting', () => {
    const f = fixture(true); const r = f.run()
    expect(r.code).not.toBe(0)
    expect(f.git('rev-parse', 'HEAD')).toBe(f.after)
    expect(readFileSync(join(f.repo, 'user-file'), 'utf8')).toBe('edited during tests\n')
    expect(f.git('show', ':staged-file')).toBe('staged during tests')
    expect(existsSync(join(f.repo, 'deleted-file'))).toBe(false)
    expect(readFileSync(f.log, 'utf8')).not.toContain('git reset')
    expect(r.out).toContain('Rollback stopped')
    expect(r.out).toContain('save the tracked changes')
    expect(r.out).toContain(`git reset --hard ${f.before}`)
  })
})
