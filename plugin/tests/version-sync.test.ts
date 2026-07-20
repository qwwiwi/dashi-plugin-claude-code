// Version discipline: the plugin has exactly one user-facing version and it
// must be identical everywhere it is declared. Claude Code resolves the
// plugin version from the repo-root .claude-plugin/plugin.json (and `/plugin
// update` only fires on a bump there), while the MCP server identity in
// src/server.ts reads plugin/package.json. A drift between the two would ship
// a plugin that reports one version to Claude Code and another over MCP.
import { describe, expect, test } from 'bun:test'
import { join } from 'path'

const PLUGIN_DIR = join(import.meta.dir, '..')
const REPO_ROOT = join(PLUGIN_DIR, '..')

// Strict semver core: MAJOR.MINOR.PATCH, no leading zeros, no pre-release —
// releases of this plugin are always plain stable versions.
const SEMVER_CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

async function readJson(path: string): Promise<Record<string, unknown>> {
  const raw = await Bun.file(path).text()
  return JSON.parse(raw) as Record<string, unknown>
}

describe('version sync', () => {
  test('plugin.json and package.json declare the same semver version', async () => {
    const manifest = await readJson(join(REPO_ROOT, '.claude-plugin', 'plugin.json'))
    const pkg = await readJson(join(PLUGIN_DIR, 'package.json'))

    expect(typeof manifest.version).toBe('string')
    expect(typeof pkg.version).toBe('string')
    expect(manifest.version as string).toMatch(SEMVER_CORE)
    expect(pkg.version).toBe(manifest.version)
  })

  test('manifest name matches the package name', async () => {
    const manifest = await readJson(join(REPO_ROOT, '.claude-plugin', 'plugin.json'))
    const pkg = await readJson(join(PLUGIN_DIR, 'package.json'))
    expect(manifest.name).toBe('agent47-channel')
    expect(pkg.name).toBe(manifest.name)
  })

  test('server identity has no hardcoded version literal', async () => {
    // The MCP Server(...) identity must read pkg.version, not a string —
    // that is what keeps the third declaration site from drifting.
    const src = await Bun.file(join(PLUGIN_DIR, 'src', 'server.ts')).text()
    expect(src).toMatch(/version:\s*pkg\.version/)
    expect(src).not.toMatch(/name: 'agent47-channel',\s*version:\s*'/)
  })
})
