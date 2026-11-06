#!/usr/bin/env bash
# Kill runaway test/build processes on the shared machine (run by the coordinator every check-in,
# or by any agent). Nothing should run long: screenshots/perf runs and headless browsers > 10 min,
# waits on the world lock > 5 min, and batch jobs (python/blender) > 20 min are killed.
# Usage: scripts/reap.sh [--dry]
dry=${1:-}
reap() { # pattern max_seconds
  for p in $(pgrep -f "$1"); do
    t=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')
    [ -n "$t" ] && [ "$t" -gt "$2" ] || continue
    echo "reap pid=$p age=${t}s $(ps -o args= -p "$p" | cut -c1-140)"
    [ "$dry" = "--dry" ] || kill -9 "$p" 2>/dev/null
  done
}
reap 'flock /tmp/claude-0/world-shot.lock' 300
reap 'scripts/(shot|perf|_shot)[a-z_]*\.mjs' 600
reap 'chrome-headless-shell' 600
reap 'python3 .*scripts/' 1200
reap 'blender|bpy' 1200
exit 0
