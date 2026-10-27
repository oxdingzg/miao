use std::thread;

use crate::event::{self, Bus};

pub fn spawn(bus: Bus) {
    thread::spawn(move || loop {
        match crossterm::event::read() {
            Ok(raw) => bus.send(event::from_terminal(raw)),
            Err(_) => return,
        }
    });
}
