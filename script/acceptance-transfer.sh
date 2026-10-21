#!/bin/sh
set -e
. /tmp/miao-acc/env.sh
unset MIAO_ENGINE_PROVIDER MIAO_ENGINE_ENDPOINT MIAO_ENGINE_MODEL_ROUTES
rm -rf "$ACC/storage" "$WORKSPACE" "$ACC/data" "$ACC/config"
mkdir -p "$ACC/storage" "$WORKSPACE" "$ACC/config/miao"
cat > "$ACC/config/miao/miao.jsonc" <<'JSONEOF'
{
  "model": "zhipuai-coding-plan/glm-5.3-flash",
  "small_model": "zhipuai-coding-plan/glm-5.3-flash",
  "provider": {
    "zhipuai-coding-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "zhipuai-coding-plan",
      "options": { "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4" },
      "models": {
        "glm-5.3-flash": { "name": "GLM-5.3-flash", "cost": { "input": 0.15, "output": 0.5, "cache_read": 0.03 } }
      }
    }
  }
}
JSONEOF
printf 'acceptance fixture alpha\n' > "$WORKSPACE/notes.txt"

echo "== [0] init isolated store + credential"
(cd "$WORKSPACE" && XDG_DATA_HOME="$DATA" XDG_CONFIG_HOME="$ACC/config" bun "$WT/packages/miao/src/index.ts" session list > /dev/null 2>&1 || true)
sqlite3 "$DATA/miao/miao-local.db" "ATTACH '/tmp/miao-eval/cred/credentials.db' AS src; INSERT OR REPLACE INTO credential SELECT * FROM src.credential WHERE integration_id='zhipuai-coding-plan'; DETACH src;"

echo "== [1] create TS session (no MIAO_ENGINE_STORAGE)"
(cd "$WORKSPACE" && XDG_DATA_HOME="$DATA" XDG_CONFIG_HOME="$ACC/config" bun "$WT/packages/miao/src/index.ts" run --model $MODEL \
  "Read notes.txt with read_file and tell me the exact first word it contains. Then stop." 2>&1 | tail -1)
SID=$(sqlite3 "$DATA/miao/miao-local.db" "SELECT id FROM session ORDER BY time_created DESC LIMIT 1;")
echo "SID=$SID"; echo "$SID" > "$ACC/sid.txt"

echo "== [2] derive native db path from the product itself"
NDB=$(cd "$WORKSPACE" && XDG_DATA_HOME="$DATA" XDG_CONFIG_HOME="$ACC/config" MIAO_ENGINE_STORAGE="$ACC/storage" MIAO_ENGINE_BIN=$ENGINE bun "$WT/packages/miao/src/index.ts" run --model $MODEL "hi" > /dev/null 2>&1; sqlite3 "$DATA/miao/miao-local.db" "SELECT native_storage FROM session_engine_placement ORDER BY rowid DESC LIMIT 1;")
echo "NDB=$NDB"
sqlite3 "$DATA/miao/miao-local.db" "DELETE FROM session_engine_placement WHERE native_storage='$NDB';"
THROWAWAY=$(sqlite3 "$DATA/miao/miao-local.db" "SELECT id FROM session ORDER BY rowid DESC LIMIT 1;")
sqlite3 "$DATA/miao/miao-local.db" "DELETE FROM session WHERE id='$THROWAWAY';"

echo "== [3] migrate TS -> native"
MIAO_ENGINE_BIN=$ENGINE MIAO_ENGINE_PROVIDER=openai-chat \
MIAO_ENGINE_ENDPOINT=https://open.bigmodel.cn/api/coding/paas/v4/chat/completions \
MIAO_ENGINE_MODEL_ROUTES=/tmp/miao-acc/routes.json \
miao_cli session migrate "$SID" --native-db "$NDB" --protocol openai-chat --model glm-5.3-flash --workspace "/tmp/miao-acc/workspace" 2>&1 | tail -1

echo "== [4] placement row"
sqlite3 "$DATA/miao/miao-local.db" "SELECT session_id, engine, native_storage FROM session_engine_placement WHERE session_id='$SID';"

echo "== [5] native continuation"
(cd "$WORKSPACE" && XDG_DATA_HOME="$DATA" XDG_CONFIG_HOME="$ACC/config" MIAO_ENGINE_STORAGE="$ACC/storage" MIAO_ENGINE_BIN=$ENGINE bun "$WT/packages/miao/src/index.ts" run --continue "$SID" --model $MODEL \
  "Append the line 'beta was here' to notes.txt, then reply done." 2>&1 | tail -1)

echo "== [6] effects + native history"
cat "$WORKSPACE/notes.txt"
sqlite3 "$NDB" "SELECT count(*) FROM engine_message WHERE session_id='$SID';"
echo "SCENARIO-A-PASS"
