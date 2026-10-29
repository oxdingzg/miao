//! Register exit signals before entering raw mode, and receive them on the UI loop.
use std::future::Future;
use std::io;

#[cfg(unix)]
pub fn termination() -> io::Result<impl Future<Output = ()>> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut terminate = signal(SignalKind::terminate())?;
    let mut hangup = signal(SignalKind::hangup())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    Ok(async move {
        tokio::select! {
            _ = terminate.recv() => {},
            _ = hangup.recv() => {},
            _ = interrupt.recv() => {},
        }
    })
}

#[cfg(windows)]
pub fn termination() -> io::Result<impl Future<Output = ()>> {
    use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_logoff, ctrl_shutdown};
    let mut interrupt = ctrl_c()?;
    let mut stop = ctrl_break()?;
    let mut close = ctrl_close()?;
    let mut logoff = ctrl_logoff()?;
    let mut shutdown = ctrl_shutdown()?;
    Ok(async move {
        tokio::select! {
            _ = interrupt.recv() => {},
            _ = stop.recv() => {},
            _ = close.recv() => {},
            _ = logoff.recv() => {},
            _ = shutdown.recv() => {},
        }
    })
}
