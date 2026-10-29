//! Register exit signals before entering raw mode, and receive them on the UI loop.
use std::io;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Interrupt,
    Exit,
}

#[cfg(unix)]
pub struct Signals {
    terminate: tokio::signal::unix::Signal,
    hangup: tokio::signal::unix::Signal,
    interrupt: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl Signals {
    pub fn new() -> io::Result<Self> {
        use tokio::signal::unix::{signal, SignalKind};
        Ok(Self {
            terminate: signal(SignalKind::terminate())?,
            hangup: signal(SignalKind::hangup())?,
            interrupt: signal(SignalKind::interrupt())?,
        })
    }

    pub async fn next(&mut self) -> Signal {
        tokio::select! {
            _ = self.terminate.recv() => Signal::Exit,
            _ = self.hangup.recv() => Signal::Exit,
            _ = self.interrupt.recv() => Signal::Interrupt,
        }
    }
}

#[cfg(windows)]
pub struct Signals {
    interrupt: tokio::signal::windows::CtrlC,
    stop: tokio::signal::windows::CtrlBreak,
    close: tokio::signal::windows::CtrlClose,
    logoff: tokio::signal::windows::CtrlLogoff,
    shutdown: tokio::signal::windows::CtrlShutdown,
}

#[cfg(windows)]
impl Signals {
    pub fn new() -> io::Result<Self> {
        use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_logoff, ctrl_shutdown};
        Ok(Self {
            interrupt: ctrl_c()?,
            stop: ctrl_break()?,
            close: ctrl_close()?,
            logoff: ctrl_logoff()?,
            shutdown: ctrl_shutdown()?,
        })
    }

    pub async fn next(&mut self) -> Signal {
        tokio::select! {
            _ = self.interrupt.recv() => Signal::Interrupt,
            _ = self.stop.recv() => Signal::Exit,
            _ = self.close.recv() => Signal::Exit,
            _ = self.logoff.recv() => Signal::Exit,
            _ = self.shutdown.recv() => Signal::Exit,
        }
    }
}
