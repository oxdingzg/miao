#!/usr/bin/env bash
# Runs one shard of the engine crate's test targets.
#
# `cargo test` in this crate builds and runs 176 test targets in one job, which
# is the longest leg of a full CI run. Sharding splits those targets across
# parallel jobs; shard 1 also runs the crate's own unit tests (lib and bins),
# which are quick and would otherwise sit on the critical path alone.
#
# Usage: engine-test-shard.sh <index> <total>
set -m -u -o pipefail

shard="${1:?shard index}"
shards="${2:?shard total}"
case "$shard" in ''|*[!0-9]*) echo "shard index must be a number" >&2; exit 1 ;; esac
case "$shards" in ''|*[!0-9]*) echo "shard total must be a number" >&2; exit 1 ;; esac
if [ "$shards" -lt 1 ] || [ "$shard" -lt 1 ] || [ "$shard" -gt "$shards" ]; then
  echo "shard $shard/$shards is out of range" >&2
  exit 1
fi

cd "$(dirname "$0")/../crates/miao-engine" || exit 1

# bash 3.2 (the macOS runner's /bin/bash) has no mapfile.
targets=()
while IFS= read -r name; do
  targets+=("$name")
done < <(ls tests/*.rs 2>/dev/null | xargs -n1 basename | sed 's/\.rs$//' | sort)
if [ "${#targets[@]}" -eq 0 ]; then
  echo "no engine test targets found under tests/" >&2
  exit 1
fi

args=()
if [ "$shard" -eq 1 ]; then
  args+=(--lib --bins)
fi
for index in "${!targets[@]}"; do
  if [ $((index % shards)) -eq $((shard - 1)) ]; then
    args+=(--test "${targets[$index]}")
  fi
done

echo "engine test shard $shard/$shards: ${#args[@]} target arguments"
RUST_MIN_STACK="${RUST_MIN_STACK:-16777216}" cargo test "${args[@]}"
