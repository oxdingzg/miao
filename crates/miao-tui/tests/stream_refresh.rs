use std::collections::HashSet;
use std::time::Duration;

use miao_tui::engine::{attach, Settings};
use miao_tui::event::{bus, AppEvent};
use miao_tui::transport::EngineSpawn;

#[tokio::test]
async fn continuous_committed_activity_keeps_refreshing_the_open_session() {
    let (bus, mut events) = bus();
    let handle = attach(
        &Settings {
            spawn: EngineSpawn {
                program: env!("CARGO_BIN_EXE_miao-tui-fake-engine").into(),
                args: Vec::new(),
                env: vec![
                    ("MIAO_TUI_FAKE_SESSIONS".into(), "1".into()),
                    ("MIAO_TUI_FAKE_STREAM".into(), "1".into()),
                ],
            },
            embedded: false,
            model: "fixture".into(),
        },
        bus,
    )
    .unwrap();
    handle.open("ses_a");
    let refreshed = tokio::time::timeout(Duration::from_secs(3), async {
        let mut snapshots = HashSet::new();
        while let Some(event) = events.recv().await {
            match event {
                AppEvent::SessionOpened {
                    transcript, state, ..
                } if state.active_run.as_deref() == Some("run-stream") => {
                    snapshots.insert(format!("{transcript:?}"));
                    if snapshots.len() == 3 {
                        return snapshots.len();
                    }
                }
                AppEvent::EngineFailure(message) => panic!("engine failed: {message}"),
                _ => {}
            }
        }
        snapshots.len()
    })
    .await;
    // Closing the request channel makes the actual bridge close its child.
    drop(handle);
    tokio::time::timeout(Duration::from_secs(3), async {
        while events.recv().await.is_some() {}
    })
    .await
    .expect("bridge and engine must close");
    assert_eq!(
        refreshed.expect("continuous traffic postponed every refresh"),
        3
    );
}
