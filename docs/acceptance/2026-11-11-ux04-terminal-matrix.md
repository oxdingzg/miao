# Acceptance record — UX-04 tmux and SSH, measured on a current tree

Item: `UX-04` (#1993). Tree: `origin/main` at `5572afd4f2`, exported with `git archive`
so the build carries no other session's working-tree edits, built on the Linux build host
`xx04` (`cargo build --bin miao`, 54 s) and run there; the tmux leg also ran on the
workstation against the installed release binary `miao 0.3.60`.

`2026-11-05-ux04-terminal-restore.md` accepted the restore paths by unit test and named
the real-terminal matrix as unvalidated. This record is two of that matrix's legs,
measured rather than asserted. It does **not** close the item: the Windows Terminal leg
and the suspend-from-a-non-composer-focus path are named below as still open.

## What was driven

| leg | what ran | how it was observed |
| --- | --- | --- |
| tmux (workstation, release `0.3.60`) | `tmux new-session` running `miao tui --workspace … --db …`, typed into the composer, two `C-c` to exit | `tmux capture-pane` shows the typed text in the composer; `tmux display-message -p '#{alternate_on}'` is `1` while running and `0` after exit, with the pane's own `EXIT=0` printed after the app returned |
| SSH (build host `xx04`, this tree) | `ssh -tt` into the host, a tmux session there as the terminal, the freshly built binary, typed, two `C-c` | the same probe: `painted_home=1` (the home screen and its composer painted), `composer=1` (the typed text appears), `alternate_on` `1` running → `0` after exit, `EXIT=0` |

Observed output, verbatim from the SSH run:

```
painted_home=1
composer=1
alts_running=1
EXIT=0
ALTS=0
```

`alternate_on` is the tmux-side fact that matters: entering the alternate screen and
leaving it are the two halves of "restores the terminal", and the pair above shows the
app did both on normal exit, on a pty reached over SSH.

## Why the first SSH attempt proved nothing

Piping keys into `ssh -tt` and reading stdout produced only an enter/leave pair and a
cursor-style reset — no frame. The cause is the harness, not the product: the TUI asks
the terminal for its cursor position (`ESC[6n`) and paints once something answers, and a
pipe has nothing to answer. tmux does answer, which is why both legs above put a real
terminal emulator at the far end. This is worth recording because "the TUI printed
nothing over SSH" is exactly the kind of observation that gets misread as a defect.

## The suspend path did not run

`ctrl+z` in the composer is undo — the key is shared with the page's suspend and the
composer wins by design — so sending it from the composer proved nothing: the process
stayed in state `S`, the alternate screen stayed `1`. Driving the suspend hook needs a
non-composer focus, which this pass did not set up.

## Still open on this item

- **Windows Terminal**: needs a Windows Terminal window. Host `96` is a Windows build
  host reached over SSH; its ConPTY is not Windows Terminal, so a run there would not be
  this leg.
- **Suspend/resume** from a non-composer focus, and a real-terminal **panic** path: both
  are unit-tested today (`terminal.rs`'s hook, `suspend_requested`) and neither has been
  driven on a real pty.
- **Carriage-return-only paste**.

## Version

No `roadmap:` stamp: this tree is in no published release, and the item is not fully
accepted regardless.
