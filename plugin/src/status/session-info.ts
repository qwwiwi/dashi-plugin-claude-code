// SessionInfoStore — remembers the LATEST Claude Code session facts the plugin
// has observed from hook events, so /status (and later the context HUD) can
// read them without poking the host Claude process.
//
// Every Claude hook payload (PreToolUse / PostToolUse / Stop / UserPromptSubmit
// / SessionStart) carries `transcript_path` + `session_id`
// (ClaudeHookCommonShape). SessionStart additionally carries `model`. We record
// whatever a hook gives us, MERGING so a later event that lacks `model` (every
// non-SessionStart hook) does not wipe the model captured at session start.
//
// Multichat: keyed by chatId when the hook payload carries one; a single-session
// deployment (no chatId) falls back to a single `latest` slot. `get(chatId)`
// returns the per-chat record when present, else the most recent record seen —
// so a single-DM caller that never passes a chatId still gets live data.
//
// Pure in-memory: no I/O, so it never throws and needs no teardown. A restart
// simply re-learns the facts from the next hook event.

export interface SessionInfo {
  transcriptPath?: string
  sessionId?: string
  model?: string
}

export class SessionInfoStore {
  private readonly byChat = new Map<string, SessionInfo>()
  private latest: SessionInfo = {}

  // Record the facts from one hook event. Only NON-EMPTY fields overwrite the
  // previous value, so a hook that omits `model` keeps the last known model.
  // A blank/undefined chatId updates only the shared `latest` slot.
  record(chatId: string | undefined, info: SessionInfo): void {
    const key = chatId !== undefined && chatId.length > 0 ? chatId : undefined
    const base = key !== undefined ? this.byChat.get(key) ?? {} : this.latest
    const next: SessionInfo = { ...base }
    if (info.transcriptPath) next.transcriptPath = info.transcriptPath
    if (info.sessionId) next.sessionId = info.sessionId
    if (info.model) next.model = info.model
    if (key !== undefined) this.byChat.set(key, next)
    // `latest` always tracks the most recent event so a single-session caller
    // (no chatId passed to get()) still sees the freshest transcript/model.
    this.latest = next
  }

  // Read the current facts.
  //
  // FIX-10 (both reviews): a chatId argument means "the facts FOR THIS CHAT".
  // Returning the global `latest` when a known chatId has no record leaked one
  // chat's session into another — e.g. /status in the DM could render a GROUP
  // session's context %/transcript. So a chatId with no record returns `{}`
  // (all fields absent), NOT `latest`. Only the no-arg `get()` — the legacy
  // single-DM caller that never keys by chat — falls back to `latest`.
  get(chatId?: string): SessionInfo {
    if (chatId !== undefined && chatId.length > 0) {
      return this.byChat.get(chatId) ?? {}
    }
    return this.latest
  }
}
