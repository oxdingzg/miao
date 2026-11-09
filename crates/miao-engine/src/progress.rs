//! Lossless fan-out for ephemeral progress frames.
//!
//! Progress frames are one per streamed delta, and a delta has no durable
//! cursor: the committed journal holds the turn, not the text that is still
//! arriving. A transport that loses a delta therefore has nothing to replay,
//! and a reader that re-projects from the snapshot gets a message that starts
//! part-way through — the transcript that "piled up as one block" with its head
//! missing.
//!
//! `tokio::sync::broadcast` cannot carry that guarantee: it keeps one ring per
//! receiver and drops the oldest entry when the ring fills, reporting `Lagged`
//! only after the values are gone. Sizing the ring larger moves the cliff
//! without removing it, because the number of deltas in a turn is set by the
//! provider's chunking, not by anything the engine bounds.
//!
//! This type gives every subscriber its own unbounded queue instead. A send
//! never drops a frame and never blocks the provider turn, which is the pair of
//! properties the old channel could only trade against each other.
//!
//! The cost is that an abandoned queue grows until its receiver is dropped.
//! That is bounded in practice: every in-process reader does nothing but drain
//! (the TUI moves the receiver onto a task that has no other work), and a
//! disconnected HTTP client closes its stream, which drops the receiver and
//! prunes it here on the next send.

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// One reader's queue. Dropping it is how a reader leaves.
pub type Subscriber = mpsc::UnboundedReceiver<Value>;

/// Queue depth at which one subscriber is reported backpressured. The queue
/// is lossless by design, so nothing errors and nothing drops: the depth
/// itself is the only observable sign that a reader has stopped keeping up.
pub const BACKPRESSURE_QUEUED_FRAMES: usize = 256;

/// Depth a reported subscriber drains to before its backlog is reported
/// clear. The gap to `BACKPRESSURE_QUEUED_FRAMES` is hysteresis, so a reader
/// hovering at the threshold does not flap the signal.
pub const BACKPRESSURE_CLEARED_FRAMES: usize = 32;

/// One subscriber's queue plus whether its backlog has been reported. The flag
/// turns the per-send depth check into rising and falling edges, so an
/// episode is signalled once instead of once per frame.
struct Peer {
    queue: mpsc::UnboundedSender<Value>,
    lagged: bool,
}

/// The rising and falling edge of one subscriber's backlog: `Some(true)` when
/// the queue has grown to the reported depth, `Some(false)` when it drained
/// past the clear mark, `None` while nothing changed.
pub fn backpressure_edge(lagged: bool, queued: usize) -> Option<bool> {
    if !lagged && queued >= BACKPRESSURE_QUEUED_FRAMES {
        return Some(true);
    }
    if lagged && queued <= BACKPRESSURE_CLEARED_FRAMES {
        return Some(false);
    }
    None
}

/// The signal frame for one subscriber's backlog. It inherits the triggering
/// frame's `session_id`, because both transports gate progress by session: a
/// signal without one would be dropped before any client could name it.
pub fn backpressure_frame(source: &Value, queued: usize, cleared: bool) -> Value {
    let mut frame = json!({
        "kind": "backpressure",
        "queued": queued,
        "cleared": cleared,
    });
    if let Some(session_id) = source.get("session_id") {
        frame["session_id"] = session_id.clone();
    }
    frame
}

/// A set of subscriber queues that a producer publishes to.
#[derive(Clone, Default)]
pub struct Fanout {
    subscribers: Arc<Mutex<Vec<Peer>>>,
}

impl Fanout {
    /// Queue one frame for every current subscriber.
    ///
    /// Subscribers that have gone away are pruned here rather than left to
    /// accumulate, so an abandoned reader costs its own queue and nothing more.
    /// A subscriber whose queue has backed up is also signalled on this same
    /// channel. The signal goes to that subscriber alone — the others are
    /// keeping up — and lands behind what already backs it up, which is where
    /// a slow reader finds the reason.
    pub fn send(&self, frame: Value) {
        let mut subscribers = self
            .subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        subscribers.retain(|peer| peer.queue.send(frame.clone()).is_ok());
        for peer in subscribers.iter_mut() {
            let queued = peer.queue.len();
            if let Some(lagged) = backpressure_edge(peer.lagged, queued) {
                peer.lagged = lagged;
                let _ = peer.queue.send(backpressure_frame(&frame, queued, !lagged));
            }
        }
    }

    /// Join the fan-out. Frames published before this call are not delivered;
    /// a reader that needs state that predates it re-projects from the store.
    pub fn subscribe(&self) -> Subscriber {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut subscribers = self
            .subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        subscribers.retain(|peer| !peer.queue.is_closed());
        subscribers.push(Peer {
            queue: sender,
            lagged: false,
        });
        receiver
    }

    /// How many readers are attached, so a producer can skip work nobody reads.
    pub fn receiver_count(&self) -> usize {
        let subscribers = self
            .subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        subscribers
            .iter()
            .filter(|peer| !peer.queue.is_closed())
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        backpressure_edge, Fanout, BACKPRESSURE_CLEARED_FRAMES, BACKPRESSURE_QUEUED_FRAMES,
    };
    use serde_json::json;

    /// The failure this type exists to remove: `broadcast` keeps a fixed ring
    /// per reader and drops the oldest frame once a reader falls behind, so a
    /// reader that stalled through a long answer received only its tail.
    /// Publishing more frames than the old ring held must still deliver every
    /// one of them, in order — plus the one backlog report the stall earns.
    #[test]
    fn a_stalled_subscriber_receives_every_frame() {
        let fanout = Fanout::default();
        let mut stalled = fanout.subscribe();
        for index in 0..40_000u64 {
            fanout.send(json!({ "index": index }));
        }
        let mut expected = 0u64;
        let mut signals = 0;
        while let Ok(frame) = stalled.try_recv() {
            // A deep stall crosses the reported depth mid-stream, and the
            // report rides the same queue it describes.
            if frame["kind"] == "backpressure" {
                signals += 1;
                assert_eq!(frame["queued"], json!(BACKPRESSURE_QUEUED_FRAMES));
                continue;
            }
            assert_eq!(frame["index"], json!(expected), "frames keep their order");
            expected += 1;
        }
        assert_eq!(expected, 40_000, "every frame has to arrive");
        assert_eq!(signals, 1, "one stall, one report");
    }

    #[test]
    fn every_subscriber_gets_its_own_copy() {
        let fanout = Fanout::default();
        let mut first = fanout.subscribe();
        let mut second = fanout.subscribe();
        fanout.send(json!({ "kind": "provider.delta" }));
        assert_eq!(first.try_recv().unwrap()["kind"], "provider.delta");
        assert_eq!(second.try_recv().unwrap()["kind"], "provider.delta");
    }

    #[test]
    fn a_dropped_reader_is_pruned_and_does_not_block_the_others() {
        let fanout = Fanout::default();
        let stalled = fanout.subscribe();
        let mut live = fanout.subscribe();
        assert_eq!(fanout.receiver_count(), 2);
        drop(stalled);
        fanout.send(json!({ "kind": "provider.delta" }));
        assert_eq!(live.try_recv().unwrap()["kind"], "provider.delta");
        assert_eq!(fanout.receiver_count(), 1);
    }

    /// JOB-04: the engine has to say when its egress is behind, or a client
    /// can only show a frozen transcript. A subscriber that stops reading is
    /// named once, on the same channel, at the depth that crossed the mark;
    /// a subscriber that keeps up is never named.
    #[test]
    fn a_backlogged_subscriber_is_signalled_once_with_its_session() {
        let fanout = Fanout::default();
        let mut slow = fanout.subscribe();
        let mut fast = fanout.subscribe();
        for index in 0..BACKPRESSURE_QUEUED_FRAMES as u64 {
            fanout.send(json!({
                "kind": "provider.delta",
                "session_id": "ses_1",
                "index": index,
            }));
            fast.try_recv().unwrap();
        }
        let mut signalled_at = None;
        let mut seen = 0;
        while let Ok(frame) = slow.try_recv() {
            seen += 1;
            if frame["kind"] == "backpressure" {
                signalled_at = Some(seen);
                assert_eq!(frame["cleared"], json!(false));
                assert_eq!(frame["queued"], json!(BACKPRESSURE_QUEUED_FRAMES));
                // Both transports gate progress by session, so the report has
                // to carry the one that filled the queue.
                assert_eq!(frame["session_id"], json!("ses_1"));
            }
        }
        // The report lands right behind the frame that filled the queue.
        assert_eq!(signalled_at, Some(BACKPRESSURE_QUEUED_FRAMES + 1));
        assert!(fast.try_recv().is_err(), "a keeping-up reader is not named");
    }

    #[test]
    fn a_reported_subscriber_is_not_signalled_again_until_it_clears() {
        let fanout = Fanout::default();
        let mut slow = fanout.subscribe();
        for _ in 0..BACKPRESSURE_QUEUED_FRAMES + 50 {
            fanout.send(json!({ "kind": "provider.delta" }));
        }
        let mut signals = 0;
        while let Ok(frame) = slow.try_recv() {
            if frame["kind"] == "backpressure" {
                signals += 1;
                // The report names a session only when the triggering frame
                // had one.
                assert!(frame.get("session_id").is_none());
            }
        }
        assert_eq!(signals, 1, "one episode, one report");
    }

    #[test]
    fn the_report_clears_when_the_reader_catches_up() {
        let fanout = Fanout::default();
        let mut slow = fanout.subscribe();
        for _ in 0..BACKPRESSURE_QUEUED_FRAMES {
            fanout.send(json!({ "kind": "provider.delta", "session_id": "ses_2" }));
        }
        while let Ok(frame) = slow.try_recv() {
            if frame["kind"] == "backpressure" {
                break;
            }
        }
        // Drained to zero, the next send ends the episode with a clear report.
        fanout.send(json!({ "kind": "provider.delta", "session_id": "ses_2", "index": 9_999 }));
        let tail = slow.try_recv().unwrap();
        assert_eq!(tail["index"], json!(9_999));
        let cleared = slow.try_recv().unwrap();
        assert_eq!(cleared["kind"], "backpressure");
        assert_eq!(cleared["cleared"], json!(true));
        assert!(slow.try_recv().is_err(), "nothing extra is invented");
    }

    /// Hysteresis keeps a reader hovering at the threshold from flapping the
    /// signal: the rising edge fires at the reported depth, the falling edge
    /// only at or below the clear mark, and between the two nothing changes.
    #[test]
    fn the_edges_keep_hysteresis_between_the_marks() {
        assert_eq!(
            backpressure_edge(false, BACKPRESSURE_QUEUED_FRAMES - 1),
            None,
        );
        assert_eq!(
            backpressure_edge(false, BACKPRESSURE_QUEUED_FRAMES),
            Some(true),
        );
        assert_eq!(backpressure_edge(true, BACKPRESSURE_QUEUED_FRAMES), None);
        assert_eq!(
            backpressure_edge(true, BACKPRESSURE_CLEARED_FRAMES),
            Some(false),
        );
        assert_eq!(backpressure_edge(false, 0), None);
    }
}
