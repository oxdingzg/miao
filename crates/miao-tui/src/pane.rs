use std::path::Path;

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Paragraph};
use ratatui::Frame;

use crate::theme::Theme;

const SIDEBAR_MIN_WIDTH: u16 = 100;
const SIDEBAR_WIDTH: u16 = 24;

pub trait Pane {
    fn render(&mut self, frame: &mut Frame, area: Rect);
}

pub struct Shell {
    pub title: TitlePane,
    pub transcript: TranscriptPane,
    pub composer: ComposerPane,
    pub sidebar: Option<SidebarPane>,
}

impl Shell {
    pub fn new(workspace: &Path, theme: Theme) -> Self {
        Self {
            title: TitlePane::new(workspace, theme.clone()),
            transcript: TranscriptPane {
                theme: theme.clone(),
            },
            composer: ComposerPane {
                input: String::new(),
                theme: theme.clone(),
            },
            sidebar: Some(SidebarPane { theme }),
        }
    }

    pub fn render(&mut self, frame: &mut Frame) {
        let [title_area, body_area, composer_area] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(3),
        ])
        .areas(frame.area());
        self.title.render(frame, title_area);
        if body_area.width >= SIDEBAR_MIN_WIDTH {
            let [transcript_area, sidebar_area] =
                Layout::horizontal([Constraint::Min(1), Constraint::Length(SIDEBAR_WIDTH)])
                    .areas(body_area);
            self.transcript.render(frame, transcript_area);
            if let Some(sidebar) = self.sidebar.as_mut() {
                sidebar.render(frame, sidebar_area);
            }
        } else {
            self.transcript.render(frame, body_area);
        }
        self.composer.render(frame, composer_area);
    }
}

pub struct TitlePane {
    label: String,
    theme: Theme,
}

impl TitlePane {
    fn new(workspace: &Path, theme: Theme) -> Self {
        let name = workspace
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| workspace.display().to_string());
        Self {
            label: format!(" miao-tui · {name} · {} ", git_branch(workspace)),
            theme,
        }
    }
}

fn git_branch(workspace: &Path) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(workspace)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|| "no git".to_string())
}

impl Pane for TitlePane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let style = Style::new()
            .fg(self.theme.palette.primary)
            .bg(self.theme.palette.surface)
            .bold();
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(self.label.as_str(), style))),
            area,
        );
    }
}

pub struct TranscriptPane {
    theme: Theme,
}

impl Pane for TranscriptPane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        let block = Block::bordered()
            .title(Span::styled(
                " transcript ",
                Style::new().fg(palette.primary),
            ))
            .border_style(Style::new().fg(palette.border))
            .style(Style::new().bg(palette.background));
        frame.render_widget(
            Paragraph::new("awaiting engine transport (T2); transcript rendering lands in T3")
                .style(Style::new().fg(palette.text_muted))
                .block(block),
            area,
        );
    }
}

pub struct ComposerPane {
    pub input: String,
    theme: Theme,
}

impl Pane for ComposerPane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        let block = Block::bordered()
            .title(Span::styled(" composer ", Style::new().fg(palette.primary)))
            .border_style(Style::new().fg(palette.border))
            .style(Style::new().bg(palette.background));
        frame.render_widget(
            Paragraph::new(format!("> {}", self.input))
                .style(Style::new().fg(palette.text))
                .block(block),
            area,
        );
    }
}

pub struct SidebarPane {
    theme: Theme,
}

impl Pane for SidebarPane {
    fn render(&mut self, frame: &mut Frame, area: Rect) {
        let palette = self.theme.palette;
        let block = Block::bordered()
            .title(Span::styled(" sidebar ", Style::new().fg(palette.primary)))
            .border_style(Style::new().fg(palette.border))
            .style(Style::new().bg(palette.background));
        frame.render_widget(
            Paragraph::new("session info lands in T3+")
                .style(Style::new().fg(palette.text_muted))
                .block(block),
            area,
        );
    }
}
