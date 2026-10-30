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
#   MIAO_ENGINE_BIN           executable prebuilt engine under test; required
#                             for native integration acceptance
#   INTEGRATION_REQUIRE_ENGINE  defaults to 1; 0 is an explicit non-native run
#                             and requires selected file arguments
#   INTEGRATION_TEST_TIMEOUT  per-test timeout in ms passed to bun test
#                             (default 300000, raised from the unit 30000)
#   INTEGRATION_FILE_TIMEOUT  wall-clock budget per attempt in seconds
#                             (default 900) so a wedged file cannot pin the
#                             whole suite
set -m -u -o pipefail

cd "$(dirname "$0")/../packages/miao" || exit 1

timeout_ms="${INTEGRATION_TEST_TIMEOUT:-300000}"
file_deadline="${INTEGRATION_FILE_TIMEOUT:-900}"
round="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/miao-integration-$$"

case "${INTEGRATION_REQUIRE_ENGINE:-1}" in
  0|1) ;;
  *) echo "INTEGRATION_REQUIRE_ENGINE must be 0 or 1" >&2; exit 1 ;;
esac
if [ "${INTEGRATION_REQUIRE_ENGINE:-1}" = 1 ]; then
  if [ ! -x "${MIAO_ENGINE_BIN:-}" ]; then
    echo "Native integration requires an executable MIAO_ENGINE_BIN (set it to a prebuilt engine)." >&2
    echo "For selected protocol-only files, explicitly set INTEGRATION_REQUIRE_ENGINE=0; this does not validate the native engine." >&2
    exit 1
  fi
  "$MIAO_ENGINE_BIN" --version || exit 1
else
  if [ "$#" -eq 0 ]; then
    echo "INTEGRATION_REQUIRE_ENGINE=0 requires explicit protocol-only file arguments; the full suite requires a native engine." >&2
    exit 1
  fi
  echo "Non-native integration selection: native engine acceptance is not established." >&2
fi

files=()
# Optional package-relative file arguments let specialist jobs share the same
# isolation and cleanup without paying for the entire integration suite.
if [ "$#" -gt 0 ]; then
  for file in "$@"; do
    case "$file" in
      test/engine/*.test.ts|test/acp/*.test.ts)
        [ -f "$file" ] || { echo "integration test file does not exist: $file" >&2; exit 1; }
        files+=("$file")
        ;;
      *) echo "expected an integration test under test/engine or test/acp: $file" >&2; exit 1 ;;
    esac
  done
else
  while IFS= read -r file; do files+=("$file"); done < <(find test/engine test/acp -name '*.test.ts' | sort)
fi
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
  local runner_env=(env)
  case "$file" in test/acp/*) runner_env+=(-u MIAO_ENGINE_BIN) ;; esac
  # env options must precede the per-process assignments.
  "${runner_env[@]}" TMPDIR="$round" bun test --timeout "$timeout_ms" --only-failures "./$file" &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$elapsed" -ge "$file_deadline" ]; then
      echo "  [kill] $file exceeded ${file_deadline}s; reaping the process tree" >&2
      reap_group "$pid"
      wait "$pid" 2>/dev/null
      return 1
    fi
    # Short files should not wait five seconds for their exit to be noticed.
    sleep 1
    elapsed=$((elapsed + 1))
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
