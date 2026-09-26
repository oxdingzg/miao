export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@miao/core/flag/flag"
import { Global } from "@miao/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@miao/core/fs-util"

// Configuration has lived under `.miao/` since the rebrand. `.opencode/` is
// still discovered so a project set up before the rename keeps working, and
// `.miao/` wins when a project has both.
export const DIRECTORY_NAMES = [".miao", ".opencode"] as const
// The config file inside a config directory, by the same rule.
export const FILE_NAMES = ["miao", "opencode"] as const

export function isConfigDirectory(dir: string) {
  return DIRECTORY_NAMES.some((name) => dir.endsWith(name))
}

export function configFilesIn(dir: string) {
  return FILE_NAMES.map((name) => [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]).flat()
}

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string | readonly string[],
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  const names = typeof name === "string" ? [name] : name
  return (yield* afs.up({
    targets: names.flatMap((name) => [`${name}.jsonc`, `${name}.json`]),
    start: directory,
    stop: worktree,
  })).toReversed()
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  return unique([
    Global.Path.config,
    ...(!Flag.MIAO_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [...DIRECTORY_NAMES],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [...DIRECTORY_NAMES],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.MIAO_CONFIG_DIR ? [Flag.MIAO_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
