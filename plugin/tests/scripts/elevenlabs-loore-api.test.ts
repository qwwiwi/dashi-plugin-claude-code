import { describe, expect, test } from 'bun:test'
import {
  ELEVENLABS_ORIGIN,
  parseCliArgs,
  redactSecret,
  validateEndpoint,
} from '../../scripts/elevenlabs-loore-api'

describe('ElevenLabs Loore API bridge', () => {
  test('accepts a GET to the fixed ElevenLabs v1 origin', () => {
    const cfg = parseCliArgs(['--method', 'GET', '--endpoint', '/v1/voices', '--output', '/tmp/voices.json'])
    expect(cfg.method).toBe('GET')
    expect(cfg.endpointUrl.toString()).toBe(`${ELEVENLABS_ORIGIN}/v1/voices`)
    expect(cfg.outputPath).toBe('/tmp/voices.json')
  })

  test('accepts a POST body without accepting a key path override', () => {
    const cfg = parseCliArgs([
      '--method', 'POST',
      '--endpoint', '/v1/text-to-speech/voice-id',
      '--body-file', '/tmp/request.json',
      '--content-type', 'application/json',
      '--output', '/tmp/audio.mp3',
    ])
    expect(cfg.bodyPath).toBe('/tmp/request.json')
    expect(cfg.contentType).toBe('application/json')
    expect(() => parseCliArgs(['--key-file', '/tmp/other.key'])).toThrow('unknown argument')
  })

  test('rejects external origins, traversal, fragments and malformed v1 paths', () => {
    for (const endpoint of ['https://evil.invalid/v1/x', '//evil.invalid/v1/x', '/v1/../x', '/v1//x', '/v2/voices', '/v1/x#fragment']) {
      expect(() => validateEndpoint(endpoint)).toThrow()
    }
  })

  test('rejects using the Thrall secret tree as request body or output', () => {
    const secret = '/home/openclaw/.claude-lab/thrall/secrets/elevenlabs-loore.key'
    const base = ['--method', 'POST', '--endpoint', '/v1/dubbing', '--content-type', 'application/json']
    expect(() => parseCliArgs([...base, '--body-file', secret, '--output', '/tmp/out.json'])).toThrow('secret tree')
    expect(() => parseCliArgs([...base, '--body-file', '/tmp/body.json', '--output', secret])).toThrow('secret tree')
  })

  test('rejects header injection and GET bodies', () => {
    expect(() => parseCliArgs(['--method', 'GET', '--endpoint', '/v1/voices', '--accept', 'x\r\ny: z', '--output', '/tmp/x'])).toThrow('header')
    expect(() => parseCliArgs(['--method', 'GET', '--endpoint', '/v1/voices', '--body-file', '/tmp/x', '--output', '/tmp/y'])).toThrow('GET')
  })

  test('redacts the key from upstream error text', () => {
    expect(redactSecret('upstream repeated abc123 and abc123', 'abc123')).toBe('upstream repeated [REDACTED] and [REDACTED]')
  })
})
