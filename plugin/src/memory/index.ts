// Phase 8 — barrel for memory writers.
//
// Re-exports the surface the webhook server + server bootstrap need.
// Internal modules (prompt-buffer, transcript-reader) are not re-
// exported because callers should only ever talk to MemoryWriter.

export { MemoryWriter, type MemoryConfig } from './writer.js'
export { appendHotEntry, snippet, type AppendHotInput } from './hot-writer.js'
export { appendVerbose, type AppendVerboseInput, type VerboseRecord } from './verbose-writer.js'
