pub mod app;
pub mod event;
pub mod input;
pub mod pane;
pub mod terminal;
pub mod theme;
pub mod transport;

use std::error::Error;
use std::path::PathBuf;
use std::time::Duration;

use crate::app::App;

pub fn run(workspace: PathBuf) -> Result<(), Box<dyn Error>> {
    let loaded = theme::load(&workspace);
    for warning in &loaded.warnings {
        eprintln!("miao-tui: {warning}");
    }
    let mut app = App::new(workspace, loaded.theme);
    let mut terminal = terminal::init().inspect_err(|_| terminal::restore())?;
    terminal::install_panic_hook();
    let (bus, mut events) = event::bus();
    input::spawn(bus);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(drive(&mut terminal, &mut app, &mut events));
    terminal::restore();
    result
}

async fn drive(
    terminal: &mut terminal::Tui,
    app: &mut App,
    events: &mut event::Rx,
) -> Result<(), Box<dyn Error>> {
    let mut ticker = tokio::time::interval(Duration::from_millis(100));
    loop {
        terminal.draw(|frame| app.shell.render(frame))?;
        if std::env::var_os("MIAO_TUI_TEST_PANIC").is_some() {
            panic!("miao-tui: injected panic (MIAO_TUI_TEST_PANIC)");
        }
        if app.quit {
            return Ok(());
        }
        tokio::select! {
            event = events.recv() => match event {
                Some(app_event) => app.handle(app_event),
                None => return Ok(()),
            },
            _ = ticker.tick() => {}
        }
    }
}
