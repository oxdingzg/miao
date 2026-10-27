pub mod app;
pub mod dialogs;
pub mod editor;
pub mod engine;
pub mod event;
pub mod input;
pub mod pane;
pub mod session;
pub mod state;
pub mod terminal;
pub mod theme;
pub mod transport;

use std::error::Error;
use std::path::PathBuf;
use std::time::Duration;

use crate::app::App;
use crate::event::AppEvent;

pub fn run(
    workspace: PathBuf,
    db: Option<PathBuf>,
    model: Option<String>,
) -> Result<(), Box<dyn Error>> {
    let loaded = theme::load(&workspace);
    for warning in &loaded.warnings {
        eprintln!("miao-tui: {warning}");
    }
    let mut app = App::new(workspace.clone(), loaded.theme);
    let mut terminal = terminal::init().inspect_err(|_| terminal::restore())?;
    terminal::install_panic_hook();
    let (bus, mut events) = event::bus();
    input::spawn(bus.clone());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(drive(
        &mut terminal,
        &mut app,
        &mut events,
        bus,
        &workspace,
        db,
        model,
    ));
    terminal::restore();
    result
}

async fn drive(
    terminal: &mut terminal::Tui,
    app: &mut App,
    events: &mut event::Rx,
    bus: event::Bus,
    workspace: &std::path::Path,
    db: Option<PathBuf>,
    model: Option<String>,
) -> Result<(), Box<dyn Error>> {
    match engine::settings(workspace, db, model) {
        Ok(settings) => match engine::attach(&settings, bus) {
            Ok(handle) => app.attach_engine(handle),
            Err(message) => app.handle(AppEvent::EngineFailure(message)),
        },
        Err(message) => app.handle(AppEvent::EngineFailure(message)),
    }
    let mut ticker = tokio::time::interval(Duration::from_millis(100));
    loop {
        terminal.draw(|frame| app.render(frame))?;
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
