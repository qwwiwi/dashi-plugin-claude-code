import { describe, expect, test } from 'bun:test'
import { parseTestFailures, addedFailures } from '../../../scripts/test-failure-baseline'

const output = (file: string, names: string[]) => `bun test v1.3.14\n${file}:\n${names.map(n => `(fail) ${n} [1.25ms]`).join('\n')}\n 1 pass\n ${names.length} fail\nRan ${names.length + 1} tests across 1 file. [2.00ms]\n`

describe('update test failure baseline', () => {
  test('uses file and full test name, ignoring timing and ANSI color', () => {
    const before = parseTestFailures(output('tests/old.test.ts', ['suite > same name']), 1)
    const after = parseTestFailures(output('tests/new.test.ts', ['suite > same name']).replace('(fail)', '\x1b[31m(fail)\x1b[0m'), 1)
    expect(addedFailures(before, after)).toEqual(['tests/new.test.ts > suite > same name'])
    expect(addedFailures(before, parseTestFailures(output('tests/old.test.ts', ['suite > same name']).replace('1.25ms', '4.50ms'), 1))).toEqual([])
  })
  test('removed failures are allowed and duplicate names form a set', () => {
    const before = parseTestFailures(output('tests/a.test.ts', ['old', 'old', 'fixed']), 1)
    expect(before).toEqual(['tests/a.test.ts > fixed', 'tests/a.test.ts > old'])
    expect(addedFailures(before, parseTestFailures(output('tests/a.test.ts', ['old']), 1))).toEqual([])
  })
  test('rejects runner startup failure, truncated results and unattributed failures', () => {
    expect(() => parseTestFailures('bun: command not found', 127)).toThrow()
    expect(() => parseTestFailures(output('tests/a.test.ts', ['failure']), 137)).toThrow()
    expect(() => parseTestFailures(output('tests/a.test.ts', ['failure']).replace(' 1 fail', ' 2 fail'), 1)).toThrow()
    expect(() => parseTestFailures(output('tests/a.test.ts', ['failure']).replace('tests/a.test.ts:\n', ''), 1)).toThrow()
    expect(() => parseTestFailures('bun test v1.3.14\n 1 pass\n 0 fail\n', 0)).toThrow()
  })
  test('rejects unhandled runner errors even when named failures match baseline', () => {
    expect(() => parseTestFailures(output('tests/a.test.ts', ['old']).replace(' 1 pass', ' 1 error\n 1 pass'), 1)).toThrow()
    expect(() => parseTestFailures(output('tests/a.test.ts', []), 1)).toThrow()
  })
})
