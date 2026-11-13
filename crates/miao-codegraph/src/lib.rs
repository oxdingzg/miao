//! A local code index for miao: symbols, calls and imports in one SQLite file.
//!
//! The index answers questions that otherwise cost a grep-then-read loop. It is
//! a cache of the source tree and nothing else: every answer slices current
//! source from disk, so a stale row can never become a wrong answer, only a
//! missing one.
//!
//! Mapped from CodeGraph (https://github.com/colbymchenry/codegraph, MIT). The
//! schema, the resolution tiers and the single-call explore contract follow
//! that project; the extractor and resolver here are independent code.

mod extract;
mod lang;
mod query;
mod resolve;
mod schema;
mod sync;

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// One tool answer plus what the index did to produce it. The counters are what
/// makes a before/after comparison of the feature measurable.
pub struct Answer {
    pub content: String,
    pub files: usize,
    pub nodes: usize,
    pub refreshed: usize,
    pub pending: usize,
    pub millis: u128,
}

pub struct Index {
    connection: rusqlite::Connection,
    root: PathBuf,
    database: PathBuf,
    budget: sync::Budget,
    report: Option<sync::Report>,
}

impl Index {
    pub fn open(root: &Path, database: &Path) -> Result<Self, Error> {
        if let Some(parent) = database.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(Self {
            connection: schema::open(database)?,
            root: root.to_path_buf(),
            database: database.to_path_buf(),
            budget: sync::Budget::default(),
            report: None,
        })
    }

    pub fn with_budget(mut self, files: usize, millis: u128) -> Self {
        self.budget.files = files;
        self.budget.millis = millis;
        self
    }

    pub fn refresh(&mut self) -> Result<(), Error> {
        let report = sync::sync(&mut self.connection, &self.root, self.budget)?;
        self.report = Some(report);
        Ok(())
    }

    pub fn explore(
        &mut self,
        query: &str,
        limit: Option<usize>,
        max_chars: Option<usize>,
    ) -> Result<Answer, Error> {
        self.refresh()?;
        let content = query::explore(&self.connection, &self.root, query, limit, max_chars)?;
        Ok(self.answer(content))
    }

    pub fn node(
        &mut self,
        path: Option<&str>,
        symbol: Option<&str>,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Result<Answer, Error> {
        self.refresh()?;
        let content = query::node(&self.connection, &self.root, path, symbol, offset, limit)?;
        Ok(self.answer(content))
    }

    pub fn callers(&mut self, symbol: &str, limit: Option<usize>) -> Result<Answer, Error> {
        self.refresh()?;
        let content = query::callers(&self.connection, symbol, limit)?;
        Ok(self.answer(content))
    }

    pub fn status(&mut self) -> Result<Answer, Error> {
        self.refresh()?;
        let content = query::status(&self.connection, &self.database)?;
        let content = match self.report.as_ref() {
            Some(report) => format!(
                "{content}refresh: {} reindexed, {} unchanged, {} removed, {} pending, {} ms · {} still unresolved · {}{}\n",
                report.indexed,
                report.unchanged,
                report.removed,
                report.pending,
                report.millis,
                report.unresolved,
                report.files,
                if report.complete { "" } else { " · walk truncated" }
            ),
            None => content,
        };
        Ok(self.answer(content))
    }

    fn answer(&mut self, content: String) -> Answer {
        let report = self.report.take().unwrap_or(sync::Report {
            indexed: 0,
            unchanged: 0,
            removed: 0,
            pending: 0,
            millis: 0,
            complete: true,
            files: 0,
            nodes: 0,
            unresolved: 0,
        });
        let content = match report.pending {
            0 => content,
            pending => format!(
                "> the index is still building: {pending} file(s) pending, so this answer may be incomplete. Another call continues it.\n{content}"
            ),
        };
        Answer {
            content,
            files: report.files,
            nodes: report.nodes,
            refreshed: report.indexed,
            pending: report.pending,
            millis: report.millis,
        }
    }
}

fn digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}
