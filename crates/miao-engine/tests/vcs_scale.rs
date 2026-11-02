//! WSP-02 acceptance: the whole path is measured, not one git primitive.
//!
//! The changes view costs four stacked layers — git itself, the porcelain
//! parse, the JSON answer a wire frame carries, and per-file bookkeeping —
//! and a harness that times only the `git` spawn can improve while the
//! operator's wait does not. This harness times `vcs::status` and `vcs::diff`
//! as the engine actually runs them on a synthetic repository whose working
//! tree carries a realistic mix of modified, staged, renamed, deleted and
//! untracked entries, times the bare git commands beside them as the
//! primitive baseline, and records the answer's byte size, which is the wire
//! cost. The gap between the two is the engine's own share (parse plus JSON
//! building); it is reported as a derived figure, not a separate timer.
//!
//! Set `MIAO_VCS_SCALE_REPORT` to a directory to keep the JSON report;
//! without it the numbers only land in the test output. The assertion is a
//! loose sanity bound so a pathological regression fails loudly; the dated
//! numbers live with the measurements doc, not here.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const COMMIT_ROUNDS: usize = 30;
const TREE_FILES: usize = 5_000;
/// The large working tree: ~3350 changed entries, under the 5000 answer cap.
const LARGE_MODIFIED: usize = 3_000;
const LARGE_STAGED: usize = 100;
const LARGE_RENAMED: usize = 20;
const LARGE_DELETED: usize = 30;
const LARGE_UNTRACKED: usize = 200;
/// The small working tree, for the baseline every large number has to beat.
const SMALL_CHANGED: usize = 50;

const REPEATS: usize = 20;
const SANITY_P95_MS: u128 = 10_000;

fn git(root: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(root)
        .args(["-c", "user.email=test@example.com", "-c", "user.name=Scale"])
        .args(args)
        .status()
        .expect("git runs");
    assert!(status.success(), "git {args:?} failed");
}

fn write(root: &Path, name: &str, text: &str) {
    let path = root.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("parent dir");
    }
    std::fs::write(path, text).expect("write file");
}

/// A repository with a deep-enough history that `diff HEAD` compares against a
/// real tree, and a working tree whose change mix matches what a large review
/// session actually sees. Thirty commits instead of thousands: status and
/// diff cost lives in the work-tree scan and the index comparison, and a
/// longer history spends the same wall time re-proving that.
fn build_repo(dir: &Path, changed: Option<(usize, usize, usize, usize, usize)>) -> PathBuf {
    git(dir, &["init", "-q", "-b", "main"]);
    for round in 0..COMMIT_ROUNDS {
        for file in 0..TREE_FILES / COMMIT_ROUNDS {
            let index = round * (TREE_FILES / COMMIT_ROUNDS) + file;
            write(
                dir,
                &format!("pkg/file_{index}.txt"),
                &format!("v1 line {index}\n"),
            );
        }
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", &format!("round {round}")]);
    }
    if let Some((modified, staged, renamed, deleted, untracked)) = changed {
        for index in 0..modified {
            write(
                dir,
                &format!("pkg/file_{index}.txt"),
                &format!("v2 line {index}\nadded line\n"),
            );
        }
        for index in 0..staged {
            let name = format!("pkg/file_{}.txt", LARGE_MODIFIED + index);
            write(dir, &name, "staged content\n");
            git(dir, &["add", &name]);
            write(dir, &name, "staged then edited again\n");
        }
        for index in 0..renamed {
            let from = format!("pkg/file_{}.txt", LARGE_MODIFIED + LARGE_STAGED + index);
            let to = format!("moved/file_{index}.txt");
            // A pure `git mv`: status pairs the records through rename
            // detection, and a content change on a thirteen-byte file would
            // drop below the similarity bar and split into D+A.
            git(dir, &["mv", &from, &to]);
        }
        // Deleted files start past the renamed band, so no two groups touch
        // the same row of the tree.
        for index in 0..deleted {
            let name = format!(
                "pkg/file_{}.txt",
                LARGE_MODIFIED + LARGE_STAGED + LARGE_RENAMED + LARGE_UNTRACKED + index
            );
            std::fs::remove_file(dir.join(&name)).expect("remove file");
        }
        // Untracked files land inside a tracked directory: `--untracked-files=normal`
        // folds a wholly-untracked directory into one record, which would
        // turn two hundred entries into one.
        for index in 0..untracked {
            write(dir, &format!("pkg/fresh_{index}.txt"), "new\n");
        }
    }
    dir.to_path_buf()
}

fn bare_git_ms(root: &Path, args: &[&str], repeat: usize) -> Vec<u128> {
    let mut samples = Vec::new();
    for _ in 0..repeat {
        let started = Instant::now();
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("bare git runs");
        assert!(output.status.success());
        samples.push(started.elapsed().as_millis());
    }
    samples
}

async fn timed_status(root: &str, repeat: usize) -> (Vec<u128>, usize) {
    let mut samples = Vec::new();
    let mut bytes = 0usize;
    for _ in 0..repeat {
        let started = Instant::now();
        let answer = miao_engine::vcs::status(root, miao_engine::vcs::MAX_STATUS_FILES)
            .await
            .expect("status answers");
        samples.push(started.elapsed().as_millis());
        bytes = serde_json::to_vec(&answer).expect("serialize").len();
    }
    (samples, bytes)
}

async fn timed_diff(root: &str, path: &str, repeat: usize) -> (Vec<u128>, usize) {
    let mut samples = Vec::new();
    let mut bytes = 0usize;
    for _ in 0..repeat {
        let started = Instant::now();
        let answer = miao_engine::vcs::diff(root, path, miao_engine::vcs::MAX_DIFF_CHARS)
            .await
            .expect("diff answers");
        samples.push(started.elapsed().as_millis());
        bytes = serde_json::to_vec(&answer).expect("serialize").len();
    }
    (samples, bytes)
}

fn percentile(sorted: &[u128], fraction: f64) -> u128 {
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn summarize(values: &[u128]) -> serde_json::Value {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    serde_json::json!({
        "first_ms": sorted.first().copied().unwrap_or(0),
        "p50_ms": percentile(&sorted, 0.50),
        "p95_ms": percentile(&sorted, 0.95),
        "max_ms": sorted.last().copied().unwrap_or(0),
    })
}

/// The engine share is the gap between the whole answer and the bare git run
/// over the same tree: parse plus JSON building, derived rather than timed.
fn engine_share_ms(engine: &[u128], bare: &[u128]) -> u128 {
    let engine_p50 = {
        let mut sorted = engine.to_vec();
        sorted.sort_unstable();
        percentile(&sorted, 0.50)
    };
    let bare_p50 = {
        let mut sorted = bare.to_vec();
        sorted.sort_unstable();
        percentile(&sorted, 0.50)
    };
    engine_p50.saturating_sub(bare_p50)
}

fn keep_report(name: &str, body: &serde_json::Value) -> Option<PathBuf> {
    let dir = std::env::var("MIAO_VCS_SCALE_REPORT").ok()?;
    let path = PathBuf::from(dir).join(name);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("report dir");
    std::fs::write(&path, format!("{body}\n")).expect("write report");
    Some(path)
}

#[tokio::test]
async fn the_whole_vcs_path_is_measured_on_a_large_tree() {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = build_repo(
        dir.path(),
        Some((
            LARGE_MODIFIED,
            LARGE_STAGED,
            LARGE_RENAMED,
            LARGE_DELETED,
            LARGE_UNTRACKED,
        )),
    );
    let root_str = root.display().to_string();

    let (status_samples, status_bytes) = timed_status(&root_str, REPEATS).await;
    let bare_status = bare_git_ms(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=normal",
            "-z",
        ],
        REPEATS,
    );
    let status_report = serde_json::json!({
        "scenario": "status_large",
        "changed_entries": LARGE_MODIFIED + LARGE_STAGED + LARGE_RENAMED + LARGE_DELETED + LARGE_UNTRACKED,
        "engine": summarize(&status_samples),
        "bare_git": summarize(&bare_status),
        "engine_share_p50_ms": engine_share_ms(&status_samples, &bare_status),
        "answer_bytes": status_bytes,
    });
    println!("WSP-02 {status_report}");

    let (small_samples, small_bytes) = timed_status_small().await;
    let small_report = serde_json::json!({
        "scenario": "status_small",
        "changed_entries": SMALL_CHANGED,
        "engine": summarize(&small_samples),
        "answer_bytes": small_bytes,
    });
    println!("WSP-02 {small_report}");

    // The biggest patch one file carries: the answer rides one wire frame.
    let diff_path = "pkg/file_0.txt";
    let (diff_samples, diff_bytes) = timed_diff(&root_str, diff_path, REPEATS).await;
    let bare_diff = bare_git_ms(&root, &["diff", "HEAD", "--", diff_path], REPEATS);
    let diff_report = serde_json::json!({
        "scenario": "diff_one_file",
        "engine": summarize(&diff_samples),
        "bare_git": summarize(&bare_diff),
        "engine_share_p50_ms": engine_share_ms(&diff_samples, &bare_diff),
        "answer_bytes": diff_bytes,
    });
    println!("WSP-02 {diff_report}");

    let body = serde_json::json!({
        "status_large": status_report,
        "status_small": small_report,
        "diff_one_file": diff_report,
    });
    let kept = keep_report("vcs-scale.json", &body);
    if let Some(path) = kept {
        println!("report: {}", path.display());
    }

    let mut sorted = status_samples.clone();
    sorted.sort_unstable();
    let p95 = percentile(&sorted, 0.95);
    assert!(
        p95 < SANITY_P95_MS,
        "the large status answer is pathologically slow: {status_report}"
    );
    // The answer must still be the complete change set, so the measurement
    // proves the cap boundary sits where the code says it does.
    let answer = miao_engine::vcs::status(&root_str, miao_engine::vcs::MAX_STATUS_FILES)
        .await
        .expect("final status");
    assert_eq!(answer["repository"], true);
    assert_eq!(
        answer["file_count"],
        LARGE_MODIFIED + LARGE_STAGED + LARGE_RENAMED + LARGE_DELETED + LARGE_UNTRACKED
    );
    assert_eq!(answer["truncated"], false);
    let parsed = answer["files"].as_array().expect("files array");
    assert_eq!(parsed.len(), answer["file_count"]);
    let kinds: Vec<&str> = parsed.iter().filter_map(|f| f["kind"].as_str()).collect();
    assert!(kinds.contains(&"renamed"), "renames stay distinguishable");
    assert!(
        kinds.contains(&"untracked"),
        "untracked stays distinguishable"
    );
}

async fn timed_status_small() -> (Vec<u128>, usize) {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = build_repo(dir.path(), None);
    for index in 0..SMALL_CHANGED {
        write(
            &root,
            &format!("pkg/file_{index}.txt"),
            &format!("edited {index}\n"),
        );
    }
    let root_str = root.display().to_string();
    timed_status(&root_str, REPEATS).await
}

#[tokio::test]
async fn an_oversized_diff_refuses_instead_of_stalling() {
    let dir = tempfile::tempdir().expect("temp dir");
    let root = build_repo(dir.path(), None);
    // One file whose patch is far past the answer cap: the engine answers
    // with the truncation fact, and the wall time stays bounded by the cap
    // check, not by the patch size.
    let big = "x".repeat(miao_engine::vcs::MAX_DIFF_CHARS * 3);
    write(&root, "pkg/huge.txt", &big);
    git(&root, &["add", "pkg/huge.txt"]);
    let root_str = root.display().to_string();
    let started = Instant::now();
    let answer =
        miao_engine::vcs::diff(&root_str, "pkg/huge.txt", miao_engine::vcs::MAX_DIFF_CHARS)
            .await
            .expect("oversized diff answers");
    let elapsed = started.elapsed();
    assert_eq!(answer["truncated"], true, "{answer}");
    assert_eq!(answer["diff"], serde_json::Value::Null);
    assert!(
        elapsed < Duration::from_secs(10),
        "a refusal past the cap took {:?}",
        elapsed
    );
}
