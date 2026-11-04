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

use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// One reader's queue. Dropping it is how a reader leaves.
pub type Subscriber = mpsc::UnboundedReceiver<Value>;

/// A set of subscriber queues that a producer publishes to.
#[derive(Clone, Default)]
pub struct Fanout {
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<Value>>>>,
}

impl Fanout {
    /// Queue one frame for every current subscriber.
    ///
    /// Subscribers that have gone away are pruned here rather than left to
    /// accumulate, so an abandoned reader costs its own queue and nothing more.
    pub fn send(&self, frame: Value) {
        let mut subscribers = self
            .subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        subscribers.retain(|subscriber| subscriber.send(frame.clone()).is_ok());
    }

    /// Join the fan-out. Frames published before this call are not delivered;
    /// a reader that needs state that predates it re-projects from the store.
    pub fn subscribe(&self) -> Subscriber {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut subscribers = self
            .subscribers
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        subscribers.retain(|subscriber| !subscriber.is_closed());
        subscribers.push(sender);
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
            .filter(|subscriber| !subscriber.is_closed())
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::Fanout;
    use serde_json::json;

    /// The failure this type exists to remove: `broadcast` keeps a fixed ring
    /// per reader and drops the oldest frame once a reader falls behind, so a
    /// reader that stalled through a long answer received only its tail.
    /// Publishing more frames than the old ring held must still deliver every
    /// one of them, in order.
    #[test]
    fn a_stalled_subscriber_receives_every_frame() {
        let fanout = Fanout::default();
        let mut stalled = fanout.subscribe();
        for index in 0..40_000u64 {
            fanout.send(json!({ "index": index }));
        }
        for index in 0..40_000u64 {
            let frame = stalled.try_recv().expect("every frame has to arrive");
            assert_eq!(frame["index"], json!(index), "frames keep their order");
        }
        assert!(stalled.try_recv().is_err(), "nothing extra is invented");
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
}
