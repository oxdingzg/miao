//! The landing banner: the cat beside the solid-block MIAO wordmark.
//!
//! The art, the gaps and the five warm inks mirror `packages/tui/src/logo.ts`,
//! the product home's banner, so both homes draw one mark: a coral cat and a
//! ramp across M, I, A and O. Its idle light is that file's `shimmerConfig`,
//! reduced to what a cell renderer needs: two rings leaving the mark's upper
//! left, lifting each letter toward the theme's primary and then toward white,
//! with the ambient breath between them.

use std::f64::consts::PI;
use std::time::Duration;

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::theme::Theme;

/// How often the idle light paints. The product animates the same sweep at a
/// fraction of its interaction frame rate; sixty-millisecond steps would put a
/// repaint every few milliseconds on a home screen nobody is touching.
pub const FRAME: Duration = Duration::from_millis(80);

/// How long a home screen nobody touches keeps sweeping before it rests. The
/// product's logo rests after the same stretch.
pub const REST: Duration = Duration::from_secs(20);

/// The cat: five rows, the drawing on the middle three.
const CAT: [&str; 5] = ["       ", " /\\/\\  ", "( o.o )", " > ^ < ", "       "];

/// The wordmark, one row per entry with the four letters M, I, A and O.
const WORDMARK: [[&str; 4]; 5] = [
    ["█   █", "█", " ███ ", "█████"],
    ["██ ██", "█", "█   █", "█   █"],
    ["█ █ █", "█", "█████", "█   █"],
    ["█   █", "█", "█   █", "█   █"],
    ["█   █", "█", "█   █", "█████"],
];

/// Columns between the cat and the wordmark, and between two letters. The
/// product's banner keeps one for the cat and two for the letters.
const GAP: usize = 1;
const LETTER_GAP: usize = 2;

/// The banner's inks: the cat, then M, I, A and O. The same five warm steps the
/// product's exit epilogue and installer use.
const INKS: [Color; 5] = [
    Color::Rgb(255, 135, 135),
    Color::Rgb(255, 135, 95),
    Color::Rgb(255, 175, 95),
    Color::Rgb(255, 215, 95),
    Color::Rgb(255, 255, 0),
];

const WHITE: Color = Color::Rgb(255, 255, 255);

const PERIOD_MS: f64 = 4_600.0;
const RINGS: usize = 2;
const ORIGIN_X: f64 = 4.5;
const ORIGIN_Y: f64 = 13.5;
const CORE_WIDTH: f64 = 1.2;
const CORE_AMP: f64 = 1.9;
const SOFT_WIDTH: f64 = 10.0;
const SOFT_AMP: f64 = 1.6;
const TAIL: f64 = 5.0;
const TAIL_AMP: f64 = 0.64;
const HALO_WIDTH: f64 = 4.3;
const HALO_OFFSET: f64 = 0.6;
const HALO_AMP: f64 = 0.16;
const BREATH_BASE: f64 = 0.04;
const NOISE: f64 = 0.1;
const AMBIENT_AMP: f64 = 0.36;
const AMBIENT_CENTER: f64 = 0.5;
const AMBIENT_WIDTH: f64 = 0.34;
const PRIMARY_MIX: f64 = 0.3;

/// The banner as it is painted: the rows, the ink of every column, and the
/// column the wordmark starts at, which is the half the product sets in bold.
pub struct Banner {
    rows: Vec<String>,
    inks: Vec<Color>,
    split: usize,
}

impl Default for Banner {
    fn default() -> Self {
        Self::new()
    }
}

impl Banner {
    pub fn new() -> Self {
        let split = CAT[0].chars().count();
        let rows = (0..CAT.len())
            .map(|row| {
                format!(
                    "{}{}{}",
                    CAT[row],
                    " ".repeat(GAP),
                    WORDMARK[row].join(&" ".repeat(LETTER_GAP))
                )
            })
            .collect();
        // The cat inks its own columns and the gap between it and the wordmark
        // keeps the cat's ink; every letter then takes the next warm step.
        let mut inks = vec![INKS[0]; split + GAP];
        for (index, letter) in WORDMARK[0].iter().enumerate() {
            inks.extend(std::iter::repeat_n(INKS[index + 1], letter.chars().count()));
            inks.extend(std::iter::repeat_n(INKS[0], LETTER_GAP));
        }
        Self { rows, inks, split }
    }

    pub fn width(&self) -> usize {
        self.rows
            .first()
            .map(|row| row.chars().count())
            .unwrap_or(0)
    }

    pub fn height(&self) -> usize {
        self.rows.len()
    }

    /// One banner row, its columns inked one letter at a time. With `shimmer`
    /// the idle light is sampled at `now_ms`; without it only the inks show, so
    /// a monochrome terminal keeps the shape and loses the decoration.
    pub fn line(&self, row: usize, now_ms: u64, shimmer: bool, theme: &Theme) -> Line<'static> {
        let Some(text) = self.rows.get(row) else {
            return Line::default();
        };
        // A terminal without colour keeps the art and loses the inks: the
        // palette's own foreground carries the shape, so nothing on screen
        // claims a hue the terminal cannot show.
        let colourful = matches!(theme.palette.primary, Color::Rgb(..));
        let light = (shimmer && colourful).then(|| Sweep::at(now_ms, self.width(), self.height()));
        let mut spans: Vec<Span<'static>> = Vec::new();
        let mut run = String::new();
        let mut run_style = Style::new();
        for (x, symbol) in text.chars().enumerate() {
            let ink = match colourful {
                true => self.inks.get(x).copied().unwrap_or(INKS[0]),
                false => theme.palette.primary,
            };
            let ink = match &light {
                Some(sweep) => sweep.ink(x, row, ink, theme.palette.primary),
                None => ink,
            };
            let style = match x >= self.split {
                // The product bolds the wordmark and leaves the cat plain.
                true => Style::new().fg(ink).add_modifier(Modifier::BOLD),
                false => Style::new().fg(ink),
            };
            if style != run_style && !run.is_empty() {
                spans.push(Span::styled(std::mem::take(&mut run), run_style));
            }
            run_style = style;
            run.push(symbol);
        }
        if !run.is_empty() {
            spans.push(Span::styled(run, run_style));
        }
        Line::from(spans)
    }
}

/// One ring of the sweep: how far it has travelled, how bright it is, and the
/// ambient breath the innermost part of the cycle adds.
struct Ring {
    head: f64,
    eased: f64,
    ambient: f64,
}

/// The light sampled for one banner, at one instant.
struct Sweep {
    t: f64,
    rings: Vec<Ring>,
}

impl Sweep {
    fn at(now_ms: u64, width: usize, height: usize) -> Self {
        let reach = [
            (0.0, 0.0),
            (width as f64, 0.0),
            (0.0, height as f64 * 2.0),
            (width as f64, height as f64 * 2.0),
        ]
        .into_iter()
        .map(|(x, y)| ((x - ORIGIN_X).powi(2) + (y - ORIGIN_Y).powi(2)).sqrt())
        .fold(0.0, f64::max)
            + TAIL * 2.0;
        let t = now_ms as f64;
        let rings = (0..RINGS)
            .map(|index| {
                let phase = (t / PERIOD_MS + index as f64 / RINGS as f64) % 1.0;
                let envelope = (phase * PI).sin();
                let d = (phase - AMBIENT_CENTER) / AMBIENT_WIDTH;
                Ring {
                    head: phase * reach,
                    eased: envelope * envelope * (3.0 - 2.0 * envelope),
                    ambient: match d.abs() < 1.0 {
                        true => (1.0 - d * d).powi(2) * AMBIENT_AMP,
                        false => 0.0,
                    },
                }
            })
            .collect();
        Self { t, rings }
    }

    /// The letter's ink under the sweep: first toward the theme's primary, then
    /// toward white, so the bright core stays white while the halo pulls the
    /// ink toward the palette.
    fn ink(&self, x: usize, y: usize, ink: Color, primary: Color) -> Color {
        let (glow, peak, pull) = self.sample(x, y);
        let ink = match pull > 0.0 {
            true => tint(ink, primary, pull.min(1.0)),
            false => ink,
        };
        let _ = glow;
        match peak > 0.0 {
            true => tint(ink, WHITE, peak.min(1.0)),
            false => ink,
        }
    }

    /// How bright the sweep is at one cell: the soft wake, the core's peak, and
    /// the share that pulls the ink toward the palette.
    fn sample(&self, x: usize, y: usize) -> (f64, f64, f64) {
        let pixel = y as f64 * 2.0 + 1.0;
        let wobble = (noise(x as f64 * 0.32, pixel * 0.25, self.t * 0.0005) - 0.5) * 0.55
            + (noise(x as f64 * 0.12, pixel * 0.08, self.t * 0.00022) - 0.5) * 0.32;
        let travelled = ((x as f64 + 0.5 - ORIGIN_X).powi(2) + (pixel - ORIGIN_Y).powi(2)).sqrt()
            + wobble * NOISE;
        let rings = self.rings.len().max(1) as f64;
        let (mut glow, mut peak, mut halo, mut pull, mut ambient) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for ring in &self.rings {
            let delta = travelled - ring.head;
            let soft = (-(delta / SOFT_WIDTH).abs().powf(1.6)).exp();
            let tail_range = TAIL * 2.6;
            let tail = match delta < 0.0 && delta > -tail_range {
                true => (1.0 + delta / tail_range).powf(2.6),
                false => 0.0,
            };
            let halo_band = (-((delta + HALO_OFFSET) / HALO_WIDTH).abs().powf(1.6)).exp();
            glow += (soft * SOFT_AMP + tail * TAIL_AMP) * ring.eased;
            peak += (-(delta / CORE_WIDTH).abs().powf(1.8)).exp() * CORE_AMP * ring.eased;
            halo += halo_band * HALO_AMP * ring.eased;
            pull += (halo_band + tail * 0.6) * ring.eased;
            ambient += ring.ambient;
        }
        (
            glow / rings,
            BREATH_BASE + ambient / rings + (peak + halo) / rings,
            (pull / rings) * PRIMARY_MIX,
        )
    }
}

/// Blend `base` toward `target`. A palette colour that is not an RGB triple
/// (a reset terminal, an indexed theme) leaves the ink alone instead of
/// inventing a colour, so a monochrome banner stays monochrome.
fn tint(base: Color, target: Color, t: f64) -> Color {
    let (Color::Rgb(br, bg, bb), Color::Rgb(tr, tg, tb)) = (base, target) else {
        return base;
    };
    let t = t.clamp(0.0, 1.0);
    Color::Rgb(
        (br as f64 + (tr as f64 - br as f64) * t).round() as u8,
        (bg as f64 + (tg as f64 - bg as f64) * t).round() as u8,
        (bb as f64 + (tb as f64 - bb as f64) * t).round() as u8,
    )
}

fn noise(x: f64, y: f64, t: f64) -> f64 {
    let n = (x * 12.9898 + y * 78.233 + t * 0.043).sin() * 43_758.545_3;
    n - n.floor()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme() -> Theme {
        Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME).expect("theme"),
        }
    }

    fn ink_at(line: &Line<'static>, x: usize) -> (char, Color) {
        let mut at = 0;
        for span in &line.spans {
            for symbol in span.content.chars() {
                if at == x {
                    return (symbol, span.style.fg.unwrap_or(Color::Reset));
                }
                at += 1;
            }
        }
        (' ', Color::Reset)
    }

    /// The banner is the product's art: cat, one column, then the joined
    /// wordmark, and the whole mark is thirty columns wide and five rows tall.
    #[test]
    fn the_banner_is_the_product_art() {
        let banner = Banner::new();
        assert_eq!(banner.width(), 30);
        assert_eq!(banner.height(), 5);
        let rows = (0..banner.height())
            .map(|row| {
                banner
                    .line(row, 0, false, &theme())
                    .spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();
        // The cat's row and the wordmark's row of the same index, so the cat
        // stands beside the letters rather than above them.
        assert_eq!(rows[1], " /\\/\\   ██ ██  █  █   █  █   █");
        assert_eq!(rows[2], "( o.o ) █ █ █  █  █████  █   █");
        assert_eq!(rows[4], "        █   █  █  █   █  █████");
    }

    /// Every letter carries its own ink, in the warm ramp the product uses,
    /// and the wordmark is bold while the cat is not.
    #[test]
    fn each_letter_keeps_its_own_ink() {
        let banner = Banner::new();
        let line = banner.line(2, 0, false, &theme());
        assert_eq!(ink_at(&line, 0).1, INKS[0], "the cat is coral");
        assert_eq!(ink_at(&line, 8).1, INKS[1], "M");
        assert_eq!(ink_at(&line, 15).1, INKS[2], "I");
        assert_eq!(ink_at(&line, 18).1, INKS[3], "A");
        assert_eq!(ink_at(&line, 25).1, INKS[4], "O");
        let bold = line
            .spans
            .iter()
            .filter(|span| span.style.add_modifier.contains(Modifier::BOLD))
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(bold.contains('█'), "the wordmark is bold: {bold:?}");
        assert!(!bold.contains('/'), "the cat is not bold: {bold:?}");
    }

    /// The idle light moves: the brightest cell a quarter of the cycle later is
    /// a different one, which is what makes the mark look alive instead of
    /// tinted once.
    #[test]
    fn the_idle_light_sweeps() {
        let banner = Banner::new();
        let theme = theme();
        let brightest = |line: &Line<'static>| {
            (0..banner.width())
                .filter_map(|x| match ink_at(line, x) {
                    (symbol, Color::Rgb(r, g, b)) if symbol != ' ' => {
                        Some((r as u32 + g as u32 + b as u32, x))
                    }
                    _ => None,
                })
                .max()
                .map(|(_, x)| x)
        };
        let first = banner.line(2, 0, true, &theme);
        let later = banner.line(2, PERIOD_MS as u64 / 4, true, &theme);
        assert_ne!(
            brightest(&first),
            brightest(&later),
            "the light stands still between two frames"
        );
        assert_ne!(first, later, "no cell changed inside a quarter cycle");
    }

    /// A terminal without colour keeps the art and drops the light: every cell
    /// carries no colour instead of a tinted one.
    #[test]
    fn a_monochrome_theme_paints_no_light() {
        let monochrome = Theme {
            name: crate::theme::DEFAULT_THEME.to_string(),
            palette: crate::theme::builtin(crate::theme::DEFAULT_THEME)
                .expect("theme")
                .monochrome(),
        };
        let banner = Banner::new();
        let line = banner.line(2, 1_200, true, &monochrome);
        for span in &line.spans {
            assert_eq!(span.style.fg, Some(Color::Reset), "{:?}", span.content);
        }
    }
}
