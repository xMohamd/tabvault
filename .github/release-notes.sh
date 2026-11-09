#!/usr/bin/env bash
# Prints Markdown release notes for a tag: the commits since the previous tag, grouped by
# their conventional-commit type (feat, fix, ...). Usage: .github/release-notes.sh v1.1.0
set -euo pipefail

tag="${1:?usage: release-notes.sh <tag>}"
prev="$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)"
range="${prev:+$prev..}$tag"

section() {
  local title="$1" pattern="$2" lines
  lines="$(git log --no-merges --format='%s' "$range" | grep -E "$pattern" | sed -E 's/^[a-z]+(\([^)]*\))?!?: */- /' || true)"
  [ -n "$lines" ] && printf '### %s\n\n%s\n\n' "$title" "$lines"
  return 0
}

section 'Features' '^feat(\(|!|:)'
section 'Fixes' '^fix(\(|!|:)'
section 'Documentation' '^docs(\(|!|:)'
section 'Other changes' '^(refactor|perf|style|test|build|ci|chore)(\(|!|:)'

others="$(git log --no-merges --format='%s' "$range" | grep -Ev '^[a-z]+(\([^)]*\))?!?:' | sed 's/^/- /' || true)"
[ -n "$others" ] && printf '### More\n\n%s\n\n' "$others"

if [ -n "$prev" ]; then
  printf '**Full changelog:** %s...%s\n' "$prev" "$tag"
else
  printf 'First release.\n'
fi
printf '\nInstall: download the zip for your browser below, or see the README.\n'
