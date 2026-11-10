//! Bounded source scope for completion-check receipts, not a whole-repository claim.
use crate::{
    permission::{digest, Access},
    tools::Prepared,
};
use cap_std::fs::Dir;
use serde_json::{json, Value};
use std::{collections::BTreeSet, io::Read};

/// What a completion check leaves behind, in review vocabulary rather than a
/// boolean. A receipt is evidence only if a command really ran, so every state
/// here is derived from an executed check and its observed source; no state can
/// be set by a claim in prose.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Review {
    /// The check passed at the source it observed, and it was the first
    /// attempt: nothing in this run had to be repaired first.
    Verified,
    /// An earlier attempt in this run failed and this one passes: the defect
    /// that attempt recorded is the thing now fixed.
    Fixed,
    /// The check ran and failed. A defect is on record against this source.
    Found,
    /// The check produced no usable evidence: it was cancelled, or it passed
    /// at a source that moved underneath it, so it does not describe the tree
    /// as it now stands.
    Unverified,
}

impl Review {
    pub fn of(command_passed: bool, accepted: bool, cancelled: bool, prior_failures: u32) -> Self {
        if cancelled {
            return Review::Unverified;
        }
        if !command_passed {
            return Review::Found;
        }
        if !accepted {
            return Review::Unverified;
        }
        if prior_failures > 0 {
            return Review::Fixed;
        }
        Review::Verified
    }

    pub fn name(self) -> &'static str {
        match self {
            Review::Verified => "verified",
            Review::Fixed => "fixed",
            Review::Found => "found",
            Review::Unverified => "unverified",
        }
    }

    /// Why this state, in the words a reviewer needs. Each reason names the
    /// observation that decided it, so a reader never has to trust the label.
    pub fn reason(self) -> &'static str {
        match self {
            Review::Verified => {
                "the check passes at the source it observed and no earlier attempt failed"
            }
            Review::Fixed => "an earlier attempt failed and this one passes at an unchanged source",
            Review::Found => "the check ran and failed, so the defect is on record",
            Review::Unverified => {
                "the check produced no evidence: it was cancelled, or its source moved"
            }
        }
    }

    pub fn snapshot(self) -> Value {
        json!({"state": self.name(), "reason": self.reason()})
    }
}

#[derive(Clone, Default)]
pub(crate) struct Scope {
    paths: BTreeSet<String>,
    truncated: bool,
    untracked_writers: bool,
}
impl Scope {
    pub fn observe(&mut self, prepared: &Prepared) {
        if matches!(
            prepared.access(),
            Access::Execute | Access::External | Access::Background
        ) {
            self.untracked_writers = true;
        }
        if prepared.access() != Access::Write {
            return;
        }
        let paths = if prepared.targets().is_empty() {
            vec![prepared.resource().to_owned()]
        } else {
            prepared.targets().to_vec()
        };
        for path in paths {
            if self.paths.len() >= 128 && !self.paths.contains(&path) {
                self.truncated = true;
                continue;
            }
            self.paths.insert(path);
        }
    }
    pub fn snapshot(&self, directory: &Dir) -> Value {
        let files: Vec<_> = self.paths.iter().map(|path| {
            let state = match directory.open(path) {
                Err(error) if error.kind()==std::io::ErrorKind::NotFound => json!({"kind":"absent"}),
                Err(_) => json!({"kind":"unavailable"}),
                Ok(file) => {
                    let mut bytes=Vec::new();
                    match file.metadata() {
                        Ok(metadata) if metadata.is_file() && metadata.len()<=1024*1024 => {
                            if file.take(1024*1024+1).read_to_end(&mut bytes).is_ok() && bytes.len()<=1024*1024 {
                                json!({"kind":"file","sha256":digest(&bytes),"bytes":bytes.len()})
                            } else { json!({"kind":"unavailable"}) }
                        }
                        _ => json!({"kind":"unavailable"}),
                    }
                }
            };
            json!({"path":path,"state":state})
        }).collect();
        json!({"coverage":"native-write-targets","complete":!self.truncated && files.iter().all(|file|file["state"]["kind"]!="unavailable"),"truncated":self.truncated,"untracked_writers":self.untracked_writers,"files":files})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The four names HIS-05 asks for, each decided by an observation rather
    /// than by the model's own account of what it did.
    #[test]
    fn a_receipt_state_is_derived_from_the_executed_check() {
        // First attempt that passes: nothing had to be repaired first.
        assert_eq!(Review::of(true, true, false, 0), Review::Verified);
        // The same pass after a failed attempt is a fix, not a fresh pass.
        assert_eq!(Review::of(true, true, false, 1), Review::Fixed);
        assert_eq!(Review::of(true, true, false, 7), Review::Fixed);
        // The check ran and failed: the defect is on record.
        assert_eq!(Review::of(false, false, false, 0), Review::Found);
        // A failure decides the state even after earlier failures: nothing was
        // repaired, so the finding stays open.
        assert_eq!(Review::of(false, false, false, 3), Review::Found);
        assert_eq!(Review::of(true, true, true, 0), Review::Unverified);
        assert_eq!(Review::of(true, true, true, 4), Review::Unverified);
    }

    /// A cancelled check is unverified even when its command would have
    /// passed: the run never observed the result, so claiming one would be a
    /// text claim standing in for execution.
    #[test]
    fn a_cancelled_check_never_verifies_a_source() {
        assert_eq!(Review::of(true, true, true, 0).name(), "unverified");
        assert_eq!(Review::of(true, false, true, 0).name(), "unverified");
    }

    #[test]
    fn the_snapshot_names_the_state_and_the_observation_behind_it() {
        let verified = Review::Verified.snapshot();
        assert_eq!(verified["state"], json!("verified"));
        assert!(verified["reason"]
            .as_str()
            .unwrap()
            .contains("no earlier attempt failed"));
        let found = Review::Found.snapshot();
        assert_eq!(found["state"], json!("found"));
        assert!(found["reason"].as_str().unwrap().contains("failed"));
        let fixed = Review::Fixed.snapshot();
        assert_eq!(fixed["state"], json!("fixed"));
        assert!(fixed["reason"]
            .as_str()
            .unwrap()
            .contains("earlier attempt"));
        let unverified = Review::Unverified.snapshot();
        assert_eq!(unverified["state"], json!("unverified"));
        assert!(unverified["reason"]
            .as_str()
            .unwrap()
            .contains("no evidence"));
    }
}
