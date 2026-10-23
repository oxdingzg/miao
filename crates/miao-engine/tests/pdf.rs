use miao_engine::pdf;
use serde_json::json;
use std::process::Command;

#[test]
fn page_selections_parse_ranges_and_report_the_continuation() {
    assert_eq!(pdf::selection(None, 3).unwrap().0, vec![1, 2, 3]);
    assert_eq!(pdf::selection(Some("1-2,4"), 5).unwrap().0, vec![1, 2, 4]);
    let (pages, next) = pdf::selection(None, 25).unwrap();
    assert_eq!(pages, (1..=10).collect::<Vec<_>>());
    assert_eq!(next.as_deref(), Some("11-20"));
}

#[test]
fn page_selections_reject_out_of_range_input() {
    assert!(pdf::selection(Some("0"), 3).is_err());
    assert!(pdf::selection(Some("2-1"), 3).is_err());
    assert!(pdf::selection(Some("4"), 3).is_err());
    assert!(pdf::selection(Some("1-21"), 30).is_err());
}

#[tokio::test]
async fn reads_text_pages_and_renders_pages_without_a_text_layer() {
    if Command::new("ps2pdf").arg("-v").output().is_err() {
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("fixture.ps");
    let document = directory.path().join("fixture.pdf");
    std::fs::write(
        &source,
        "%!PS\n/Helvetica findfont 24 scalefont setfont\n72 720 moveto (Hello PDF page one with enough characters) show\nshowpage\nnewpath 72 72 moveto 400 400 lineto stroke\nshowpage\n",
    )
    .unwrap();
    assert!(Command::new("ps2pdf")
        .arg(&source)
        .arg(&document)
        .status()
        .unwrap()
        .success());
    let value = pdf::read("fixture.pdf", &document, Some("1-2"))
        .await
        .unwrap();
    assert_eq!(value["total_pages"], 2);
    assert_eq!(value["pages"], json!([1, 2]));
    assert!(value["content"]
        .as_str()
        .unwrap()
        .contains("Hello PDF page one with enough characters"));
    assert_eq!(value["images"].as_array().unwrap().len(), 1);
    assert_eq!(value["images"][0]["metadata"]["page"], 2);
}
