use std::io;
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::thread;
use std::time::Duration;

use crate::event::{self, Bus};

pub struct Input {
    pause: Sender<(SyncSender<()>, Receiver<()>)>,
}

pub struct Paused {
    resume: Sender<()>,
}

impl Input {
    /// Acknowledge only after the reader has left crossterm. The editor must
    /// have exclusive stdin ownership before cooked mode is restored.
    pub fn pause(&self) -> io::Result<Paused> {
        let (acknowledge, acknowledged) = mpsc::sync_channel(0);
        let (resume, resumed) = mpsc::channel();
        self.pause
            .send((acknowledge, resumed))
            .map_err(|_| io::Error::other("terminal input reader stopped"))?;
        acknowledged
            .recv()
            .map_err(|_| io::Error::other("terminal input reader stopped"))?;
        Ok(Paused { resume })
    }
}

impl Drop for Paused {
    fn drop(&mut self) {
        let _ = self.resume.send(());
    }
}

pub fn spawn(bus: Bus) -> Input {
    let (pause, requests) = mpsc::channel::<(SyncSender<()>, Receiver<()>)>();
    thread::spawn(move || loop {
        match requests.try_recv() {
            Ok((acknowledge, resumed)) => {
                if acknowledge.send(()).is_err() || resumed.recv().is_err() {
                    return;
                }
            }
            Err(mpsc::TryRecvError::Disconnected) => return,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        match crossterm::event::poll(Duration::from_millis(50)) {
            Ok(false) => continue,
            Err(_) => return,
            Ok(true) => match crossterm::event::read() {
                Ok(raw) => {
                    if let Some(event) = event::from_terminal(raw) {
                        bus.send(event);
                    }
                }
                Err(_) => return,
            },
        }
    });
    Input { pause }
}
