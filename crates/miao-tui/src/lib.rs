pub mod app;
pub mod commands;
pub mod config;
pub mod dialogs;
pub mod editor;
pub mod engine;
pub mod event;
pub mod highlight;
pub mod input;
pub mod keybinds;
pub mod markdown;
pub mod pane;
pub mod platform;
pub mod session;
pub mod state;
pub mod status;
pub mod terminal;
pub mod theme;
pub mod tool;
pub mod transport;

use std::error::Error;
use std::path::PathBuf;
use std::time::Duration;

use crate::app::{App, Startup};
use crate::event::AppEvent;

/// What the process was asked to open at launch. Every field is optional; the
/// TypeScript CLI fills them from `--session`, `--continue`, and `--prompt`.
#[derive(Debug, Clone, Default)]
pub struct Launch {
    pub workspace: PathBuf,
    pub db: Option<PathBuf>,
    pub model: Option<String>,
    /// The product's configuration directory, forwarded to the engine as
    /// `--config-dir` so policy and LSP derivation match the TS host.
    pub config_dir: Option<PathBuf>,
    pub session: Option<String>,
    pub continue_last: bool,
    pub prompt: Option<String>,
}

pub fn run(launch: Launch) -> Result<(), Box<dyn Error>> {
    let workspace = launch.workspace.clone();
    let loaded = theme::load(&workspace);
    for warning in &loaded.warnings {
        eprintln!("miao-tui: {warning}");
    }
    let (config, warnings) = config::load(&workspace);
    for warning in &warnings {
        eprintln!("miao-tui: {warning}");
    }
    let startup = Startup {
        session: launch.session.clone(),
        continue_last: launch.continue_last,
        prompt: launch.prompt.clone(),
    };
    let mut app = App::new(
        workspace.clone(),
        loaded.theme,
        loaded.catalog,
        keybinds::Keymap::from_overrides(&config.keybinds),
        config.attention,
        startup,
    );
    let preferences = terminal::Preferences {
        mouse: config.mouse,
        cursor: config.cursor,
    };
    let mut terminal = terminal::init(preferences).inspect_err(|_| terminal::restore())?;
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
        launch,
        preferences,
    ));
    terminal::restore();
    result
}

async fn drive(
    terminal: &mut terminal::Tui,
    app: &mut App,
    events: &mut event::Rx,
    bus: event::Bus,
    launch: Launch,
    preferences: terminal::Preferences,
) -> Result<(), Box<dyn Error>> {
    match engine::settings(
        &launch.workspace,
        launch.db,
        launch.model,
        launch.config_dir,
    ) {
        Ok(settings) => {
            app.set_settings(settings.clone());
            match engine::attach(&settings, bus.clone()) {
                Ok(handle) => app.attach_engine(handle),
                Err(message) => app.handle(AppEvent::EngineFailure(message)),
            }
        }
        Err(message) => app.handle(AppEvent::EngineFailure(message)),
    }
    app.set_bus(bus.clone());
    app.start();
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
                Some(app_event) => {
                    app.handle(app_event);
                    if let Some(request) = app.take_editor_request() {
                        terminal::suspend();
                        let result = platform::editor::run(&request);
                        terminal::resume(terminal, preferences)?;
                        app.handle(AppEvent::EditorFinished(result));
                    }
                }
                None => return Ok(()),
            },
            _ = ticker.tick() => {}
        }
    }
}
