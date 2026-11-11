// Compare completed Bun console reports without treating pre-existing failures as regressions.
import { readFileSync, writeFileSync } from 'node:fs'

export function parseTestFailures(output: string, exitCode: number): string[] {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const passes = plain.match(/^\s*(\d+) pass\s*$/m)
  const failures = plain.match(/^\s*(\d+) fail\s*$/m)
  if (!/^bun test v/m.test(plain) || !passes || !failures
      || !/^Ran \d+ tests? across \d+ files?\./m.test(plain)
      || /^\s*[1-9]\d* errors?\s*$/m.test(plain)
      || (exitCode !== 0 && exitCode !== 1)) {
    throw new Error('Test runner did not produce a completed, readable Bun test report')
  }
  const names: string[] = []
  let file = ''
  for (const line of plain.split(/\r?\n/)) {
    const heading = line.match(/^(.+\.(?:[cm]?[jt]s|[jt]sx)):$/)
    if (heading) file = heading[1]!.replace(/^\.\//, '')
    if (line.startsWith('(fail) ')) {
      if (!file) throw new Error('Test failure has no source file')
      const name = line.slice(7).replace(/ \[\d+(?:\.\d+)?(?:ms|s|µs|us|ns)\]$/, '')
      names.push(`${file} > ${name}`)
    }
  }
  const count = Number(failures[1])
  if (names.length !== count || (count === 0 ? exitCode !== 0 : exitCode !== 1)) {
    throw new Error('Test runner exit status or failure count does not match its report')
  }
  return [...new Set(names)].sort()
}

export function addedFailures(before: string[], after: string[]): string[] {
  const baseline = new Set(before)
  return after.filter(name => !baseline.has(name))
}

if (import.meta.main) {
  try {
    const [mode, first, second, destination, label] = process.argv.slice(2)
    if (mode === 'snapshot' && first && second && destination && label) {
      const names = parseTestFailures(readFileSync(first, 'utf8'), Number(second))
      writeFileSync(destination, JSON.stringify(names), { mode: 0o600 })
      console.log(`${label} failures: ${names.length}`)
    } else if (mode === 'compare' && first && second) {
      const before: string[] = JSON.parse(readFileSync(first, 'utf8'))
      const after: string[] = JSON.parse(readFileSync(second, 'utf8'))
      const added = addedFailures(before, after)
      console.log(`New failures: ${added.length}`)
      for (const name of added) console.log(`  ${name}`)
      if (added.length) process.exit(1)
    } else throw new Error('Invalid test-baseline helper arguments')
  } catch {
    console.error('Cannot establish test failures: test runner failed to start/complete or its report is unreadable.')
    process.exit(1)
  }
}
