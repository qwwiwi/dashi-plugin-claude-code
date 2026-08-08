// Обход запрета на чтение секретов через поисковые инструменты.
//
// Сообщено внешним исследователем 2026-08-03, воспроизведено по коду 2026-08-08.
// Механика: `extractPath` брал только `file_path`/`notebook_path`, а у Grep/Glob/LS
// путь лежит в `path`. Поэтому политика видела вызов БЕЗ пути, проверка секретных
// путей не выполнялась, а сами инструменты помечены read-only → tier=allow.
// Итог: `Grep(pattern:"TOKEN", path:"~/.secrets")` возвращал строки с секретами
// там, где `Read` того же файла жёстко запрещён. Бьёт по всем, кто работает
// в режиме без подтверждений.

import { describe, expect, it } from 'bun:test'
import { classifyToolCall } from '../src/security/permission-policy.js'

const policy = { version: 1, default_tier: 'confirm' as const, rules: [] }

const SECRET_TARGETS = [
  '/home/user/.env',
  '~/.ssh/id_ed25519',
  '~/.aws/credentials',
  '/home/user/.secrets/tokens.json',
  '/etc/ssl/private/server.key',
]

describe('чтение секретов через поиск', () => {
  for (const target of SECRET_TARGETS) {
    it(`Grep по ${target} запрещён так же, как Read`, () => {
      const grep = classifyToolCall({
        toolName: 'Grep',
        toolInput: { pattern: 'TOKEN|KEY|SECRET', path: target },
        policy,
      })
      const read = classifyToolCall({
        toolName: 'Read',
        toolInput: { file_path: target },
        policy,
      })
      expect(read.tier).toBe('deny')
      expect(grep.tier).toBe('deny')
    })
  }

  it('Glob по каталогу секретов запрещён', () => {
    const verdict = classifyToolCall({
      toolName: 'Glob',
      toolInput: { pattern: '**/*', path: '~/.secrets' },
      policy,
    })
    expect(verdict.tier).toBe('deny')
  })

  it('LS каталога с ключами запрещён', () => {
    const verdict = classifyToolCall({
      toolName: 'LS',
      toolInput: { path: '~/.ssh' },
      policy,
    })
    expect(verdict.tier).toBe('deny')
  })

  it('обычный Grep по коду по-прежнему разрешён', () => {
    const verdict = classifyToolCall({
      toolName: 'Grep',
      toolInput: { pattern: 'function', path: 'src/security' },
      policy,
    })
    expect(verdict.tier).toBe('allow')
  })

  it('Grep без пути не ломается', () => {
    const verdict = classifyToolCall({
      toolName: 'Grep',
      toolInput: { pattern: 'TODO' },
      policy,
    })
    expect(verdict.tier).toBe('allow')
  })
})
