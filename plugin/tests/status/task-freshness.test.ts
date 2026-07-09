// Tests for the freshness indicator: the exact «сверено / УСТАРЕЛИ / НЕ СВЕРЕНО
// / завершена» strings (contractually stable) + how the two surfaces embed them.

import { describe, expect, test } from 'bun:test'
import {
  bucketAge,
  formatUtcHm,
  renderFreshnessHeader,
  type TaskFreshness,
} from '../../src/status/task-freshness.js'
import { renderStatusTasks } from '../../src/status/context-hud.js'
import { renderTodoList } from '../../src/status/task-mirror.js'
import type { TodoItem } from '../../src/schemas.js'

describe('bucketAge', () => {
  test('sub-minute → «меньше минуты»', () => {
    expect(bucketAge(0)).toBe('меньше минуты')
    expect(bucketAge(59_999)).toBe('меньше минуты')
  })
  test('minutes floored', () => {
    expect(bucketAge(60_000)).toBe('1 мин')
    expect(bucketAge(179_000)).toBe('2 мин')
  })
})

describe('formatUtcHm', () => {
  test('formats HH:MM in UTC, zero-padded', () => {
    // 2026-07-09T08:05:00Z
    expect(formatUtcHm(Date.UTC(2026, 6, 9, 8, 5, 0))).toBe('08:05')
  })
})

describe('renderFreshnessHeader — verbatim contract', () => {
  test('fresh, <1 min', () => {
    expect(renderFreshnessHeader({ kind: 'fresh', reconciledAgeMs: 5_000 })).toEqual({
      label: '<b>Задачи</b> · <i>сверено меньше минуты назад</i>',
    })
  })
  test('fresh, N min', () => {
    expect(renderFreshnessHeader({ kind: 'fresh', reconciledAgeMs: 130_000 })).toEqual({
      label: '<b>Задачи</b> · <i>сверено 2 мин назад</i>',
    })
  })
  test('stale', () => {
    expect(
      renderFreshnessHeader({ kind: 'stale', reconciledAgeMs: 120_000, eventAgeMs: 30_000 }),
    ).toEqual({
      label: '<b>Задачи — ДАННЫЕ УСТАРЕЛИ</b>',
      sub: '<i>сверено 2 мин назад · событие меньше минуты назад</i>',
    })
  })
  test('unverified', () => {
    expect(renderFreshnessHeader({ kind: 'unverified' })).toEqual({
      label: '<b>Задачи — НЕ СВЕРЕНО</b>',
      sub: '<i>Показаны только события инструментов</i>',
    })
  })
  test('ended with a reconciled time', () => {
    expect(renderFreshnessHeader({ kind: 'ended', reconciledAtLabel: '08:05' })).toEqual({
      label: '<b>Задачи</b> · <i>сессия завершена · сверено 08:05 UTC</i>',
    })
  })
  test('ended without any reconciliation', () => {
    expect(renderFreshnessHeader({ kind: 'ended', reconciledAtLabel: null })).toEqual({
      label: '<b>Задачи</b> · <i>сессия завершена</i>',
    })
  })
})

describe('minute-bucket stability (edit-only-on-bucket-cross)', () => {
  test('two ages inside one bucket render identical labels', () => {
    const a = renderFreshnessHeader({ kind: 'fresh', reconciledAgeMs: 30_000 })
    const b = renderFreshnessHeader({ kind: 'fresh', reconciledAgeMs: 59_000 })
    expect(a).toEqual(b)
  })
  test('crossing a minute changes the label', () => {
    const a = renderFreshnessHeader({ kind: 'fresh', reconciledAgeMs: 59_000 })
    const b = renderFreshnessHeader({ kind: 'fresh', reconciledAgeMs: 61_000 })
    expect(a).not.toEqual(b)
  })
})

const todos: TodoItem[] = [
  { id: '1', content: 'Build', status: 'in_progress' },
  { id: '2', content: 'Ship', status: 'pending' },
]

describe('surface embedding — context HUD', () => {
  const fresh: TaskFreshness = { kind: 'fresh', reconciledAgeMs: 5_000 }
  test('renderStatusTasks uses the freshness label in place of «Задачи»', () => {
    const out = renderStatusTasks(todos, fresh)
    expect(out.startsWith('<b>Задачи</b> · <i>сверено меньше минуты назад</i> ')).toBe(true)
    expect(out).toContain('0/2') // done/total bar counts still present
  })
  test('stale subline is rendered above the blockquote', () => {
    const out = renderStatusTasks(todos, { kind: 'stale', reconciledAgeMs: 120_000, eventAgeMs: 30_000 })
    expect(out).toContain('<b>Задачи — ДАННЫЕ УСТАРЕЛИ</b>')
    expect(out).toContain('<i>сверено 2 мин назад · событие меньше минуты назад</i>')
  })
  test('no freshness → legacy «Задачи» header (back-compat)', () => {
    expect(renderStatusTasks(todos).startsWith('<b>Задачи</b> ')).toBe(true)
  })
})

describe('surface embedding — TaskMirror', () => {
  test('renderTodoList swaps the header for the freshness label + subline', () => {
    const out = renderTodoList(todos, 5, undefined, { kind: 'unverified' })
    const lines = out.split('\n')
    expect(lines[0]).toBe('<b>Задачи — НЕ СВЕРЕНО</b>')
    expect(lines[1]).toBe('<i>Показаны только события инструментов</i>')
    expect(lines[2]).toBe('0 done / 1 in progress / 1 pending')
  })
  test('empty list still carries the freshness header', () => {
    const out = renderTodoList([], 5, undefined, { kind: 'ended', reconciledAtLabel: '09:00' })
    expect(out).toBe('<b>Задачи</b> · <i>сессия завершена · сверено 09:00 UTC</i>\n<i>задач нет</i>')
  })
  test('no freshness → legacy header', () => {
    expect(renderTodoList(todos, 5).startsWith('<b>Задачи</b>\n')).toBe(true)
  })
})
