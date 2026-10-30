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
pub mod saved_permissions;
pub mod session;
pub mod state;
pub mod status;
pub mod terminal;
pub mod terminal_title;
pub mod theme;
pub mod tool;
pub mod transport;
pub mod workspace_changes;

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
    app.configure_terminal_title(
        state::preferences().terminal_title_enabled.unwrap_or(true),
        !std::env::var("MIAO_DISABLE_TERMINAL_TITLE")
            .is_ok_and(|value| value == "1" || value.eq_ignore_ascii_case("true")),
    );
    let preferences = terminal::Preferences {
        mouse: config.mouse,
        cursor: config.cursor,
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let termination = {
        let _entered = runtime.enter();
        platform::signals::Signals::new()?
    };
    let _restore = terminal::RestoreGuard;
    let mut terminal = terminal::init(preferences)?;
    terminal::install_panic_hook();
    let (bus, mut events) = event::bus();
    runtime.block_on(drive(
        &mut terminal,
        &mut app,
        &mut events,
        bus,
        launch,
        preferences,
        termination,
    ))
}

async fn drive(
    terminal: &mut terminal::Tui,
    app: &mut App,
    events: &mut event::Rx,
    bus: event::Bus,
    launch: Launch,
    preferences: terminal::Preferences,
    mut termination: platform::signals::Signals,
) -> Result<(), Box<dyn Error>> {
    match engine::settings(
        &launch.workspace,
        launch.db,
        launch.model,
        launch.config_dir,
    ) {
        Ok(settings) => {
            app.set_settings(settings.clone());
            if let Some(notice) = engine::unrouted_notice(
                &settings.spawn.args,
                &settings.model,
                std::env::var_os("MIAO_ENGINE_REAL_BIN").is_some(),
            ) {
                app.warn(&notice);
            }
            match engine::attach(&settings, bus.clone()) {
                Ok(handle) => app.attach_engine(handle),
                Err(message) => app.handle(AppEvent::EngineFailure(message)),
            }
        }
        Err(message) => app.handle(AppEvent::EngineFailure(message)),
    }
    app.set_bus(bus.clone());
    let input = input::spawn(bus);
    app.start();
    let mut title = terminal_title::Title::new(std::io::stdout());
    loop {
        title.update(app.terminal_title().as_deref())?;
        terminal.draw(|frame| app.render(frame))?;
        if std::env::var_os("MIAO_TUI_TEST_PANIC").is_some() {
            panic!("miao-tui: injected panic (MIAO_TUI_TEST_PANIC)");
        }
        if app.quit {
            return Ok(());
        }
        // An active run's status counts elapsed time and reports an engine that
        // stopped answering, so it repaints every second. An idle Session changes
        // only by the minute in relative timestamps, and input and engine events
        // repaint immediately. Do not replay clock ticks after an editor.
        let repaint = match app.busy() {
            true => Duration::from_secs(1),
            false => Duration::from_secs(60),
        };
        tokio::select! {
            _ = termination.next() => return Ok(()),
            event = events.recv() => match event {
                Some(app_event) => {
                    if matches!(&app_event, AppEvent::Focus(true) | AppEvent::Resize { .. }) {
                        title.invalidate();
                    }
                    app.handle(app_event);
                    if app.take_redraw_request() {
                        terminal::redraw(terminal)?;
                    }
                    if let Some(request) = app.take_editor_request() {
                        let paused = input.pause()?;
                        terminal::suspend();
                        let editor = platform::editor::run(&request);
                        tokio::pin!(editor);
                        let result = loop {
                            tokio::select! {
                                biased;
                                signal = termination.next() => {
                                    // Cooked Ctrl+C also reaches the foreground
                                    // editor. Let it cancel editing, not the UI.
                                    if signal == platform::signals::Signal::Exit {
                                        return Ok(());
                                    }
                                }
                                result = &mut editor => break result,
                            }
                        };
                        terminal::resume(terminal, preferences)?;
                        drop(paused);
                        app.handle(AppEvent::EditorFinished(result));
                    }
                }
                None => return Ok(()),
            },
            _ = tokio::time::sleep(repaint) => {}
        }
    }
}
