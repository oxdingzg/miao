//! Bounded source scope for completion-check receipts, not a whole-repository claim.
use crate::{
    permission::{digest, Access},
    tools::Prepared,
};
use cap_std::fs::Dir;
use serde_json::{json, Value};
use std::{collections::BTreeSet, io::Read};

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
