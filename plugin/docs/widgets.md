# Widgets: `send_widget` and `edit_widget_data`

Slice 1 of issue #151: the agent can send a Telegram widget (Bot API
`sendWidget`, released 2026-11-09) and later change its state
(`editMessageWidgetData`). Send and state update only: `allow_queries` is not
set, so taps and queries never reach the bot and no update handling changed.

Official docs: <https://core.telegram.org/bots/widgets> and the
[Bot API changelog](https://core.telegram.org/bots/api-changelog).

## Tools

| Tool | Arguments | Result |
|---|---|---|
| `send_widget` | `chat_id`, `html`, `caption` (required), `chat_data?`, `width?`, `height?` | `widget sent (id: N)` |
| `edit_widget_data` | `chat_id`, `message_id`, `chat_data` | `widget data updated (id: N)` |

Both go through the same chat allowlist gate as `reply` / `edit_message`
(legacy `allowed_chat_ids`, or `policy.allowlist.chats` in multichat mode).

## Limits (checked before the HTTP call)

| What | Limit | Refusal |
|---|---|---|
| `html` | at most 32768 bytes UTF-8 (bytes, not characters) | names the measured size |
| `html` after zlib level 9 | at most 4096 bytes | names the measured size |
| `html` | no NUL (`\u0000`) | refused |
| `chat_data` | at most 1024 bytes UTF-8 | names the measured size |
| `caption` | required, not empty, at most 1024 characters: it is the text clients without widget support show (always sent, even when the client supports widgets) | refused |
| `width`, `height` | positive integers when given. Telegram clamps the bubble: width 200-600, height 50-600 | refused |
| `chat_id` | positive (private chat). Group, supergroup and channel ids are negative and refused: in production widgets work only in a private chat with the bot | refused |

Every size rule is checked twice: early in the tool (precise message) and again
at the last layer before the HTTP call, on the payload that really goes out, so
a transformation in between can never push a widget over a limit.

Cyrillic and other multi-byte text counts by bytes (two bytes per Cyrillic
letter), so a label budget is half what the character count suggests.

`edit_widget_data` with an empty string for `chat_data` REMOVES the value:
`TelegramWidget.chatData` becomes `null`. The edit is idempotent: the plugin
retries a transient failure and treats `message is not modified` as success.

## What a widget can and cannot do (Bot API docs)

- Bubble size: width 200-600, height 50-600. Nothing inside scrolls.
- In production a widget works only in a private chat with the bot.
- No network: no `fetch`, no external fonts, images or scripts, no `<link>`.
- No form controls (`<input>`, `<button>`, `<textarea>`, `<form>`).
- The caption is always sent for old clients that cannot render widgets.

The widget code never changes after sending. Only `chat_data` does.
Widget-side API:

```
TelegramWidget.chatData                      // string, or null when there is no state
TelegramWidget.onEvent('chatDataChanged', cb) // cb runs after every edit_widget_data
TelegramWidget.offEvent('chatDataChanged', cb)
```

Read `TelegramWidget.chatData` once at start, then re-render inside the
`chatDataChanged` callback.

## Errors

A Bot API error (for example the server does not know the method, or the widget
is rejected) comes back to the agent as the tool error text, with secrets
redacted. The plugin does not retry a failed `send_widget`: a retry could show
two cards. The only retry in the path is the existing rate-limit layer, which
waits out a 429 `retry_after` a bounded number of times, as for every other
send.

The safe layer redacts secrets in the `caption`, as for any message. It never
rewrites `html` or `chat_data`: masking a string inside widget code would break
the script while the send looked fine. If the redactor would change either, the
call fails with `looks like a secret at offset N` (the matched value is not
echoed) and nothing is sent. The redactor flags any run of 24 or more letters,
digits or underscores, so keep identifiers in widget code shorter than that (the
bundled template does, and a test pins it).

## Ready template: `templates/status.html`

A compact light status card: groups of progress rows (label, cell bar,
percent), a jobs block (name, state, percent bar) and a footer line. No
network, no external assets, no inputs. About 7.5 KB raw and 3.3 KB after zlib
level 9 (a test measures both against the 32768 and 4096 byte limits).

Send it by passing the file text as `html` and the state as `chat_data`:

```
send_widget({ chat_id, html: <contents of templates/status.html>,
              caption: "Status: 3 groups, 5 jobs",
              chat_data: '{"m":[...],"j":[...],"l":"..."}' })
edit_widget_data({ chat_id, message_id, chat_data: '{"m":[...],"j":[...],"l":"..."}' })
```

### `chat_data` shape (short keys, one compact JSON string)

```
{
  "m": [ [ "<group title>", [ ["<row label>", <percent>], ... ] ], ... ],
  "j": [ ["<job name>", <percent>, "<state>", <details?>], ... ],
  "l": "<footer line>"
}
```

- `m`: groups, each `[title, rows]`, each row `[label, percent]`. The card
  shows the groups the producer sends; it infers no status.
- `j`: jobs, `[name, percent, state, details?]`. `state` is one letter: `r`
  running, `q` queued, `d` done, `f` failed, `b` blocked (shown as run / queue /
  done / fail / block; an unknown letter is shown as queue). The fourth element
  is optional, so three-item jobs stay valid.
- `details` (optional object): `m` model name, `t` minutes (a number, 0 or more),
  `s` current step, `r` last result.
- `l`: one free-text footer line (for example usage limits).
- Every key is optional. Labels and text are strings, percents and minutes are
  finite numbers. A percent is rounded and clamped to 0..100, a malformed one
  becomes 0. All text is inserted as text, never as HTML.
- Bad state never blanks the card: `{}`, an empty or invalid `chat_data`, wrong
  types and null tuples render the visible empty state `нет данных`, and the next
  valid `chat_data` renders normally. Without the `TelegramWidget` bridge (the
  file opened in a browser) the card shows built-in demo data.

### Capacity and overflow

| What | Shown | Overflow |
|---|---|---|
| groups | 3 | the rest are counted in the footer as `+N` |
| rows per group | 8 | `+N` is appended to that group's title |
| jobs | 5 | the rest are counted in the footer as `+N` |

The footer reads `+N · <l>` when something is hidden and `l` is given. Titles,
labels and details are single-line and cut with an ellipsis; nothing wraps or
scrolls. The full card (3 groups of 8 + 5 + 5 rows and 5 jobs) is 515 px high,
within the 600 px bubble limit.

### Tap a job to open it

A tap on a job opens its details (Модель, Минут, Шаг, Итог; a job without
details shows `нет данных`). While a job is open, the groups collapse to their
title and the mean percent of their rows; a second tap on the same job (or any
new `chat_data`) closes it. Each shown detail appears once: the running job's
step line under its bar is hidden while that job is open, because the detail
list already carries the step. When no click events arrive, the first running
job's step stays visible under its bar, so the step is readable without a tap.

### The caller keeps `chat_data` under 1024 bytes

The 1024-byte `chat_data` limit is the tight one and the template cannot shrink
the state for you: the caller must measure the FINAL serialized string in bytes
(not characters; Cyrillic is two bytes per letter) and drop rows or shorten
labels until it fits. `send_widget` and `edit_widget_data` refuse an oversized
state with the measured size. Budgets from the template (no footer; titles, row
labels and job names of 11 Cyrillic letters, percent 50, state `r`):

| Card | `chat_data` size |
|---|---|
| 18 rows (8+5+5), 5 jobs, no details | 810 bytes |
| same, two jobs with details (model, minutes, step and result of 11 letters) | 968 bytes |
| 11 rows (4+4+3), all five jobs with details | 995 bytes |
| 12 rows, all five jobs with details | 1025 bytes (too large) |

A footer adds 7 bytes plus its UTF-8 text; escaping and longer text cost extra.
The display capacity (3 x 8 rows, 5 jobs) is a layout limit, not a promise that
it fits the byte limit.

### Widget-side events

The template reads `TelegramWidget.chatData` once at start and re-renders in the
`TelegramWidget.onEvent('chatDataChanged', ...)` callback, the same bridge call
this document describes above. A job tap is an ordinary DOM click handler on the
job row, not a bridge event.

## Status card without the model

The tools above need the model to call them, which spends tokens on every
refresh. The plugin can also keep ONE status card up to date by itself: it runs
a command on a timer, takes the card state from its stdout and edits the widget.
No model is involved at any point. Nothing from this service is injected into
the model session, and its sends and edits do not count as model outbound
activity (the heartbeat clock is not touched).

Off by default.

### Config

In `config.json`:

```
"status_widget": {
  "enabled": true,
  "chat_id": "111111111",
  "command": ["node", "scripts/status-widget-state.mjs", "--milestones", "/path/to/milestones.json"],
  "interval_sec": 60,
  "timeout_ms": 5000
}
```

| Field | Default | Rule |
|---|---|---|
| `enabled` | `false` | when `true`, `chat_id` and `command` are required |
| `chat_id` | none | a private chat: a positive integer. Any other id (group, supergroup, channel, text) is refused at config load with a clear error. The chat must also be in `allowed_chat_ids`, the same gate the widget tools use; otherwise the service logs an error and stays off |
| `command` | `[]` | an argv array, run WITHOUT a shell (no quoting, no `$VAR`, no pipes; wrap them in a script if you need them) |
| `interval_sec` | `60` | whole seconds, at least 15 |
| `timeout_ms` | `5000` | 100 to 60000; the process is killed at the timeout |

There is no env override; the block lives in `config.json` only. Changing it
needs a plugin restart.

### The command contract

- stdout is ONE JSON object: the `chat_data` shape documented above
  (`{"m":[...],"j":[...],"l":"..."}`). Whitespace is irrelevant; the plugin
  re-serializes it compactly, so only a real change counts as a change.
- Exit code 0. stdout is capped at 16 KiB; stderr is discarded.
- The command gets the plugin's environment WITHOUT variables whose names look
  like credentials (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, ...). Wrap the
  command if it needs one on purpose.
- The state goes through the same shared payload check as the tools: at most
  1024 bytes UTF-8, and the fail-closed redaction check (a state the redactor
  would change, for example a run of 24 or more letters, digits or underscores,
  is refused, never rewritten).

### Behaviour

1. First valid state: the plugin sends the widget once with
   `templates/status.html`, and stores chat id and message id in
   `status-widget.json` in the plugin state dir (mode 0600).
2. A restart continues editing the SAME message (no new card). The first tick
   after a restart edits once; an unchanged state is answered `message is not
   modified` and counts as success.
3. Every `interval_sec` it runs the command and edits the widget data ONLY when
   the state bytes changed since the last successful edit. Edits use the
   existing reliable path: serialized per widget, retried on transient errors.
4. «message to edit not found» / «message can't be edited»: the stored message
   is forgotten and a fresh card is sent on the next tick.

### Failure behaviour

Any of these keeps the previous card, logs ONE warning with a reason (never
the payload) and never crashes the plugin: non-zero exit, timeout, spawn error,
stdout over the cap, empty output, invalid JSON, a JSON value that is not an
object, a state over 1024 bytes, a state refused by redaction, a failed send or
edit. A broken state is never sent.

Repeated failures back off: the next attempt waits `interval_sec` x 2^N, capped
at 10 minutes (N counts failures in a row); one success resets it. A failed
`sendWidget` is not retried inside the same tick (a retry could show two cards).

### Bot command `/card`

`/card` is handled by the plugin itself, like `/status` (it never wakes the
model, and `/status` is unchanged). It runs the command and sends a FRESH card
to the chat right now; that message becomes the tracked one, so the timer edits
it from then on. The old card stays in the chat history. It works for the same
users as the other out-of-band commands (allowed user, private chat, chat on
the allowlist) and only in the configured `chat_id`. If the command is failing,
the last good state is used; with no state at all the answer says so. With
`status_widget` off it answers that the card is disabled in config.

### Example producer: `scripts/status-widget-state.mjs`

Plain Node/Bun, no dependencies.

```
node scripts/status-widget-state.mjs --milestones <file> \
     [--jobs-cmd '["runner","list","--json"]'] [--footer "text"]
```

- `--milestones`: `{"works":[{"title":"...","active":true,"phases":[{"label":"...","pct":90}]}]}`.
  Only `active` works go to the card, in file order; each work is a group, each
  phase a row.
- `--jobs-cmd`: a JSON argv array (no shell) that prints
  `{"jobs":[{"id","title","kind","status","model","turns","max_turns","started_at","finished_at","created_at", ...}]}`.
  Mapping: `running` is `r`, `queued` `q`, `succeeded` `d`, `failed` and
  `timeout` `f`, `stopped` and `cancelled` `b`; any other status is skipped.
  Order: running (oldest first), queued (oldest first), then the most recently
  finished; 5 rows at most; finished jobs older than 30 minutes are skipped.
  Percent: running is `turns / max_turns` capped at 95 (or, without `max_turns`,
  the elapsed share of `timeout_minutes`, capped at 95), queued 0, succeeded 100,
  other finished jobs the progress they reached. Details: model and minutes.
- `--footer`: the footer line `l`.
- `--now`: an ISO time instead of the clock (for tests).

Output is guaranteed at most 1024 bytes UTF-8. When the card is too big it
sheds in this order: job details, then title/label length (down to 8
characters), then the oldest finished jobs, then groups and rows beyond the
template capacity (3 groups, 8 rows), and as a last resort trailing rows,
groups, the footer and jobs. ASCII runs of 24 or more characters are cut with
an ellipsis so the redaction check does not refuse the whole card. It exits
non-zero with a message on stderr when an input is unreadable (missing or
invalid milestones file, failing jobs command), so the plugin keeps the old
card.

### Limits

- Private chats only (a Telegram limit for widgets).
- One tracked card. `/card` replaces it with a new message.
- The shape and size rules are the ones above: 1024 bytes of state, 32768 bytes
  of template (4096 after zlib level 9; `status.html` is checked at start and the
  service stays off, with an error in the log, if it were refused).
- Only a live Telegram check shows how the card looks and how the real edit
  errors read; the service was tested with injected fakes.
