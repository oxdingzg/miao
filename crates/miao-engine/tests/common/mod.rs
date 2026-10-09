use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
    task::JoinHandle,
};

/// A deterministic local HTTP peer exercising the real reqwest/framing code.
/// Captures JSON bodies only, never authorization headers.
pub async fn endpoint(
    responses: Vec<(u16, String)>,
) -> (String, mpsc::Receiver<Value>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/fixture", listener.local_addr().unwrap());
    let (capture, requests) = mpsc::channel(64);
    let server = tokio::spawn(async move {
        for (status, body) in responses {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let mut headers = Vec::new();
            let mut byte = [0; 1];
            while !headers.ends_with(b"\r\n\r\n") {
                assert!(headers.len() < 65536);
                stream.read_exact(&mut byte).await.unwrap();
                headers.push(byte[0]);
            }
            let headers = String::from_utf8(headers).unwrap();
            let length = headers
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length: ")
                        .and_then(|v| v.parse::<usize>().ok())
                })
                .unwrap();
            assert!(length < 1024 * 1024);
            let mut request = vec![0; length];
            stream.read_exact(&mut request).await.unwrap();
            let _ = capture
                .send(serde_json::from_slice(&request).unwrap())
                .await;
            stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();
            for bytes in body.as_bytes().chunks(3) {
                stream.write_all(bytes).await.unwrap();
            }
        }
    });
    (url, requests, server)
}
