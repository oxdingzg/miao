use std::thread;

use crate::event::{self, Bus};

pub fn spawn(bus: Bus) {
    thread::spawn(move || loop {
        match crossterm::event::read() {
            Ok(raw) => {
                if let Some(app_event) = event::from_terminal(raw) {
                    bus.send(app_event);
                }
            }
            Err(_) => return,
        }
    });
}
