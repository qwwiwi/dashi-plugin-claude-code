#!/usr/bin/env bun
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

export const ELEVENLABS_ORIGIN = 'https://api.elevenlabs.io'
export const ELEVENLABS_KEY_PATH = '/home/openclaw/.claude-lab/thrall/secrets/elevenlabs-loore.key'
const SECRET_DIR = dirname(ELEVENLABS_KEY_PATH)
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024

export interface BridgeConfig {
  method: 'GET' | 'POST'
  endpointUrl: URL
  bodyPath: string | undefined
  contentType: string | undefined
  accept: string
  outputPath: string
}

const USAGE = `Usage:
  bun scripts/elevenlabs-loore-api.ts \\
    --method GET|POST \\
    --endpoint /v1/... \\
    [--body-file /path/to/request-body] \\
    [--content-type application/json] \\
    [--accept application/json] \\
    --output /path/to/response

The API key path and destination origin are fixed and cannot be overridden.`

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

function isInSecretTree(path: string): boolean {
  const absolute = resolve(path)
  return absolute === SECRET_DIR || absolute.startsWith(`${SECRET_DIR}${sep}`)
}

export function validateEndpoint(raw: string): URL {
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
  return url
}

export function parseCliArgs(argv: readonly string[]): BridgeConfig {
  let method: 'GET' | 'POST' | undefined
  let endpoint: string | undefined
  let bodyPath: string | undefined
  let contentType: string | undefined
  let accept = 'application/json, audio/*;q=0.9, */*;q=0.1'
  let outputPath: string | undefined

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
    } else if (arg === '--body-file') {
      bodyPath = resolve(requireValue(argv, i, arg))
      i += 1
    } else if (arg === '--content-type') {
      contentType = requireValue(argv, i, arg)
      i += 1
    } else if (arg === '--accept') {
      accept = requireValue(argv, i, arg)
      i += 1
    } else if (arg === '--output') {
      outputPath = resolve(requireValue(argv, i, arg))
      i += 1
    } else {
      throw new Error(`unknown argument: ${arg ?? '<missing>'}`)
    }
  }

  if (method === undefined) throw new Error('--method is required')
  if (endpoint === undefined) throw new Error('--endpoint is required')
  if (outputPath === undefined) throw new Error('--output is required')
  if (method === 'GET' && bodyPath !== undefined) throw new Error('GET requests cannot include --body-file')
  if (bodyPath !== undefined && contentType === undefined) throw new Error('--content-type is required with --body-file')
  if (bodyPath === undefined && contentType !== undefined) throw new Error('--content-type requires --body-file')
  if ((bodyPath !== undefined && isInSecretTree(bodyPath)) || isInSecretTree(outputPath)) {
    throw new Error('the Thrall secret tree cannot be used as request body or output')
  }
  assertHeaderValue('Accept', accept)
  if (contentType !== undefined) assertHeaderValue('Content-Type', contentType)

  return {
    method,
    endpointUrl: validateEndpoint(endpoint),
    bodyPath,
    contentType,
    accept,
    outputPath,
  }
}

export function redactSecret(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join('[REDACTED]')
}

async function run(config: BridgeConfig): Promise<void> {
  const keyFile = Bun.file(ELEVENLABS_KEY_PATH)
  if (!(await keyFile.exists())) throw new Error('ElevenLabs credential file is unavailable')
  const key = (await keyFile.text()).trim()
  if (key.length === 0 || /[\r\n\0]/.test(key)) throw new Error('ElevenLabs credential file is malformed')

  const headers = new Headers({ Accept: config.accept, 'xi-api-key': key })
  if (config.contentType !== undefined) headers.set('Content-Type', config.contentType)
  const init: RequestInit = {
    method: config.method,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  }
  if (config.bodyPath !== undefined) {
    const bodyFile = Bun.file(config.bodyPath)
    if (!(await bodyFile.exists())) throw new Error('request body file is unavailable')
    init.body = bodyFile
  }

  const response = await fetch(config.endpointUrl, init)
  const payload = await response.arrayBuffer()
  if (payload.byteLength > MAX_RESPONSE_BYTES) throw new Error('ElevenLabs response exceeds 100 MiB safety cap')
  if (!response.ok) {
    const excerpt = new TextDecoder().decode(payload.slice(0, 4096))
    throw new Error(`ElevenLabs HTTP ${response.status}: ${redactSecret(excerpt, key)}`)
  }

  await mkdir(dirname(config.outputPath), { recursive: true })
  const temporary = `${config.outputPath}.tmp-${process.pid}-${Date.now()}`
  try {
    await Bun.write(temporary, payload)
    await rename(temporary, config.outputPath)
  } finally {
    await rm(temporary, { force: true })
  }
  process.stdout.write(`${JSON.stringify({ status: response.status, bytes: payload.byteLength, output: config.outputPath })}\n`)
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
