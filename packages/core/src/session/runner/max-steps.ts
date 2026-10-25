export const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.`

export const BUDGET_WRAP_UP_NOTE = `PROMPT BUDGET WRAP-UP

The token budget for this prompt is nearly exhausted. Start wrapping up now:
1. Finish only the operation currently in progress; do not start new investigations or batches of tool calls
2. Prefer targeted reads over broad exploration
3. End with a summary of what was accomplished, the current state, and the concrete remaining work

A new user message grants a fresh budget, so unfinished work can continue there.`

export const BUDGET_EXHAUSTED_PROMPT = `CRITICAL - PROMPT TOKEN BUDGET EXHAUSTED

The token budget for this prompt has been exhausted. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that the prompt token budget has been exhausted
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

A new user message grants a fresh budget. Any attempt to use tools is a critical violation. Respond with text ONLY.`
