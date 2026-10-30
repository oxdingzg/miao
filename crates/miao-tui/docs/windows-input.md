# Windows bracketed paste input

The crates.io crossterm 0.29 Windows backend reads translated Win32 key records.
ConPTY can discard the bracketed-paste delimiters before those records reach the
application when virtual-terminal input is disabled. A CR or CRLF paste can then
be interpreted as Enter and submit part of a prompt before the user confirms it.
Normalizing an already decoded Paste event does not fix this transport boundary.

The TUI temporarily pins crossterm to commit
`e2bc49e52a0f5813f5c15ceaa37b673b6b8414a7`, the implementation in
[crossterm-rs/crossterm#1030](https://github.com/crossterm-rs/crossterm/pull/1030).
This is an unmerged upstream change, not a released crossterm version. The patch
applies to the whole TUI dependency graph so the renderer and input reader share
one crossterm implementation and its terminal-mode state.

The upstream change scopes VT input to bracketed-paste enable/disable, parses
paste and SGR mouse sequences, and retains native resize/focus events and the
legacy console fallback. Its MIT notice is retained in
`../licenses/crossterm-MIT.txt`. Replace this pin with a published version only
after the same terminal tests pass; do not revert to key-by-key CR handling.

Acceptance must include LF, CRLF and CR-only bracketed paste on a real ConPTY:
no admission before Enter, normalized complete prompt after Enter, and visible
CJK lines. Run the full TUI tests on Windows and Unix as well as editor handoff,
normal/panic terminal cleanup, resizing, mouse/focus behavior and shell job control.
A ConPTY run alone does not establish GUI Windows Terminal acceptance.

Console-side behavior is tracked by
[microsoft/terminal#18094](https://github.com/microsoft/terminal/issues/18094).
