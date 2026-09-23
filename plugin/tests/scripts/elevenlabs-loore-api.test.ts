import { describe, expect, test } from 'bun:test'
import {
  ELEVENLABS_ORIGIN,
  assertBodyDoesNotContainSecret,
  filterSubscriptionResponse,
  parseCliArgs,
  readLimitedBytes,
  redactSecret,
  validateEndpoint,
} from '../../scripts/elevenlabs-loore-api'

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

describe('ElevenLabs Loore API bridge', () => {
  test('accepts a GET to the fixed ElevenLabs v1 origin', () => {
    const cfg = parseCliArgs(['--method', 'GET', '--endpoint', '/v1/voices'])
    expect(cfg.method).toBe('GET')
    expect(cfg.endpointUrl.toString()).toBe(`${ELEVENLABS_ORIGIN}/v1/voices`)
    expect(cfg.bodyFromStdin).toBe(false)
  })

  test('accepts POST stdin without accepting file, output, or key overrides', () => {
    const cfg = parseCliArgs([
      '--method', 'POST',
      '--endpoint', '/v1/text-to-speech/voice-id',
      '--body-stdin',
      '--content-type', 'application/json',
    ])
    expect(cfg.bodyFromStdin).toBe(true)
    expect(cfg.contentType).toBe('application/json')
    for (const args of [
      ['--key-file', '/tmp/other.key'],
      ['--body-file', '/tmp/request.json'],
      ['--output', '/tmp/response.json'],
    ]) {
      expect(() => parseCliArgs(args)).toThrow('unknown argument')
    }
  })

  test('allows only method-scoped Loore dubbing capabilities, not account APIs', () => {
    for (const endpoint of ['/v1/voices', '/v1/voices/voice-id', '/v1/models', '/v1/user/subscription', '/v1/dubbing/dubbing-id', '/v1/dubbing/dubbing-id/audio/ru']) {
      expect(validateEndpoint(endpoint, 'GET').origin).toBe(ELEVENLABS_ORIGIN)
    }
    for (const endpoint of ['/v1/text-to-speech/voice-id', '/v1/text-to-speech/voice-id/stream', '/v1/speech-to-speech/voice-id', '/v1/dubbing']) {
      expect(validateEndpoint(endpoint, 'POST').origin).toBe(ELEVENLABS_ORIGIN)
    }
    for (const [endpoint, method] of [
      ['/v1/voices/add', 'POST'],
      ['/v1/text-to-speech/voice-id', 'GET'],
      ['/v1/user', 'GET'],
      ['/v1/user/subscription', 'POST'],
      ['/v1/user/subscription/extra', 'GET'],
      ['/v1/user/api-keys', 'GET'],
      ['/v1/service-accounts/api-keys', 'POST'],
      ['/v1/workspace/invites', 'POST'],
      ['/v1/projects', 'GET'],
    ] as const) {
      expect(() => validateEndpoint(endpoint, method)).toThrow('not allowlisted')
    }
  })

  test('rejects external origins, traversal, fragments and malformed v1 paths', () => {
    for (const endpoint of ['https://evil.invalid/v1/x', '//evil.invalid/v1/x', '/v1/../x', '/v1//x', '/v2/voices', '/v1/x#fragment']) {
      expect(() => validateEndpoint(endpoint)).toThrow()
    }
  })

  test('rejects header injection and invalid stdin combinations', () => {
    expect(() => parseCliArgs(['--method', 'GET', '--endpoint', '/v1/voices', '--accept', 'x\r\ny: z'])).toThrow('header')
    expect(() => parseCliArgs(['--method', 'GET', '--endpoint', '/v1/voices', '--body-stdin'])).toThrow('GET')
    expect(() => parseCliArgs(['--method', 'POST', '--endpoint', '/v1/dubbing', '--body-stdin'])).toThrow('--content-type')
    expect(() => parseCliArgs(['--method', 'POST', '--endpoint', '/v1/dubbing', '--content-type', 'application/json'])).toThrow('--body-stdin')
  })

  test('enforces byte limits while consuming a stream', async () => {
    const ok = await readLimitedBytes(streamOf(new Uint8Array([1, 2]), new Uint8Array([3])), 3, 'test')
    expect([...ok]).toEqual([1, 2, 3])
    await expect(readLimitedBytes(streamOf(new Uint8Array([1, 2]), new Uint8Array([3, 4])), 3, 'test')).rejects.toThrow('limit')
  })

  test('rejects request bytes containing the API key and redacts errors', () => {
    expect(() => assertBodyDoesNotContainSecret(new TextEncoder().encode('prefix-abc123-suffix'), 'abc123')).toThrow('credential')
    expect(redactSecret('upstream repeated abc123 and abc123', 'abc123')).toBe('upstream repeated [REDACTED] and [REDACTED]')
  })
})


describe('subscription credit balance', () => {
  test('must be requested verbatim: no query, no encoding, no trailing slash', () => {
    expect(validateEndpoint('/v1/user/subscription', 'GET').pathname).toBe('/v1/user/subscription')
    for (const endpoint of [
      '/v1/user/subscription?x=1',
      '/v1/user/%73ubscription',
      '/v1/user%2Fsubscription',
      '/v1/user/subscription/',
      '/v1/user/subscription%2Fextra',
    ]) {
      expect(() => validateEndpoint(endpoint, 'GET')).toThrow()
    }
  })

  test('only the numeric credit fields reach the agent', () => {
    const upstream = {
      tier: 'creator',
      character_count: 1200,
      character_limit: 100000,
      next_character_count_reset_unix: 1790000000,
      currency: 'usd',
      open_invoices: [{ amount_due_cents: 2200 }],
      next_invoice: { amount_due_cents: 2200, tax_cents: 0 },
      character_limit_text: 'not a number',
    }
    const out = JSON.parse(
      new TextDecoder().decode(filterSubscriptionResponse(new TextEncoder().encode(JSON.stringify(upstream)))),
    )
    expect(out).toEqual({ character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1790000000 })
  })

  test('non-JSON or non-object responses are refused', () => {
    expect(() => filterSubscriptionResponse(new TextEncoder().encode('not json'))).toThrow()
    expect(() => filterSubscriptionResponse(new TextEncoder().encode('[1,2]'))).toThrow()
  })
})
