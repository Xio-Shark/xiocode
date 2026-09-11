#!/usr/bin/env bash
# Fixed-task measurement for the browser tool surface: per run it reports round trips
# (provider.request), wall time, tool histogram, tool.batch sizes, and the final answer.
#
# Usage: scripts/browser-task-bench.sh <label> <repeats> [task ...]
# Needs OPENCODE_API_KEY in the environment. Artifacts land in /tmp/xio-browser-bench.
set -uo pipefail

LABEL="${1:?usage: browser-task-bench.sh <label> <repeats> [task ...]}"
REPEATS="${2:?usage: browser-task-bench.sh <label> <repeats> [task ...]}"
shift 2

if [ "$#" -gt 0 ]; then
  TASKS=("$@")
else
  TASKS=(
    "打开 https://github.com/notifications 读出前 3 条标题"
    "打开 https://github.com/notifications 点开第一条通知，告诉我它跳转到哪个 URL"
    "打开 https://github.com/Xio-Shark/xiocode 读出仓库描述和 star 数"
  )
fi

XIO_BIN="${XIO_BIN:-node /Users/xioshark/code/projects/xiocode/dist/xio.js}"
SCRIPTS=/Users/xioshark/code/projects/xiocode/scripts
OUT_DIR="${OUT_DIR:-/tmp/xio-browser-bench}"
mkdir -p "$OUT_DIR"

echo "=== label=$LABEL repeats=$REPEATS tasks=${#TASKS[@]}"
for taskIndex in "${!TASKS[@]}"; do
  for rep in $(seq 1 "$REPEATS"); do
    ndjson="$OUT_DIR/${LABEL}-t${taskIndex}-r${rep}.ndjson"
    start=$(date +%s)
    # shellcheck disable=SC2086
    $XIO_BIN -p "${TASKS[$taskIndex]}" --output-format stream-json >"$ndjson" 2>/dev/null
    wall=$(( $(date +%s) - start ))
    echo "--- task=$taskIndex rep=$rep wall=${wall}s"
    node "$SCRIPTS/count-run-events.mjs" <"$ndjson" | sed 's/^/    /'
    node /tmp/xio-run-answer.mjs <"$ndjson" | sed 's/^/    /'
  done
done
echo "=== artifacts: $OUT_DIR"
