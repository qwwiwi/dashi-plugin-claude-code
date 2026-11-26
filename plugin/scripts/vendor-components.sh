#!/usr/bin/env bash
# Refresh the vendored html-components Telegram packs at a pinned commit.
#
#   plugin/scripts/vendor-components.sh <sha>
#
# Downloads github.com/qwwiwi/html-components at <sha> (a full 40-char commit
# id, so the pin is exact), replaces plugin/vendor/html-components/telegram/
# with the upstream telegram/ folder (upstream test files dropped: they belong
# to upstream's own test run, not to the plugin's `bun test`), copies the
# upstream LICENSE and rewrites VENDOR.md with the source and the commit.
# Runtime never fetches anything: the plugin imports only the vendored copy.
# After a refresh run `bun test` and `bun run typecheck` in plugin/.
set -euo pipefail

REPO="qwwiwi/html-components"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <full-commit-sha>" >&2
  exit 2
fi
SHA="$1"
if ! printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "error: pass the full 40-character commit sha, got '$SHA'" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$SCRIPT_DIR/../vendor/html-components"
if [ ! -d "$DEST" ]; then
  echo "error: vendor directory not found: $DEST" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

echo "downloading $REPO@$SHA"
curl -fsSL -o "$WORK/src.tgz" "https://codeload.github.com/$REPO/tar.gz/$SHA"
tar xzf "$WORK/src.tgz" -C "$WORK"
SRC="$WORK/html-components-$SHA"
if [ ! -f "$SRC/telegram/index.mjs" ] || [ ! -f "$SRC/LICENSE" ]; then
  echo "error: $REPO@$SHA has no telegram/index.mjs or LICENSE" >&2
  exit 1
fi

echo "replacing $DEST/telegram"
rm -rf -- "$DEST/telegram"
cp -R "$SRC/telegram" "$DEST/telegram"
find "$DEST/telegram" -type f \( -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.ts' \) -delete
cp "$SRC/LICENSE" "$DEST/LICENSE"

cat > "$DEST/VENDOR.md" <<EOF
# Vendored: html-components / telegram

- Source: https://github.com/$REPO, folder \`telegram/\`
- Commit: \`$SHA\`
- License: MIT, see \`LICENSE\` in this folder (copied from upstream unchanged)
- Refresh: \`plugin/scripts/vendor-components.sh <full-sha>\`, then \`bun test\` and \`bun run typecheck\` in \`plugin/\`

Local changes: none. Upstream test files (\`*.test.js\`, \`*.test.mjs\`) are not
copied: they run in upstream's own suite. \`index.mjs\` and \`index.d.mts\` next
to this file are the plugin's typed entry point and are not upstream files.
The runtime never fetches anything over the network: the plugin imports only
this copy.
EOF

echo "vendored $REPO@$SHA into $DEST"
