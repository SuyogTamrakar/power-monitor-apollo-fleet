#!/usr/bin/env bash
# Commit and push logs/ to GitHub.
set -euo pipefail

cd "$(dirname "$0")/.."

# Abort any stuck rebase before we start
if git rebase --show-current-patch >/dev/null 2>&1; then
  echo "Stuck rebase detected — aborting."
  git rebase --abort
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
git add logs/
git diff --cached --quiet && echo "Nothing to commit." && exit 0
git commit -m "data: auto-log update ${TIMESTAMP}"

# Fetch remote changes and merge ours on top.
# Use --strategy-option=ours for logs/ so local CSV always wins on conflict.
git fetch origin main
git merge -X ours FETCH_HEAD --no-edit -m "merge: integrate remote changes"
git push origin HEAD
