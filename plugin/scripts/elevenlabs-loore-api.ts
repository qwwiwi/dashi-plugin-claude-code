#!/usr/bin/env bun
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

export const ELEVENLABS_ORIGIN = 'https://api.elevenlabs.io'
const ELEVENLABS_KEY_PATH = '/etc/loore-elevenlabs/key'
const MAX_REQUEST_BYTES = 100 * 1024 * 1024
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024
const MAX_ERROR_BYTES = 1024 * 1024
const MAX_KEY_BYTES = 4096
const ALLOWED_GET_ENDPOINT_RES: readonly RegExp[] = [
  /^\/v1\/voices(?:\/[A-Za-z0-9_-]+)?$/,
  /^\/v1\/models$/,
  /^\/v1\/dubbing\/[A-Za-z0-9_-]+(?:\/audio\/[A-Za-z0-9_-]+)?$/,
]
const ALLOWED_POST_ENDPOINT_RES: readonly RegExp[] = [
  /^\/v1\/text-to-speech\/[A-Za-z0-9_-]+(?:\/stream)?$/,
  /^\/v1\/speech-to-speech\/[A-Za-z0-9_-]+(?:\/stream)?$/,
  /^\/v1\/dubbing$/,
]

export interface BridgeConfig {
  method: 'GET' | 'POST'
  endpointUrl: URL
  bodyFromStdin: boolean
  contentType: string | undefined
  accept: string
}

const USAGE = `Usage:
  /usr/local/bin/loore-elevenlabs-api \\
    --method GET|POST \\
    --endpoint /v1/... \\
    [--body-stdin --content-type application/json] \\
    [--accept application/json] \\
    > /path/to/response

The API key path and destination origin are fixed and cannot be overridden.
POST request bodies are read only from stdin; responses are written only to stdout.`

function requireValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

function assertHeaderValue(name: string, value: string): void {
  if (value.length === 0 || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new Error(`invalid ${name} header value`)
  }
}

export function validateEndpoint(raw: string, method: 'GET' | 'POST' = 'GET'): URL {
  if (!raw.startsWith('/v1/') || raw.startsWith('//') || raw.includes('\\') || raw.includes('#')) {
    throw new Error('endpoint must be an absolute /v1/... path on ElevenLabs')
  }
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(raw.split('?', 1)[0] ?? '')
  } catch {
    throw new Error('endpoint contains invalid percent encoding')
  }
  if (decodedPath.includes('..') || decodedPath.includes('//')) {
    throw new Error('endpoint traversal or duplicate slash is forbidden')
  }
  const url = new URL(raw, ELEVENLABS_ORIGIN)
  if (url.origin !== ELEVENLABS_ORIGIN || !url.pathname.startsWith('/v1/')) {
    throw new Error('endpoint escaped the fixed ElevenLabs origin')
  }
  const allowedEndpointRes = method === 'GET' ? ALLOWED_GET_ENDPOINT_RES : ALLOWED_POST_ENDPOINT_RES
  if (!allowedEndpointRes.some((re) => re.test(decodedPath))) {
    throw new Error('endpoint is not allowlisted for Loore dubbing')
  }
  return url
}

export function parseCliArgs(argv: readonly string[]): BridgeConfig {
  let method: 'GET' | 'POST' | undefined
  let endpoint: string | undefined
  let bodyFromStdin = false
  let contentType: string | undefined
  let accept = 'application/json, audio/*;q=0.9, */*;q=0.1'

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--method') {
      const value = requireValue(argv, i, arg)
      if (value !== 'GET' && value !== 'POST') throw new Error('--method must be GET or POST')
      method = value
      i += 1
    } else if (arg === '--endpoint') {
      endpoint = requireValue(argv, i, arg)
      i += 1
    } else if (arg === '--body-stdin') {
      bodyFromStdin = true
    } else if (arg === '--content-type') {
      contentType = requireValue(argv, i, arg)
      i += 1
    } else if (arg === '--accept') {
      accept = requireValue(argv, i, arg)
      i += 1
    } else {
      throw new Error(`unknown argument: ${arg ?? '<missing>'}`)
    }
  }

  if (method === undefined) throw new Error('--method is required')
  if (endpoint === undefined) throw new Error('--endpoint is required')
  if (method === 'GET' && bodyFromStdin) throw new Error('GET requests cannot include --body-stdin')
  if (method === 'GET' && contentType !== undefined) throw new Error('GET requests cannot include --content-type')
  if (method === 'POST' && !bodyFromStdin) throw new Error('POST requests require --body-stdin')
  if (bodyFromStdin && contentType === undefined) throw new Error('--content-type is required with --body-stdin')
  assertHeaderValue('Accept', accept)
  if (contentType !== undefined) assertHeaderValue('Content-Type', contentType)

  return {
    method,
    endpointUrl: validateEndpoint(endpoint, method),
    bodyFromStdin,
    contentType,
    accept,
  }
}

export async function readLimitedBytes(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  label: string,
): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array()
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel(`${label} exceeds byte limit`)
        throw new Error(`${label} exceeds byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > haystack.byteLength) return false
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i += 1) {
    for (let j = 0; j < needle.byteLength; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

export function assertBodyDoesNotContainSecret(body: Uint8Array, secret: string): void {
  if (containsBytes(body, new TextEncoder().encode(secret))) {
    throw new Error('request body contains the ElevenLabs credential')
  }
}

function assertResponseDoesNotContainSecret(body: Uint8Array, secret: string): void {
  if (containsBytes(body, new TextEncoder().encode(secret))) {
    throw new Error('upstream response contained the ElevenLabs credential and was suppressed')
  }
}

export function redactSecret(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join('[REDACTED]')
}

async function writeStdout(payload: Uint8Array): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    process.stdout.write(payload, (error: Error | null | undefined) => {
      if (error) rejectPromise(error)
      else resolvePromise()
    })
  })
}

async function run(config: BridgeConfig): Promise<void> {
  const brokerUid = process.getuid?.()
  if (brokerUid === undefined) throw new Error('broker uid is unavailable')
  const keyHandle = await open(ELEVENLABS_KEY_PATH, constants.O_RDONLY | constants.O_NOFOLLOW)
  let key: string
  try {
    const keyInfo = await keyHandle.stat()
    if (!keyInfo.isFile() || keyInfo.uid !== brokerUid || (keyInfo.mode & 0o777) !== 0o400) {
      throw new Error('ElevenLabs credential metadata is unsafe')
    }
    if (keyInfo.size === 0 || keyInfo.size > MAX_KEY_BYTES) throw new Error('ElevenLabs credential file size is invalid')
    key = (await keyHandle.readFile({ encoding: 'utf8' })).trim()
  } finally {
    await keyHandle.close()
  }
  if (key.length === 0 || /[\r\n\0]/.test(key)) throw new Error('ElevenLabs credential file is malformed')

  const headers = new Headers({ Accept: config.accept, 'xi-api-key': key })
  if (config.contentType !== undefined) headers.set('Content-Type', config.contentType)
  const init: RequestInit = {
    method: config.method,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  }
  if (config.bodyFromStdin) {
    const requestBody = await readLimitedBytes(Bun.stdin.stream(), MAX_REQUEST_BYTES, 'request body')
    assertBodyDoesNotContainSecret(requestBody, key)
    const requestBuffer = new ArrayBuffer(requestBody.byteLength)
    new Uint8Array(requestBuffer).set(requestBody)
    init.body = requestBuffer
  }

  const response = await fetch(config.endpointUrl, init)
  const contentLength = Number(response.headers.get('content-length'))
  const responseLimit = response.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BYTES
  if (Number.isFinite(contentLength) && contentLength > responseLimit) {
    await response.body?.cancel('response exceeds byte limit')
    throw new Error('ElevenLabs response exceeds byte limit')
  }
  const payload = await readLimitedBytes(response.body, responseLimit, 'ElevenLabs response')
  assertResponseDoesNotContainSecret(payload, key)
  if (!response.ok) {
    const excerpt = new TextDecoder().decode(payload.slice(0, 4096))
    throw new Error(`ElevenLabs HTTP ${response.status}: ${redactSecret(excerpt, key)}`)
  }
  await writeStdout(payload)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  await run(parseCliArgs(argv))
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`elevenlabs-loore-api: ${message}\n`)
    process.exitCode = 1
  })
}
