# Vendored: html-components / telegram

- Source: https://github.com/qwwiwi/html-components, folder `telegram/`
- Commit: `5dc5810cb7d087592cb7621c1ec610c7dfa9ec78`
- License: MIT, see `LICENSE` in this folder (copied from upstream unchanged)
- Refresh: `plugin/scripts/vendor-components.sh <full-sha>`, then `bun test` and `bun run typecheck` in `plugin/`
  (offline: `HTML_COMPONENTS_TARBALL=<archive of that commit>`, see the script header)

Local changes: none. Upstream test files (`*.test.js`, `*.test.mjs`) are not
copied: they run in upstream's own suite. `index.mjs` and `index.d.mts` next
to this file are the plugin's typed entry point and are not upstream files.
The runtime never fetches anything over the network: the plugin imports only
this copy.
