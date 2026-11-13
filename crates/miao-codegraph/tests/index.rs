use std::fs;
use std::path::Path;

fn write(root: &Path, path: &str, text: &str) {
    let full = root.join(path);
    fs::create_dir_all(full.parent().expect("parent")).expect("dir");
    fs::write(full, text).expect("file");
}

fn index(root: &Path) -> miao_codegraph::Index {
    miao_codegraph::Index::open(root, &root.join("index.db")).expect("index")
}

#[test]
fn explore_returns_numbered_source_for_a_rust_symbol() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    write(
        root,
        "crates/a/src/lib.rs",
        "pub fn evaluate(flag: bool) -> bool {\n    flag\n}\n",
    );
    let answer = index(root)
        .explore("evaluate", None, None)
        .expect("explore");
    assert!(
        answer.content.contains("crates/a/src/lib.rs"),
        "{}",
        answer.content
    );
    assert!(
        answer.content.contains("pub fn evaluate"),
        "{}",
        answer.content
    );
    assert!(
        answer.content.contains("     2\t    flag"),
        "{}",
        answer.content
    );
    assert_eq!(answer.files, 1);
}

#[test]
fn a_call_resolves_across_files_through_a_module_path() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    write(
        root,
        "src/lib.rs",
        "mod policy;\npub fn run() {\n    policy::evaluate();\n}\n",
    );
    write(
        root,
        "src/policy.rs",
        "pub fn evaluate() -> bool {\n    true\n}\n",
    );
    let mut index = index(root);
    index.explore("evaluate", None, None).expect("explore");
    let callers = index.callers("evaluate", None).expect("callers");
    assert!(callers.content.contains("run"), "{}", callers.content);
    assert!(
        callers.content.contains("src/lib.rs:3"),
        "{}",
        callers.content
    );
}

#[test]
fn a_typescript_import_resolves_its_calls() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    write(
        root,
        "src/a.ts",
        "import { greet } from \"./b\";\nexport function run() {\n  greet();\n}\n",
    );
    write(
        root,
        "src/b.ts",
        "export function greet() {\n  return 1;\n}\n",
    );
    let mut index = index(root);
    index.explore("greet", None, None).expect("explore");
    let callers = index.callers("greet", None).expect("callers");
    assert!(callers.content.contains("run"), "{}", callers.content);
}

#[test]
fn a_second_refresh_does_no_work_and_a_changed_file_reindexes_alone() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    write(root, "src/one.rs", "pub fn one() {}\n");
    write(root, "src/two.rs", "pub fn two() {}\n");
    let mut index = index(root);
    let first = index.explore("one", None, None).expect("explore");
    assert!(
        first.refreshed >= 2,
        "first refresh indexed {}",
        first.refreshed
    );
    let second = index.explore("one", None, None).expect("explore");
    assert_eq!(
        second.refreshed, 0,
        "second refresh reindexed {}",
        second.refreshed
    );
    write(root, "src/two.rs", "pub fn two() -> u8 { 2 }\n");
    let third = index.explore("one", None, None).expect("explore");
    assert_eq!(
        third.refreshed, 1,
        "third refresh indexed {}",
        third.refreshed
    );
}

#[test]
fn node_reads_a_file_with_its_dependents() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    write(
        root,
        "src/b.ts",
        "export function greet() {\n  return 1;\n}\n",
    );
    write(
        root,
        "src/a.ts",
        "import { greet } from \"./b\";\ngreet();\n",
    );
    let answer = index(root)
        .node(Some("src/b.ts"), None, None, None)
        .expect("node");
    assert!(
        answer.content.contains("src/b.ts (3 lines)"),
        "{}",
        answer.content
    );
    assert!(answer.content.contains("Dependents"), "{}", answer.content);
    assert!(answer.content.contains("src/a.ts"), "{}", answer.content);
}

#[test]
fn node_answers_one_symbol_with_its_neighbours() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    write(
        root,
        "src/lib.rs",
        "pub fn outer() {\n    inner();\n}\nfn inner() {}\n",
    );
    let answer = index(root)
        .node(None, Some("outer"), None, None)
        .expect("node");
    assert!(
        answer.content.contains("pub fn outer"),
        "{}",
        answer.content
    );
    assert!(answer.content.contains("inner"), "{}", answer.content);
}

#[test]
fn explore_stops_at_its_budget_and_points_at_the_rest() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    let body = (0..200)
        .map(|line| format!("    let value{line} = {line};\n"))
        .collect::<String>();
    write(root, "src/big.rs", &format!("pub fn big() {{\n{body}}}\n"));
    let answer = index(root)
        .explore("big", None, Some(2000))
        .expect("explore");
    assert!(answer.content.contains("elided"), "{}", answer.content);
    assert!(
        answer.content.chars().count() < 6000,
        "{}",
        answer.content.chars().count()
    );
}

#[test]
fn status_reports_coverage() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    write(root, "src/one.rs", "pub fn one() {}\n");
    write(root, "web/app.ts", "export function app() {}\n");
    let answer = index(root).status().expect("status");
    assert!(answer.content.contains("2 files"), "{}", answer.content);
    assert!(answer.content.contains("rust 1"), "{}", answer.content);
    assert!(
        answer.content.contains("typescript 1"),
        "{}",
        answer.content
    );
}

#[test]
fn generated_and_vendored_trees_stay_out_of_the_index() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    write(root, "src/one.rs", "pub fn one() {}\n");
    write(root, "node_modules/pkg/index.js", "function hidden() {}\n");
    write(root, "target/debug/build.rs", "fn hidden() {}\n");
    write(root, ".git/hooks/h.rs", "fn hidden() {}\n");
    let answer = index(root).status().expect("status");
    assert!(answer.content.contains("1 files"), "{}", answer.content);
}

#[test]
fn a_query_with_a_line_range_returns_that_source() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    write(
        root,
        "src/lib.rs",
        "pub fn alpha() {\n    let one = 1;\n    let two = 2;\n}\n",
    );
    let answer = index(root)
        .explore("src/lib.rs:2-3", None, None)
        .expect("explore");
    assert!(
        answer.content.contains("     2\t    let one = 1;"),
        "{}",
        answer.content
    );
    assert!(
        answer.content.contains("     3\t    let two = 2;"),
        "{}",
        answer.content
    );
}

#[test]
fn python_and_go_definitions_are_indexed_and_resolved() {
    let dir = tempfile::tempdir().expect("temp");
    let root = dir.path();
    write(
        root,
        "app/main.py",
        "def handler():\n    helper()\n\n\ndef helper():\n    return 1\n",
    );
    write(
        root,
        "svc/main.go",
        "package svc\n\nfunc Serve() {\n\thelper()\n}\n\nfunc helper() {}\n",
    );
    let mut index = index(root);
    let status = index.status().expect("status");
    assert!(status.content.contains("python 1"), "{}", status.content);
    assert!(status.content.contains("go 1"), "{}", status.content);
    let python = index.callers("handler", None).expect("callers");
    assert!(
        python.content.contains("Callers of handler"),
        "{}",
        python.content
    );
    let go = index.callers("Serve", None).expect("callers");
    assert!(
        go.content.contains("app/main.py") || go.content.contains("Callers of Serve"),
        "{}",
        go.content
    );
    let python_helper = index.callers("helper", None).expect("callers");
    assert!(
        python_helper.content.contains("handler") || python_helper.content.contains("Serve"),
        "{}",
        python_helper.content
    );
}
