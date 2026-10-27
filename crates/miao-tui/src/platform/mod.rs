//! Host-facing terminal integrations: attention, clipboard, external editor,
//! and editor selections. Each module is independent of ratatui so it can be
//! unit tested without a terminal.

pub mod attention;
pub mod clipboard;
pub mod editor;
pub mod zed;
