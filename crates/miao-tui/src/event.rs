use crossterm::event::Event as TerminalEvent;
use crossterm::event::KeyEvent;

#[derive(Debug)]
pub enum AppEvent {
    Key(KeyEvent),
    Resize { width: u16, height: u16 },
}

#[derive(Clone)]
pub struct Bus {
    tx: tokio::sync::mpsc::UnboundedSender<AppEvent>,
}

impl Bus {
    pub fn send(&self, event: AppEvent) {
        let _ = self.tx.send(event);
    }
}

pub type Rx = tokio::sync::mpsc::UnboundedReceiver<AppEvent>;

pub fn bus() -> (Bus, Rx) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    (Bus { tx }, rx)
}

pub fn from_terminal(event: TerminalEvent) -> Option<AppEvent> {
    match event {
        TerminalEvent::Key(key) => Some(AppEvent::Key(key)),
        TerminalEvent::Resize(width, height) => Some(AppEvent::Resize { width, height }),
        _ => None,
    }
}
