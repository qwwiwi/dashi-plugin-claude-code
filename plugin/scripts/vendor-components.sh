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
#
# Offline: set HTML_COMPONENTS_TARBALL to a local .tar.gz of the same commit
# whose single top folder is html-components-<sha>/, e.g.
#   git -C <clone> archive --format=tar.gz --prefix=html-components-<sha>/ \
#     -o /tmp/hc.tgz <sha>
#
# The archive is checked BEFORE extraction: only regular files and folders,
# every member inside html-components-<sha>/, no absolute path and no `..`.
# Anything else (symlink, hardlink, device, fifo, a path outside) aborts with
# nothing extracted and the vendored copy untouched.
set -euo pipefail

REPO="qwwiwi/html-components"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <full-commit-sha>" >&2
  exit 2
fi
SHA="$1"
# [[ =~ ]] matches the WHOLE argument; grep would accept any one matching line
# of a multi-line argument.
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
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
TOP="html-components-$SHA"

if [ -n "${HTML_COMPONENTS_TARBALL:-}" ]; then
  if [ ! -f "$HTML_COMPONENTS_TARBALL" ]; then
    echo "error: HTML_COMPONENTS_TARBALL is not a file: $HTML_COMPONENTS_TARBALL" >&2
    exit 1
  fi
  echo "using local archive $HTML_COMPONENTS_TARBALL for $REPO@$SHA"
  cp -- "$HTML_COMPONENTS_TARBALL" "$WORK/src.tgz"
else
  echo "downloading $REPO@$SHA"
  curl -fsSL -o "$WORK/src.tgz" "https://codeload.github.com/$REPO/tar.gz/$SHA"
fi

unsafe() {
  echo "error: unsafe archive, nothing extracted: $1" >&2
  exit 1
}

echo "checking archive members"
# Member types: first column of the verbose listing ('-' file, 'd' folder;
# 'l' symlink, 'h' hardlink, 'c'/'b' device, 'p' fifo, ... are refused).
tar -tzvf "$WORK/src.tgz" >"$WORK/members-verbose.txt"
while IFS= read -r line; do
  case "${line:0:1}" in
    -|d) ;;
    *) unsafe "not a regular file or folder: $line" ;;
  esac
done <"$WORK/members-verbose.txt"
# Member names: inside $TOP/, never absolute, never a `..` component.
tar -tzf "$WORK/src.tgz" >"$WORK/members.txt"
if [ ! -s "$WORK/members.txt" ]; then
  unsafe "empty archive"
fi
while IFS= read -r name; do
  case "$name" in
    /*) unsafe "absolute path: $name" ;;
  esac
  case "/$name/" in
    */../*) unsafe "path with '..': $name" ;;
  esac
  if [ "$name" != "$TOP" ] && [ "$name" != "$TOP/" ] && [ "${name#"$TOP/"}" = "$name" ]; then
    unsafe "outside $TOP/: $name"
  fi
done <"$WORK/members.txt"

mkdir "$WORK/x"
tar -xzf "$WORK/src.tgz" -C "$WORK/x" --no-same-owner --no-same-permissions
SRC="$WORK/x/$TOP"
# Belt and braces: the extracted tree holds only files and folders.
if [ -n "$(find "$WORK/x" ! -type f ! -type d -print -quit)" ]; then
  unsafe "extracted tree holds a non-regular entry"
fi
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
  (offline: \`HTML_COMPONENTS_TARBALL=<archive of that commit>\`, see the script header)

Local changes: none. Upstream test files (\`*.test.js\`, \`*.test.mjs\`) are not
copied: they run in upstream's own suite. \`index.mjs\` and \`index.d.mts\` next
to this file are the plugin's typed entry point and are not upstream files.
The runtime never fetches anything over the network: the plugin imports only
this copy.
EOF

echo "vendored $REPO@$SHA into $DEST"
