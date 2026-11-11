// Read dotenv/shell literals without evaluating their contents. A hash starts a
// comment only after whitespace outside quotes; hashes inside quotes are data.
export function parseEnvValue(raw: string): string {
  const quoted = raw.trim().match(/^'([^']*)'(?:\s+#.*)?$/) ?? raw.trim().match(/^"([^"]*)"(?:\s+#.*)?$/)
  return quoted ? quoted[1]! : raw.replace(/\s+#.*$/, '').trim()
}

/** Strict literal assignments used by the installer and its shell launchers. */
export function parseLiteralEnv(text: string, uppercaseOnly = false): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || (uppercaseOnly && !/^[A-Z_][A-Z0-9_]*$/.test(match[1]!))) throw new Error('Existing channel.env has unsupported syntax; preserve and review it manually')
    const key = match[1]!
    if (values.has(key)) throw new Error(`Existing channel.env has duplicate ${key}`)
    const raw = match[2]!.trim()
    const quoted = /^'([^']*)'(?:\s+#.*)?$/.test(raw) || /^"([^"\\$`]*)"(?:\s+#.*)?$/.test(raw)
    const value = parseEnvValue(match[2]!)
    if (!quoted && !/^[A-Za-z0-9_./:@,+%#=-]*$/.test(value)) throw new Error(`Existing channel.env has unsupported ${key} syntax`)
    values.set(key, value)
  }
  return values
}
