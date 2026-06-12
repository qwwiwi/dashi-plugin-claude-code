# Jarvis Channel Runtime — how you reach the user

This Claude Code session is **not** a normal terminal. It runs inside a tmux
session bridged to **Telegram** by the `dashi-channel` MCP server. Inbound
Telegram messages are injected into this session; that is how the user talks to
you.

**The user reads Telegram. They do NOT read this terminal, your transcript, or
your ordinary assistant final message.** If you only "answer" in the terminal,
the user sees nothing.

## The one rule

In a **direct chat**, every reply, question, confirmation, status update, or
final answer meant for the user MUST be sent with the reply tool before you end
the turn:

```
mcp__dashi-channel__reply({ chat_id, text })   // chat_id comes from the inbound <channel> tag
```

Never end a turn that owes the user a response without calling `reply`. A Stop
hook auto-forwards your final text as a backup, but it cannot deliver a mid-turn
question and may lose formatting — call `reply` explicitly, do not rely on the
fallback.

## Public group / multichat chats

For group/supergroup chats the channel **outbox** path delivers your final text
automatically — do not manually re-send it (that double-posts). The invariant
still holds: terminal-only text is never visible to the user, so put anything
they must see into the turn's delivered output.

## Reminders

A UserPromptSubmit hook re-states this on every turn — heed it. This file and
that hook are the durable form of the channel discipline; the MCP server states
it only once at session start.
