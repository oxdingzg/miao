export * as Vcs from "./vcs"

import { Schema } from "effect"
import { optional } from "./schema"

export const Info = Schema.Struct({
  branch: optional(Schema.String),
  default_branch: optional(Schema.String),
}).annotate({ identifier: "VcsInfo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const FileDiff = Schema.Struct({
  file: Schema.String,
  patch: optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "VcsFileDiff" })
export interface FileDiff extends Schema.Schema.Type<typeof FileDiff> {}

// What /api/vcs/diff returns: every entry carries its patch and change kind.
export const Patch = Schema.Struct({
  file: Schema.String,
  patch: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "VcsFilePatch" })
export interface Patch extends Schema.Schema.Type<typeof Patch> {}

export const FileStatus = Schema.Struct({
  file: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "VcsFileStatus" })
export interface FileStatus extends Schema.Schema.Type<typeof FileStatus> {}

export const SnapshotFileDiff = Schema.Struct({
  file: optional(Schema.String),
  patch: optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "SnapshotFileDiff" })
export interface SnapshotFileDiff extends Schema.Schema.Type<typeof SnapshotFileDiff> {}

// Compatibility names for the V1 view models.
export type VcsFileDiff = FileDiff
export type VcsFileStatus = FileStatus
export type VcsInfo = Info
