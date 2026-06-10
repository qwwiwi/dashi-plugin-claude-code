// The ONLY hard limit on multichat attachments: secret material must never be
// sendable to a (public) chat, while ordinary files are allowed (warchief
// 2026-06-10). Guards the file-exfil surface. The denylist was widened after
// Codex + the automated commit review flagged missing credential stores.
import { describe, expect, test } from 'bun:test'
import { isSecretAttachmentPath } from '../../src/router/multichat-router.js'

describe('isSecretAttachmentPath', () => {
  test('BLOCKS secret material (path-based)', () => {
    for (const p of [
      '/home/openclaw/.claude-lab/thrall/secrets/socialdata.env',
      '/home/openclaw/app/.env',
      '/home/openclaw/app/.env.production',
      '/home/x/prod.env',
      '/home/x/.envrc',
      '/etc/ssl/private/server.key',
      '/home/x/cert.pem',
      '/home/x/private.key.bak',
      '/home/x/keystore.p12',
      '/home/x/.ssh/id_rsa',
      '/home/x/id_ed25519',
      '/home/x/id_rsa.bak',
      '/home/x/.npmrc',
      '/home/x/.netrc',
      '/home/x/.git-credentials',
      '/home/x/.aws/credentials',
      '/home/x/.kube/config',
      '/home/x/.docker/config.json',
      '/home/x/.config/gcloud/application_default_credentials.json',
      '/home/x/.config/gh/hosts.yml',
      '/home/x/.gnupg/secring.gpg',
      '/home/x/.codex/auth.json',
      '/home/x/.claude.json',
      '/home/x/.credentials.json',
      '/home/x/.cargo/credentials.toml',
      '/home/openclaw/.secrets/firebase/sa-thrall.json',
      '/var/run/sa-gbrain.json',
      '/home/x/service-account.json',
      '/home/x/firebase-adminsdk-abc.json',
      '/home/x/credentials.json',
      '/home/x/auth.yaml',
      '/home/x/secret.json',
      '/tmp/api.secret',
    ]) {
      expect(isSecretAttachmentPath(p)).toBe(true)
    }
  })

  test('ALLOWS ordinary files (any path, any common type)', () => {
    for (const p of [
      '/home/openclaw/.claude-lab/thrall/.claude/skills/present/present-gbrain.html',
      '/tmp/report.pdf',
      '/home/x/cover.png',
      '/home/x/cowork-1.txt',
      '/home/x/diagram.svg',
      '/home/x/data.json',
      '/home/x/lesson.md',
      '/home/x/token-economy-lesson.html',
    ]) {
      expect(isSecretAttachmentPath(p)).toBe(false)
    }
  })
})
