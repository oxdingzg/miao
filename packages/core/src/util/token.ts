export * as Token from "./token"

import { encode } from "gpt-tokenizer"

const CHARS_PER_TOKEN = 4

/** Fast character heuristic; used only where a BPE pass is not worth its cost. */
export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

/**
 * BPE token count. Exact for OpenAI-family models (o200k base), a close
 * approximation for other providers, and always better than `estimate` for
 * code and CJK text where the character heuristic under-counts heavily.
 */
export const count = (input: string) => encode(input).length
