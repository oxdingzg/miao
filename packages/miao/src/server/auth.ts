// miao's server auth is the shared server auth: both read `Flag.MIAO_SERVER_*`
// and the `MIAO_SERVER_*` environment, so the release and `packages/cli` agree.
export * as ServerAuth from "@miao/server/auth"
