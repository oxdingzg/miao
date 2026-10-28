# Optional worker runtime and load diagnostics

The ADR-12 extension worker serves project custom tools. It is optional and is
not a general JavaScript provider adapter. The product enables it through
`MIAO_ENGINE_WORKER=1`; a directly managed engine can use a trusted
`--worker-config` manifest. Tool authorization remains engine-owned.

Project tools must resolve their own imports, including any plugin SDK or other
packages they use. Use the project's dependency management to provide those
packages. The discovery code does not invoke a package installer. Bundling the
worker into the CLI does not bundle every dependency of arbitrary project tools.

A failed tool-module import now writes a diagnostic to stderr containing the
`[worker-host]` prefix, the tool file and the loader error. For example, a missing
package names both the file that imports it and the unresolved package. The tool
is omitted from the catalog; other healthy tools remain available. The engine forwards worker stderr; the product connection records matching
worker diagnostics through its logger and optional `onDiagnostic` callback. The
client emits at most 16 diagnostic lines (8,192 characters each), followed by one omission
notice, and retains its existing bounded stderr tail. Observer exceptions do not stop stderr draining. Diagnostic text never goes
to the newline-JSON protocol on stdout. A missing tool directory
is normal and stays quiet; other directory read failures are reported.

This differs from a missing or crashed worker process, which the engine reports
as `extension worker unavailable` while retaining built-in tools. Invalid trusted
worker configuration is rejected before the engine starts. Neither failure
switches a native Session into the TypeScript provider loop.

The compiled CLI self-execution entry and scoped manifests are addressed in
[PR #1602](https://github.com/oxdingzg/miao/pull/1602). This diagnostic change is
independent and retains direct source execution. Full platform installation,
third-party package compatibility and Rust-only product acceptance remain
separate from these worker tests.
