// Runs the REAL script of templates/status.html against a minimal fake DOM.
// Pins what the static tests cannot: bad input never throws or blanks the card,
// the chatDataChanged callback re-renders, and an opened job shows its step once.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createContext, runInContext } from 'vm'

const TEMPLATE = readFileSync(join(import.meta.dir, '..', '..', 'templates', 'status.html'), 'utf8')

type Listener = () => void

class FakeText {
  constructor(readonly text: string) {}
}

class FakeElement {
  className = ''
  style: Record<string, string> = {}
  readonly children: Array<FakeElement | FakeText> = []
  readonly listeners = new Map<string, Listener[]>()
  constructor(readonly tag: string) {}

  append(...items: Array<FakeElement | string | number>): void {
    for (const item of items) this.children.push(typeof item === 'object' ? item : new FakeText(String(item)))
  }

  get firstChild(): FakeElement | FakeText | null {
    return this.children[0] ?? null
  }

  removeChild(child: FakeElement | FakeText): void {
    const i = this.children.indexOf(child)
    if (i >= 0) this.children.splice(i, 1)
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }

  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn()
  }

  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.text : c.textContent)).join(' ')
  }

  find(pred: (e: FakeElement) => boolean): FakeElement[] {
    const out: FakeElement[] = []
    for (const c of this.children) {
      if (c instanceof FakeElement) {
        if (pred(c)) out.push(c)
        out.push(...c.find(pred))
      }
    }
    return out
  }
}

interface Widget {
  chatData: string | null
  onEvent(name: string, cb: () => void): void
}

interface Harness {
  root: FakeElement
  widget: Widget
  fire(): void
  text(): string
  count(needle: string): number
  jobs(): FakeElement[]
  events: string[]
}

function mount(chatData: string | null, opts: { bridge?: boolean } = {}): Harness {
  const root = new FakeElement('div')
  const events: string[] = []
  const handlers: Array<() => void> = []
  const widget: Widget = {
    chatData,
    onEvent(name, cb) {
      events.push(name)
      if (name === 'chatDataChanged') handlers.push(cb)
    },
  }
  const document = {
    getElementById: () => root,
    createElement: (tag: string) => new FakeElement(tag),
  }
  const sandbox: Record<string, unknown> = { document }
  if (opts.bridge !== false) sandbox.TelegramWidget = widget
  const script = /<script>([\s\S]*?)<\/script>/.exec(TEMPLATE)
  if (!script) throw new Error('template has no script')
  runInContext(script[1] as string, createContext(sandbox))
  const text = (): string => root.textContent
  return {
    root,
    widget,
    events,
    // Re-run the registered chatDataChanged callbacks, like an edit would.
    fire: () => {
      for (const cb of handlers) cb()
    },
    text,
    count: (needle) => text().split(needle).length - 1,
    jobs: () => root.find((e) => e.className.startsWith('job ')),
  }
}

const VALID = JSON.stringify({
  m: [['Этап', [['Сборка', 40]]]],
  j: [['Задача', 30, 'r', { m: 'opus', t: 12, s: 'Шаг проверки', r: 'Итог первый' }], ['Вторая', 0, 'q']],
  l: 'подвал',
})

describe('status.html against a fake DOM: bad state', () => {
  const bad: Array<[string, string | null]> = [
    ['an empty object', '{}'],
    ['invalid JSON', 'this is {not json'],
    ['wrong types and null tuples', '{"m":{},"j":[null,5]}'],
    ['null chat data (value removed)', null],
    ['an empty string', ''],
    ['a JSON array', '[1,2]'],
    ['a JSON number', '42'],
    ['groups of the wrong shape', '{"m":[null,5,[1,2]],"j":"x"}'],
  ]
  for (const [name, data] of bad) {
    test(`${name}: renders without throwing and the card is not blank`, () => {
      const h = mount(data)
      expect(h.root.children.length).toBeGreaterThan(0)
      expect(h.text().trim().length).toBeGreaterThan(0)
    })
  }

  test('empty and invalid inputs show the visible empty state', () => {
    for (const data of ['{}', 'not json', '{"m":{},"j":[null,5]}']) {
      expect(mount(data).text()).toContain('нет данных')
    }
  })

  test('valid data after bad data renders normally (and the empty state goes away)', () => {
    const h = mount('not json')
    expect(h.text()).toContain('нет данных')
    h.widget.chatData = VALID
    h.fire()
    expect(h.text()).toContain('Сборка')
    expect(h.text()).toContain('Задача')
    expect(h.text()).not.toContain('нет данных')
  })

  test('bad data after valid data does not throw and replaces the card with the empty state', () => {
    const h = mount(VALID)
    h.widget.chatData = '{"m":{},"j":[null,5]}'
    expect(() => h.fire()).not.toThrow()
    expect(h.text()).toContain('нет данных')
  })
})

describe('status.html against a fake DOM: events', () => {
  test('subscribes to chatDataChanged and re-renders in the callback', () => {
    const h = mount(VALID)
    expect(h.events).toContain('chatDataChanged')
    expect(h.text()).toContain('Задача')
    h.widget.chatData = JSON.stringify({ m: [['Новая группа', [['Другая строка', 77]]]], l: 'новый подвал' })
    h.fire()
    expect(h.text()).toContain('Новая группа')
    expect(h.text()).toContain('77%')
    expect(h.text()).toContain('новый подвал')
    expect(h.text()).not.toContain('Задача')
  })

  test('without the TelegramWidget bridge the card shows the built-in demo data', () => {
    const h = mount(null, { bridge: false })
    expect(h.text()).toContain('Подготовка')
  })
})

describe('status.html against a fake DOM: an opened job', () => {
  test('before any tap the running job step is visible exactly once', () => {
    const h = mount(VALID)
    expect(h.count('Шаг проверки')).toBe(1)
  })

  test('with a job opened its step text appears exactly once', () => {
    const h = mount(VALID)
    h.jobs()[0]!.click()
    expect(h.count('Шаг проверки')).toBe(1)
    expect(h.text()).toContain('Шаг: Шаг проверки')
    expect(h.text()).toContain('Модель: opus')
    expect(h.text()).toContain('Минут: 12')
    expect(h.text()).toContain('Итог: Итог первый')
  })

  test('opening collapses the groups; a second tap on the same job closes it again', () => {
    const h = mount(VALID)
    expect(h.text()).toContain('Сборка')
    h.jobs()[0]!.click()
    expect(h.text()).not.toContain('Сборка')
    h.jobs()[0]!.click()
    expect(h.text()).toContain('Сборка')
    expect(h.count('Шаг проверки')).toBe(1)
  })

  test('new chat data closes an opened job', () => {
    const h = mount(VALID)
    h.jobs()[0]!.click()
    h.fire()
    expect(h.text()).toContain('Сборка')
    expect(h.text()).not.toContain('Модель:')
  })

  test('a job without details shows the empty detail text instead of throwing', () => {
    const h = mount(VALID)
    h.jobs()[1]!.click()
    expect(h.text()).toContain('нет данных')
  })
})
