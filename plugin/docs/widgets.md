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

A compact dark status card: milestone groups (title, rows of label and percent
bar), a list of jobs (name, percent, state) and a limits line. No network, no
external assets, no inputs. About 2.4 KB raw and 1.2 KB after zlib level 9
(a test measures it against the 4096-byte limit).

Send it by passing the file text as `html` and the state as `chat_data`:

```
send_widget({ chat_id, html: <contents of templates/status.html>,
              caption: "Status: 3 milestones, 8 jobs",
              chat_data: '{"m":[...],"j":[...],"l":"..."}' })
edit_widget_data({ chat_id, message_id, chat_data: '{"m":[...],"j":[...],"l":"..."}' })
```

### `chat_data` shape (short keys, JSON string)

```
{
  "m": [ [ "<group title>", [ ["<row label>", <percent 0-100>], ... ] ], ... ],
  "j": [ ["<job name>", <percent 0-100>, "<state>"], ... ],
  "l": "<limits line>"
}
```

- `m`: milestone groups. Each group is `[title, rows]`, each row is `[label, percent]`.
- `j`: jobs, `[name, percent, state]`. `state` is one letter: `r` running, `q`
  queued, `d` done, `f` failed, `b` blocked.
- `l`: one free-text line shown at the bottom (for example the usage limits).
- Every key is optional; an empty or invalid `chat_data` renders an empty card.
- Percent is clamped to 0..100. All text is inserted as text, never as HTML.

Size budget (the 1024-byte `chat_data` limit is the tight one). Measured by the
tests for the maximum realistic card, 3 groups x 5 rows + 8 jobs + limits line:

| Labels | `chat_data` size |
|---|---|
| Latin, up to 16 characters | 639 bytes |
| Cyrillic, up to 12 characters | 868 bytes |

So the card fits without any placeholder substitution at send time. Keep
Cyrillic labels at 12 characters or fewer, or drop rows, when the card is full.
