use miao_engine::{
    openai_chat::OpenAIChat,
    openai_responses::OpenAIResponses,
    protocol::{Error, Input},
    provider::{Anthropic, Provider},
    runtime::Runtime,
    store::Store,
    tools::Tools,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, io, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: Value,
    #[serde(flatten)]
    command: Command,
}

#[derive(Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
enum Command {
    Admit {
        input: Input,
        #[serde(default = "yes")]
        resume: bool,
    },
    Resume {
        session_id: String,
    },
    Cancel {
        session_id: String,
    },
    Events {
        session_id: String,
        #[serde(default)]
        after: u64,
    },
    Subscribe {
        session_id: String,
        #[serde(default)]
        after: u64,
    },
    Unsubscribe {
        session_id: String,
    },
    Shutdown,
}
fn yes() -> bool {
    true
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("miao-engine {}", env!("MIAO_ENGINE_VERSION"));
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("export") {
        let (flags, remainder) = args[1..].as_chunks::<2>();
        let mut options = HashMap::new();
        for flag in flags {
            if !["--db", "--session", "--after"].contains(&flag[0].as_str())
                || options.insert(flag[0].clone(), flag[1].clone()).is_some()
            {
                return Err("unknown or duplicate export option".into());
            }
        }
        if !remainder.is_empty() {
            return Err("missing export option value".into());
        }
        let db = options.remove("--db").ok_or("--db is required")?;
        let session = options.remove("--session").ok_or("--session is required")?;
        let after = options
            .remove("--after")
            .map(|v| v.parse::<u64>())
            .transpose()?
            .unwrap_or(0);
        tokio::task::spawn_blocking(move || {
            miao_engine::export::committed_events(db, &session, after, std::io::stdout().lock())
        })
        .await??;
        return Ok(());
    }
    if args.first().map(String::as_str) != Some("serve") {
        eprintln!("Usage: miao-engine serve --db PATH --workspace PATH --model MODEL [--provider anthropic|openai-chat|openai-responses] [--endpoint URL]\n       miao-engine export --db PATH --session ID [--after CURSOR]\nUse ANTHROPIC_API_KEY or OPENAI_API_KEY for the selected provider. An explicit engine database is required.");
        std::process::exit(2);
    }
    let mut options = HashMap::new();
    let (flags, remainder) = args[1..].as_chunks::<2>();
    for flag in flags {
        if !["--db", "--workspace", "--model", "--endpoint", "--provider"]
            .contains(&flag[0].as_str())
            || options.insert(flag[0].clone(), flag[1].clone()).is_some()
        {
            return Err("unknown or duplicate option".into());
        }
    }
    if !remainder.is_empty() {
        return Err("missing option value".into());
    }
    let db = options.get("--db").ok_or("--db is required")?;
    let workspace = options
        .get("--workspace")
        .ok_or("--workspace is required")?;
    let model = options.get("--model").ok_or("--model is required")?;
    let provider: Arc<dyn Provider> = match options
        .get("--provider")
        .map(String::as_str)
        .unwrap_or("anthropic")
    {
        "anthropic" => {
            let endpoint = options
                .get("--endpoint")
                .cloned()
                .unwrap_or_else(|| "https://api.anthropic.com/v1/messages".into());
            let key =
                std::env::var("ANTHROPIC_API_KEY").map_err(|_| "ANTHROPIC_API_KEY is required")?;
            Arc::new(Anthropic::new(endpoint, key, model.clone())?)
        }
        "openai-chat" => {
            let endpoint = options
                .get("--endpoint")
                .cloned()
                .unwrap_or_else(|| "https://api.openai.com/v1/chat/completions".into());
            let key = std::env::var("OPENAI_API_KEY").map_err(|_| "OPENAI_API_KEY is required")?;
            Arc::new(OpenAIChat::new(endpoint, key, model.clone())?)
        }
        "openai-responses" => {
            let endpoint = options
                .get("--endpoint")
                .cloned()
                .unwrap_or_else(|| "https://api.openai.com/v1/responses".into());
            let key = std::env::var("OPENAI_API_KEY").map_err(|_| "OPENAI_API_KEY is required")?;
            Arc::new(OpenAIResponses::new(endpoint, key, model.clone())?)
        }
        _ => return Err("unknown provider; use anthropic, openai-chat or openai-responses".into()),
    };
    let runtime = Runtime::new(
        Store::open(db).await?,
        provider,
        Tools::new(workspace).await?,
    )
    .await?;
    let result = serve(&runtime).await;
    runtime.shutdown().await;
    result?;
    Ok(())
}

async fn serve(runtime: &Runtime) -> io::Result<()> {
    let (output, mut outgoing) = mpsc::channel::<Value>(128);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(value) = outgoing.recv().await {
            let mut line = serde_json::to_vec(&value).map_err(io::Error::other)?;
            line.push(b'\n');
            tokio::time::timeout(Duration::from_secs(5), async {
                stdout.write_all(&line).await?;
                stdout.flush().await
            })
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "stdio subscriber too slow"))??;
        }
        Ok::<_, io::Error>(())
    });
    let mut input = BufReader::new(tokio::io::stdin());
    let mut bytes = Vec::new();
    let mut subscriptions = HashMap::<String, u64>::new();
    let mut progress = runtime.progress();
    let mut poll = tokio::time::interval(Duration::from_millis(100));
    let result=async {
        loop {
            tokio::select! {
                line=read_line(&mut input,&mut bytes)=>{
                    let Some(line)=line? else { break; };
                    let request=match serde_json::from_slice::<Request>(&line) {
                        Ok(r) if r.id.is_string()||r.id.is_number()=>r,
                        _=>{send(&output,json!({"id":null,"error":{"code":"invalid_request","message":"expected an id and a typed method/params request"}}))?;continue;},
                    };
                    let stop=matches!(request.command,Command::Shutdown);
                    let result:Result<Value,Error>=match request.command {
                        Command::Admit{input,resume}=>runtime.admit(input,resume).await.and_then(|v|serde_json::to_value(v).map_err(Error::from)),
                        Command::Resume{session_id}=>runtime.resume(&session_id).await.map(|_|json!({"accepted":true})),
                        Command::Cancel{session_id}=>runtime.cancel(&session_id).await.map(|active|json!({"accepted":active})),
                        Command::Events{session_id,after}=>runtime.store().events(&session_id,after,100).await.and_then(|v|serde_json::to_value(v).map_err(Error::from)),
                        Command::Subscribe{session_id,after}=>{
                            if subscriptions.len()>=64 && !subscriptions.contains_key(&session_id) {Err(Error::Invalid("subscription limit".into()))}
                            else {subscriptions.insert(session_id,after);Ok(json!({"accepted":true}))}
                        },
                        Command::Unsubscribe{session_id}=>{subscriptions.remove(&session_id);Ok(json!({"accepted":true}))},
                        Command::Shutdown=>Ok(json!({"accepted":true})),
                    };
                    let response=match result {Ok(value)=>json!({"id":request.id,"result":value}),Err(error)=>json!({"id":request.id,"error":{"code":error.code(),"message":error.to_string()}})};
                    send(&output,response)?;
                    if stop {break;}
                },
                _=poll.tick()=>{
                    for (session,cursor) in &mut subscriptions {
                        let events=runtime.store().events(session,*cursor,32).await.map_err(io::Error::other)?;
                        for event in events {
                            *cursor=event.seq;
                            send(&output,json!({"method":"event","params":event}))?;
                        }
                    }
                },
                notice=progress.recv()=>match notice {
                    Ok(notice)=>{if notice["session_id"].as_str().is_some_and(|s|subscriptions.contains_key(s)) {send(&output,json!({"method":"progress","params":notice}))?;}},
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>send(&output,json!({"method":"resync","params":{"reason":"ephemeral_progress_lagged"}}))?,
                    Err(tokio::sync::broadcast::error::RecvError::Closed)=>break,
                },
            }
        }
        Ok::<_,io::Error>(())
    }.await;
    drop(output);
    writer.await.map_err(io::Error::other)??;
    result
}

fn send(output: &mpsc::Sender<Value>, value: Value) -> io::Result<()> {
    output.try_send(value).map_err(|_| {
        io::Error::new(
            io::ErrorKind::BrokenPipe,
            "stdio subscriber must reconnect and replay committed events",
        )
    })
}

/// Keep partial input across select cancellation; read_line itself is not
/// cancellation safe. Refuse an oversized frame before allocating it in full.
async fn read_line(
    reader: &mut BufReader<tokio::io::Stdin>,
    bytes: &mut Vec<u8>,
) -> io::Result<Option<Vec<u8>>> {
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "incomplete JSONL request",
                ))
            };
        }
        let end = buffer.iter().position(|b| *b == b'\n');
        let n = end.map(|n| n + 1).unwrap_or(buffer.len());
        if bytes.len() + n > 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request exceeds 1 MiB",
            ));
        }
        bytes.extend_from_slice(&buffer[..n]);
        reader.consume(n);
        if end.is_some() {
            return Ok(Some(std::mem::take(bytes)));
        }
    }
}
