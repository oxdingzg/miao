import path from "path"
import fs from "fs"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"

const app = "miao"
const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)
const tmp = path.join(os.tmpdir(), app)

// Global state directories are created lazily on first access instead of at
// module evaluation time. A top-level `await` here blocked every process start
// (including `--version` / `--help`) on seven synchronous mkdir calls.
const ensured = new Set<string>()

function ensure(dir: string) {
  if (!ensured.has(dir)) {
    fs.mkdirSync(dir, { recursive: true })
    ensured.add(dir)
  }
  return dir
}

const paths = {
  get home() {
    return process.env.MIAO_TEST_HOME ?? os.homedir()
  },
  get data() {
    return ensure(data)
  },
  get bin() {
    return ensure(path.join(cache, "bin"))
  },
  get log() {
    return ensure(path.join(data, "log"))
  },
  get repos() {
    return ensure(path.join(data, "repos"))
  },
  get cache() {
    return ensure(cache)
  },
  get config() {
    return ensure(config)
  },
  get state() {
    return ensure(state)
  },
  get tmp() {
    return ensure(tmp)
  },
}

export const Path = paths

Flock.setGlobal({ state })

export class Service extends Context.Service<Service, Interface>()("@miao/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.MIAO_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
