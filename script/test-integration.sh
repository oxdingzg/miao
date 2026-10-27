#!/usr/bin/env bash
# Runs the engine/ACP integration suites with one bun process per test file.
#
# The default `bun test` run keeps only pure unit tests: every file under
# packages/miao/test/engine and packages/miao/test/acp spawns the miao-engine
# binary, the engine-fake wire stand-in, or a real `miao serve` subprocess.
# In one shared process their fixtures leak into each other (temp dirs,
# ports, orphan engines) until the files scheduled last time out. A process
# per file gives each file its own timeout budget and one retry in a fresh
# process.
#
# Orphan reaping: every attempt runs with a round-private TMPDIR, so an
# engine or server that outlives the test still references that directory in
# its argv or leaves its files there. After each attempt the runner TERM/KILLs
# the test process's whole process group, kills anything whose command line
# matches the round directory (which cannot collide with anything outside
# this round), and recreates the directory empty for the next file.
#
# Environment:
#   MIAO_ENGINE_BIN           engine binary under test; without it the
#                             engine-binary files skip themselves
#   INTEGRATION_TEST_TIMEOUT  per-test timeout in ms passed to bun test
#                             (default 300000, raised from the unit 30000)
#   INTEGRATION_FILE_TIMEOUT  wall-clock budget per attempt in seconds
#                             (default 900) so a wedged file cannot pin the
#                             whole suite
set -m -u -o pipefail

cd "$(dirname "$0")/../packages/miao"

timeout_ms="${INTEGRATION_TEST_TIMEOUT:-300000}"
file_deadline="${INTEGRATION_FILE_TIMEOUT:-900}"
round="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/miao-integration-$$"

if [ -z "${MIAO_ENGINE_BIN:-}" ]; then
  echo "MIAO_ENGINE_BIN is not set; engine-binary files will skip themselves" >&2
fi

files=()
while IFS= read -r file; do files+=("$file"); done < <(find test/engine test/acp -name '*.test.ts' | sort)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no integration test files found under test/engine and test/acp" >&2
  exit 1
fi

mkdir -p "$round"

reap_group() {
  local pid="$1"
  kill -TERM -- "-$pid" 2>/dev/null || true
  local waited=0
  while kill -0 -- "-$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do
    sleep 0.2
    waited=$((waited + 1))
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  pkill -TERM -f "$round" 2>/dev/null || true
}

run_attempt() {
  local file="$1"
  # The ACP suite drives its own real `miao serve` and expects TS-server
  # mode; a visible engine binary switches serve into native engine mode
  # whose credential routing the fixtures cannot provide. Only test/engine
  # files run against the engine under test.
  local strip_engine=""
  case "$file" in test/acp/*) strip_engine="-u MIAO_ENGINE_BIN" ;; esac
  # env options must precede the assignments, so the strip flag expands first.
  env $strip_engine TMPDIR="$round" bun test --timeout "$timeout_ms" --only-failures "./$file" &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$file_deadline" ]; then
      echo "  [kill] $file exceeded ${file_deadline}s; reaping the process tree" >&2
      reap_group "$pid"
      wait "$pid" 2>/dev/null
      return 1
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  wait "$pid" 2>/dev/null
  local code=$?
  reap_group "$pid"
  return "$code"
}

total=${#files[@]}
index=0
failed=()
suite_start=$(date +%s)

for file in "${files[@]}"; do
  index=$((index + 1))
  start=$(date +%s)
  outcome="pass"
  if ! run_attempt "$file"; then
    outcome="flaky-pass"
    echo "  [retry] $file failed once; re-running in a fresh process" >&2
    if ! run_attempt "$file"; then
      outcome="FAIL"
      failed+=("$file")
    fi
  fi
  printf '[%d/%d] %-10s %s (%ds)\n' "$index" "$total" "$outcome" "$file" "$(($(date +%s) - start))"
  rm -rf "$round"
  mkdir -p "$round"
done

rm -rf "$round"
echo "integration suite: $total files in $(($(date +%s) - suite_start))s, ${#failed[@]} failed"
if [ "${#failed[@]}" -gt 0 ]; then
  printf 'failed: %s\n' "${failed[@]}"
  exit 1
fi
