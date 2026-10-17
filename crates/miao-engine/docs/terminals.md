# Session-owned interactive terminals

The engine exposes `terminal_start`, `terminal_write`, `terminal_read`,
`terminal_resize`, `terminal_list`, and `terminal_stop` when both process and
background authority are enabled. Unix backs each terminal with a PTY confined
by seatbelt/Landlock; Windows backs each terminal with a real pseudoconsole
(ConPTY) whose child is placed in the same AppContainer and job object as a
confined foreground command.

- `terminal_start` accepts `argv`, workspace-relative `cwd`, `rows`, and `cols`.
  A shell is explicit, e.g. `argv: ["bash"]`; no shell parsing is implied for
  ordinary argv. Start is authorized before spawning and revalidates placement.
- Read the program's startup prompt before sending input; startup code may flush
  early keystrokes. Running-terminal reads are polling, so identical pending
  output does not trigger the identical-result loop guard; the provider-turn
  allowance still bounds polling.
- Write sends exact bytes, including control characters/newlines. It is not a
  new Bash command: it addresses the authorized Session-owned terminal. Write
  and other controls still pass through tool admission and permission policy.
- Read returns raw PTY text, absolute byte `cursor`, `retained_from`, `dropped`,
  `truncated`, and `exit`. Omitted cursor continues from the last read. An
  explicit cursor replays retained bytes. Each read returns at most 32 KiB;
  the ring retains at most 1 MiB. Escape sequences and terminal echo are part
  of the raw output. An input timeout reports that some bytes may have been
  written and must not be blindly retried.
- Resize changes the actual PTY window size (1–500 rows/columns).
- Exited terminals retain output until stop; stop reaps the child and returns
  unread output, capped at 32 KiB, before releasing the slot.
- IDs only resolve within the calling Session. At most eight retained terminals
  per Session and 32 per runtime are allowed, including exited terminals.

Terminals survive an individual provider drain and its cancellation. Their
maximum process lifetime is one day. Runtime shutdown or registry owner drop
cancels and reaps them. They are process-local handles, not restartable process
identities. Existing durable tool dispatch records represent admission/results;
crash recovery does not restart a terminal or replay typed input.

The runner shares the existing workspace/network confinement. Guardian stdin
remains a private owner lifeline; an extra inherited fd carries the PTY slave.
The interactive guardian owns a separate controlling-terminal Session and
tracks the command's process group. Hard engine exit closes the lifeline and
stops ordinary descendants. As with foreground process execution, deliberately
re-sessioned descendants require stronger OS ownership than process-group
sweeps. macOS permits termios ioctls only on the assigned PTY and `/dev/tty`.

On Windows the child is started on `CreatePseudoConsole` with an explicit
`PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` attribute, and the session's
registry/ring/cursor/limit logic is the same code as Unix; only the process/PTY
layer differs. `terminal_stop` and runtime shutdown kill the job object, so the
whole tree dies and the blocking output reader observes end-of-stream.

A Windows terminal requires AppContainer confinement and reports
`sandbox_profile: "workspace_write"`. The profile and writable-directory ACLs
remain owned by the terminal until its process tree is stopped. If the OS
rejects the confined pseudoconsole launch, startup returns an error; it never
retries as an unconfined process.

Evidence: on Unix `tests/terminal.rs` exercises actual confined processes,
terminal stdin/stdout, exact input, resize observed by `stty`, cursor replay,
Session isolation, output retention limits, exit status, stop/shutdown, and a
complete provider/tool/durable-history workflow. On Windows the same file's
`cfg(windows)` tests run a real `cmd.exe` on a real pseudoconsole and assert
startup output, exact echoed input, resize observed through `mode con`, exit
codes, ring-bounded output, `terminal_stop` reaping a heartbeat process tree,
cross-Session isolation, nested canonical cwd, positive workspace writes and outside sentinel preservation. `tests/guardian.rs` also kills a serving engine to
verify Unix terminal owner-loss cleanup. Existing Bash and process tests cover
shared spawn/confinement regressions.
