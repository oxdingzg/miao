export * as EditMatch from "./edit-match"

import { native, type NativeModule } from "@miao/native"
import { Flag } from "../flag/flag"
import { EditFuzzy } from "./edit-fuzzy"

/**
 * The one edit-matching contract shared by every backend.
 *
 * `match` decides what `oldString` refers to in `text`. It is pure: it returns
 * the substring to replace and how many replacements it covers, never modified
 * content. Authorization, conditional writes, BOM/EOL handling, formatting, LSP
 * and durable settlement stay with the core edit tool.
 *
 * Semantics, identical for the native addon, the native-disabled path and an
 * older addon without `matchEdit`:
 * - an exact occurrence wins; a second occurrence (including a self-overlap such
 *   as `"aaa"` for `"aa"`) is ambiguous unless `replaceAll` is set;
 * - otherwise the restored V1 strategies are tried in order, but a candidate
 *   must begin a line, must not be disproportionate and must be unique unless
 *   `replaceAll` is set;
 * - `count` is the non-overlapping replacement count.
 */
export type Result = EditFuzzy.Result

export function match(text: string, oldString: string, replaceAll: boolean): Result {
  if (Flag.MIAO_NATIVE && native && typeof native.matchEdit === "function")
    return matchNative(native, text, oldString, replaceAll)
  return matchTs(text, oldString, replaceAll)
}

/** The TypeScript reference implementation of the contract. */
export function matchTs(text: string, oldString: string, replaceAll: boolean): Result {
  if (oldString === "") return { _tag: "none" }
  if (text.includes(oldString)) {
    if (!replaceAll && !EditFuzzy.isUniqueOccurrence(text, oldString)) return { _tag: "ambiguous" }
    return {
      _tag: "match",
      find: oldString,
      count: replaceAll ? EditFuzzy.countOccurrences(text, oldString) : 1,
    }
  }
  return EditFuzzy.fuzzyPlan(text, oldString, replaceAll)
}

/** Whether the loaded addon can serve the shared contract. */
export function nativeActive() {
  return Flag.MIAO_NATIVE && typeof native?.matchEdit === "function"
}

function matchNative(module: NativeModule, text: string, oldString: string, replaceAll: boolean): Result {
  const result = module.matchEdit(text, oldString, replaceAll)
  switch (result.kind) {
    case "match":
      return { _tag: "match", find: result.find ?? "", count: result.count ?? 0 }
    case "ambiguous":
      return { _tag: "ambiguous" }
    case "disproportionate":
      return { _tag: "disproportionate" }
    default:
      return { _tag: "none" }
  }
}
