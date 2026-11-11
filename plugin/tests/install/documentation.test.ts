import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dir, '../../..')
const read = (file: string) => readFileSync(resolve(repo, file), 'utf8')

for (const file of ['README.md', 'README.ru.md', 'docs/03-installation-linux.md', 'docs/00-install-with-agent.md']) {
  test(`${file} explains system and user Linux services`, () => {
    const doc = read(file)
    expect(doc).toContain('/etc/systemd/system')
    expect(doc).toContain('~/.config/systemd/user')
    expect(doc).toContain('systemctl --user')
    expect(doc).toContain('sudo loginctl enable-linger')
    expect(doc).toContain('systemctl restart')
    expect(doc).toContain('systemctl --user restart')
  })
}

test('agent installation guide delegates startup prompts to the autonomous wrapper', () => {
  const doc = read('docs/00-install-with-agent.md')
  expect(doc).toContain('Wrapper сам принимает стартовые подтверждения Claude')
  expect(doc).not.toContain('и первые интерактивные подтверждения вручную')
  expect(doc).not.toContain('не посылай Enter или ответы на подтверждения за меня')
  expect(doc).not.toContain('На Linux --start только печатает sudo-команды')
})

test('Linux guide distinguishes no user bus fallback from successful installation', () => {
  const doc = read('docs/03-installation-linux.md')
  expect(doc).toContain('user bus')
  expect(doc).toContain('ненулевым кодом')
  expect(doc).toContain('не переживёт выход пользователя')
  expect(doc).not.toContain('после рестарта сервиса нужен человек с tmux')
})

test('manual Linux rendering records the selected installed unit path', () => {
  const doc = read('docs/03-installation-linux.md')
  expect(doc.includes('INSTALL_SERVICE_KIND=system')).toBe(true)
  expect(doc.includes('INSTALL_SERVICE_KIND=user')).toBe(true)
  expect(doc.includes('INSTALL_SERVICE_FILE="/etc/systemd/system/channel-myagent.service"')).toBe(true)
  expect(doc.includes('INSTALL_SERVICE_FILE="$HOME/.config/systemd/user/channel-myagent.service"')).toBe(true)
  expect(doc.includes('если в шаблоне задан `User=`, уберите его')).toBe(false)
})
