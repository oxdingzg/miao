//! Wheel scroll speed and acceleration.
//!
//! The TypeScript host exposes two keys in `tui.json`: `scroll_speed` (rows per
//! wheel notch) and `scroll_acceleration` (`{ "enabled": bool }`). This mirrors
//! them so a configuration written for one host behaves the same on the other:
//! the speed is the rows one notch moves, and acceleration multiplies it for
//! notches that arrive in a burst, the way a trackpad fling does.

use std::time::{Duration, Instant};

/// Notches closer together than this count as a burst.
const ACCEL_WINDOW: Duration = Duration::from_millis(120);

/// The burst multiplier stops here so a held wheel cannot jump a whole Session.
const ACCEL_MAX_STREAK: u16 = 5;

/// A speed above this is a typo, not a preference.
const MAX_SPEED_ROWS: f64 = 100.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Scroll {
    speed: f64,
    acceleration: bool,
    /// When the last notch was handled, for the burst window.
    last: Option<Instant>,
    /// Notches in the current burst, counting the one that started it.
    streak: u16,
    /// `1` for down, `-1` for up: reversing the wheel starts a new burst.
    direction: i8,
}

impl Default for Scroll {
    fn default() -> Self {
        Self::new(3.0, false)
    }
}

impl Scroll {
    pub fn new(speed: f64, acceleration: bool) -> Self {
        Self {
            speed,
            acceleration,
            last: None,
            streak: 1,
            direction: 0,
        }
    }

    /// Rows one notch moves the transcript at `now`, given the wheel direction.
    /// Unaccelerated scrolling returns the configured speed every time.
    pub fn rows(&mut self, now: Instant, direction: i8) -> u16 {
        let base = self.speed.round().clamp(1.0, MAX_SPEED_ROWS) as u16;
        let burst = self
            .last
            .is_some_and(|last| now.duration_since(last) <= ACCEL_WINDOW)
            && self.direction == direction;
        self.last = Some(now);
        self.direction = direction;
        if !self.acceleration {
            return base;
        }
        // Reversing the wheel or pausing ends the burst, so the next notch
        // starts again at the configured speed.
        self.streak = if burst {
            (self.streak + 1).min(ACCEL_MAX_STREAK)
        } else {
            1
        };
        base.saturating_mul(self.streak)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(base: Instant, millis: u64) -> Instant {
        base + Duration::from_millis(millis)
    }

    #[test]
    fn an_unaccelerated_wheel_moves_the_configured_rows_every_time() {
        let mut scroll = Scroll::default();
        let base = Instant::now();
        assert_eq!(scroll.rows(base, 1), 3, "the documented default");
        assert_eq!(
            scroll.rows(at(base, 10), 1),
            3,
            "notches in a burst do not grow without acceleration enabled"
        );
    }

    #[test]
    fn the_configured_speed_replaces_the_default_step() {
        let base = Instant::now();
        assert_eq!(Scroll::new(1.0, false).rows(base, 1), 1);
        assert_eq!(Scroll::new(6.0, false).rows(base, 1), 6);
        assert_eq!(
            Scroll::new(0.4, false).rows(base, 1),
            1,
            "a fraction of a row still has to move something"
        );
        assert_eq!(
            Scroll::new(1000.0, false).rows(base, 1),
            100,
            "an absurd speed is capped instead of jumping the whole transcript"
        );
    }

    #[test]
    fn acceleration_grows_inside_a_burst_and_stops_at_the_cap() {
        let mut scroll = Scroll::new(3.0, true);
        let base = Instant::now();
        assert_eq!(scroll.rows(base, 1), 3, "the first notch uses the speed");
        assert_eq!(scroll.rows(at(base, 50), 1), 6);
        assert_eq!(scroll.rows(at(base, 100), 1), 9);
        assert_eq!(scroll.rows(at(base, 150), 1), 12);
        assert_eq!(
            scroll.rows(at(base, 200), 1),
            15,
            "the fifth notch is the last one that grows"
        );
        assert_eq!(
            scroll.rows(at(base, 250), 1),
            15,
            "a held wheel stays capped"
        );
    }

    #[test]
    fn a_pause_or_a_reversal_starts_the_burst_over() {
        let mut scroll = Scroll::new(3.0, true);
        let base = Instant::now();
        scroll.rows(base, 1);
        assert_eq!(scroll.rows(at(base, 50), 1), 6);
        assert_eq!(
            scroll.rows(at(base, 400), 1),
            3,
            "a notch after the window starts again at the configured speed"
        );
        assert_eq!(
            scroll.rows(at(base, 420), -1),
            3,
            "reversing the wheel is not the same burst"
        );
        assert_eq!(scroll.rows(at(base, 440), -1), 6);
    }
}
