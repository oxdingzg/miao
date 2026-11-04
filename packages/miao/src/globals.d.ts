/**
 * Set by `packages/miao/script/build.ts` when it compiles a single-file build,
 * and absent when running from source, which is why every read is guarded by a
 * `typeof` check.
 *
 * This used to be declared inside `sandbox-runner.ts`; that file is gone with
 * the `miao __sandbox-run` entry point, so the ambient declaration lives on its
 * own instead of in a module nothing imports.
 */
declare const MIAO_PACKAGED: boolean | undefined
