//! Cooperate with the controlling shell before taking terminal ownership.
use std::io;

#[cfg(unix)]
pub fn foreground() -> io::Result<()> {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::{getpgrp, tcgetpgrp};
    if tcgetpgrp(std::io::stdin())? == getpgrp() {
        return Ok(());
    }
    // A background launch waits for `fg` before raw mode or stdin readers.
    // SIGTTIN is ignored for orphaned groups: fail rather than loop or SIGSTOP.
    killpg(getpgrp(), Signal::SIGTTIN)?;
    if tcgetpgrp(std::io::stdin())? != getpgrp() {
        return Err(io::Error::other("start miao in the foreground with fg"));
    }
    Ok(())
}

#[cfg(windows)]
pub fn foreground() -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
pub fn suspend() -> io::Result<()> {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::getpgrp;
    // Keep the shell's whole job together, including launchers and engines.
    // Orphaned SSH groups ignore SIGTSTP and return safely without a hard stop.
    killpg(getpgrp(), Signal::SIGTSTP)?;
    foreground()
}
