//! PERF-02 scroll frame-budget harness: the render hot path while scrolling a
//! long transcript.
//!
//! The acceptance for PERF-02 asks for scrolling to be measured against a
//! 16.7 ms frame budget and for over-budget ratios to be reported, rather than
//! inferred from startup screenshots. This harness renders frames off-screen at
//! two history lengths and scrolls through both:
//!
//! * the absolute p50/p95/p99/max per frame and the share of frames over the
//!   budget are printed and written to the workspace as JSON, which is the
//!   evidence;
//! * the assertion is a ratio: a transcript ten times longer must not cost
//!   meaningfully more per frame. That is what viewport windowing means, and it
//!   is far less sensitive to the machine than an absolute deadline in a debug
//!   build.
//!
//! The render goes to `ratatui`'s `TestBackend`, so the measurement covers
//! layout, wrapping, and painting but not the terminal's own write time.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use miao_tui::app::{App, Startup};
use miao_tui::config::AttentionConfig;
use miao_tui::event::AppEvent;
use miao_tui::keybinds::Keymap;
use miao_tui::session::{Entry, Part, SessionState, Transcript};
use miao_tui::theme::{self, Theme, DEFAULT_THEME};

/// One frame at 60 Hz. The gate the evidence is collected against.
const BUDGET: Duration = Duration::from_micros(16_700);

/// Wheel notches per scenario. Enough to walk through the transcript and to
/// amortise the first, cache-filling frame.
const NOTCHES: usize = 60;

/// The short history, and the long one that must not cost more per frame.
const SHORT: usize = 200;
const LONG: usize = 2000;

struct Frame {
    micros: u128,
}

fn main_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("miao-scroll-frames-{label}"));
    std::fs::create_dir_all(&dir).expect("workspace dir");
    dir
}

/// A transcript with both message kinds and a tool call, because a Session of
/// only short user lines would flatter the wrapper.
fn transcript(entries: usize) -> Transcript {
    let mut transcript = Transcript::default();
    for index in 0..entries {
        let seq = index as u64 + 1;
        transcript.entries.push(Entry::User {
            text: format!(
                "message {index}: make the parser report the byte offset it stopped at, \
                 and keep the error text on one line"
            ),
            seq,
        });
        transcript.entries.push(Entry::Assistant {
            agent: None,
            model: None,
            parts: vec![
                Part::Reasoning(
                    "the offset lives in the lexer, so the error has to carry it out".into(),
                ),
                Part::Text(
                    "Done: the parser now names the offset.\n\n```rust\nfn stop(&self) -> usize \
                     { self.at }\n```\n\nThat is the whole change; the tests cover the boundary."
                        .into(),
                ),
            ],
        });
    }
    transcript
}

fn app(label: &str, entries: usize) -> (App, PathBuf) {
    let dir = main_dir(label);
    let palette = theme::builtin(DEFAULT_THEME).expect("default theme is built in");
    let mut app = App::new(
        dir.clone(),
        Theme {
            name: DEFAULT_THEME.to_string(),
            palette,
        },
        theme::Catalog::builtin(),
        Keymap::default(),
        AttentionConfig::default(),
        Startup::default(),
    );
    app.handle(AppEvent::SessionOpened {
        summary: None,
        transcript: Box::new(transcript(entries)),
        state: SessionState::default(),
    });
    (app, dir)
}

/// Scroll `NOTCHES` times through the transcript, timing each frame. The first
/// frame is drawn before the loop so wrapping is not charged to the first
/// measurement.
fn scroll_frames(app: &mut App) -> Vec<Frame> {
    let backend = ratatui::backend::TestBackend::new(120, 40);
    let mut terminal = ratatui::Terminal::new(backend).expect("terminal");
    terminal
        .draw(|frame| app.render(frame))
        .expect("warm frame");
    let wheel = |kind| {
        AppEvent::Mouse(crossterm::event::MouseEvent::new(
            kind,
            0,
            0,
            crossterm::event::KeyModifiers::NONE,
        ))
    };
    let mut frames = Vec::new();
    for _ in 0..NOTCHES {
        app.handle(wheel(crossterm::event::MouseEventKind::ScrollUp));
        let start = Instant::now();
        terminal
            .draw(|frame| app.render(frame))
            .expect("scroll frame");
        frames.push(Frame {
            micros: start.elapsed().as_micros(),
        });
    }
    // An idle harness would measure the same frame repeatedly and pass; the
    // notches have to have moved the transcript off the tail.
    assert!(
        !app.shell.following(),
        "the wheel must scroll the transcript, or these are idle frames"
    );
    frames
}

fn percentile(sorted: &[u128], fraction: f64) -> u128 {
    if sorted.is_empty() {
        return 0;
    }
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn report(dir: &Path, scenario: &str, frames: &[Frame]) -> (u128, u128) {
    let mut micros = frames.iter().map(|frame| frame.micros).collect::<Vec<_>>();
    micros.sort_unstable();
    let budget = BUDGET.as_micros();
    let over = micros.iter().filter(|micros| **micros > budget).count();
    let (p50, p95, p99, max) = (
        percentile(&micros, 0.50),
        percentile(&micros, 0.95),
        percentile(&micros, 0.99),
        micros.last().copied().unwrap_or(0),
    );
    let json = format!(
        "{{\"scenario\":\"{scenario}\",\"frames\":{},\"p50_ms\":{:.2},\"p95_ms\":{:.2},\
         \"p99_ms\":{:.2},\"max_ms\":{:.2},\"budget_ms\":16.70,\"over_budget\":{},\
         \"over_budget_ratio\":{:.3}}}",
        micros.len(),
        p50 as f64 / 1000.0,
        p95 as f64 / 1000.0,
        p99 as f64 / 1000.0,
        max as f64 / 1000.0,
        over,
        over as f64 / micros.len() as f64,
    );
    let path = dir.join(format!("scroll-frames-{scenario}.json"));
    std::fs::write(&path, &json).expect("write scroll report");
    println!("PERF-02 scroll {scenario}: {json}");
    (p50, p95)
}

#[test]
fn scrolling_a_long_transcript_stays_within_the_viewport_budget() {
    // A short history first: it is the baseline the long one is compared to.
    let (mut short, short_dir) = app("short", SHORT);
    let short_frames = scroll_frames(&mut short);
    let (short_p50, short_p95) = report(&short_dir, "short-200", &short_frames);

    let (mut long, long_dir) = app("long", LONG);
    let long_frames = scroll_frames(&mut long);
    let (long_p50, long_p95) = report(&long_dir, "long-2000", &long_frames);

    // Ten times the history must not cost meaningfully more per frame: the
    // renderer paints the viewport, not the transcript. A factor rather than a
    // deadline, because a debug build on a shared runner is slow in absolute
    // terms while the ratio stays meaningful.
    let ratio = long_p95.max(1) as f64 / short_p95.max(1) as f64;
    println!(
        "PERF-02 scroll ratio: p95 {short_p95}µs → {long_p95}µs ({ratio:.2}x), \
         p50 {short_p50}µs → {long_p50}µs"
    );
    assert!(
        ratio <= 3.0,
        "a ten times longer transcript costs {ratio:.2}x per frame (p95 {short_p95}µs → \
         {long_p95}µs); rendering is supposed to follow the viewport, not the history"
    );
}
