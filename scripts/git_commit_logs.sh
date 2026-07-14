#!/usr/bin/env bash
# Commit and push logs/ to GitHub.
# Resilient to post-reboot network delays: retries push up to 3 times
# with a 30-second timeout per attempt before giving up for this cycle.
set -euo pipefail

cd "$(dirname "$0")/.."

# Abort any stuck rebase before we start
if git rebase --show-current-patch >/dev/null 2>&1; then
  echo "Stuck rebase detected — aborting."
  git rebase --abort
fi

# Remove stale git lock files left by an unclean shutdown
for lock in .git/index.lock .git/MERGE_HEAD .git/rebase-merge; do
  if [ -e "$lock" ]; then
    echo "Removing stale lock: $lock"
    rm -rf "$lock"
  fi
done

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
git add logs/
git diff --cached --quiet && echo "Nothing to commit." && exit 0
git commit -m "data: auto-log update ${TIMESTAMP}"

# Fetch and merge with a 30-second timeout
if ! timeout 30 git fetch origin main; then
  echo "git fetch timed out or failed — will retry next cycle."
  exit 0
fi
git merge -X ours FETCH_HEAD --no-edit -m "merge: integrate remote changes"

# Push with retries: 3 attempts, 30-second timeout each, 10-second pause between
MAX_RETRIES=3
for attempt in $(seq 1 $MAX_RETRIES); do
  if timeout 30 git push origin HEAD; then
    echo "Push succeeded on attempt ${attempt}."
    exit 0
  fi
  echo "Push attempt ${attempt}/${MAX_RETRIES} failed."
  [ "$attempt" -lt "$MAX_RETRIES" ] && sleep 10
done

echo "All push attempts failed — data committed locally, will push next cycle."
exit 0
