#!/usr/bin/env bash
# Commit and push logs/ to GitHub.
set -euo pipefail

cd "$(dirname "$0")/.."

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
git add logs/
git diff --cached --quiet && echo "Nothing to commit." && exit 0
git commit -m "data: auto-log update ${TIMESTAMP}"
git push origin HEAD
