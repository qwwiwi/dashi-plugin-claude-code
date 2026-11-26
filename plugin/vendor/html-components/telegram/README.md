# Telegram widget packs

Import the ESM entry point from either Bun bridge. The renderer accepts plain JSON data and returns standalone HTML and a plain-text caption. Send the caption without a parse mode when a widget is unavailable.

```js
import {renderComponent, validate} from './index.mjs';

const data = {title: 'Ход курса', label: 'Пройдено занятий', value: 75};
const result = renderComponent('progress', data, {chatData: true});
```

Each directory in `packs/` contains the input JSON Schema and a renderable example. Templates and caption builders are registered by name in `templates.mjs`. The supported names are `kpi`, `bars`, `progress`, `steps`, `compare`, `pros-cons`, `faq` `status`, `flowchart`, `architecture`, `line-area`, `donut`, `timeline-roadmap`, `radar`, `bars3d` and `network3d`. Comparison rows must match the header width. Bars and progress use percentages from 0 through 100. The shared stylesheet follows the device color scheme and uses system fonts.

`validate(name, data)` returns a boolean. On failure, inspect `result.error.code` for `UNKNOWN_PACK`, `INVALID_DATA`, `CHAT_DATA_LIMIT` or `HTML_LIMIT`. Pass `{chatData: true}` when forwarding the input as chat_data. The limit applies to the UTF-8 bytes of compact JSON. HTML budgets apply on every render (32 KiB raw, 3900 bytes zlib level 9, reserving headroom below the 4096-byte runtime limit). Captions are capped at 1024 UTF-16 code units.

The pros-cons pack accepts optional `prosLabel` and `consLabel` headings. HTML and captions default to «Плюсы» and «Минусы».

For channel status, pass the parsed chat_data object directly. Its `m` array contains `[group, [[label, percent], ...]]` entries. Its `j` array contains `[name, percent, state, details?]` entries, with state codes `r/q/d/f/b`. Optional details carry model `m`, elapsed minutes `t`, current step `s` and last result `r`. The optional footer is `l`. The schema accepts up to two groups of four rows each and three jobs. Opening a job shows its details. Render again when chat_data changes. Inputs using the earlier title/state/detail shape also render.

From the repository root, run `bun test telegram/` to exercise all examples and pack budgets.

Graph edges use zero-based node indices. Flowcharts require an acyclic graph. Architecture lanes are grouped by name in first-seen order. Line and radar series must match their axis count. Radar values are percentages. Donuts need a positive total. The diagrams and charts embed their data and use no external assets. Each has a static ledger, and series charts include a static values table until the plot is ready.

At phone widths the renderer reserves room for expanded status details. When the estimated height of a legacy layout exceeds 600px, it uses a wrapped text preview of up to 23 lines and reports any remaining line count. Visual packs use a bounded plot and fixed-height ledger rows.
