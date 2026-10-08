use miao_engine::{
    approval::Response,
    credential::{Credential, Source},
    openai_chat::OpenAIChat,
    openai_responses::{OpenAIResponses, Profile},
    permission::{Config, Policy},
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
    Compact {
        session_id: String,
        compaction_id: String,
        through_message_seq: u64,
        summary: String,
    },
    Recall {
        session_id: String,
        query: String,
        #[serde(default = "recall_limit")]
        limit: usize,
        #[serde(default)]
        before_message_seq: Option<u64>,
    },
    Crons {
        session_id: String,
    },
    CancelCron {
        session_id: String,
        cron_id: String,
    },
    Wakeups {
        session_id: String,
    },
    CancelWakeup {
        session_id: String,
        timer_id: String,
    },
    Questions {
        session_id: String,
    },
    AnswerQuestion {
        session_id: String,
        answer: miao_engine::question::Answer,
    },
    State {
        session_id: String,
    },
    UpdateState {
        session_id: String,
        operation_id: String,
        tool: String,
        input: Value,
    },
    History {
        session_id: String,
        #[serde(default)]
        selected: bool,
    },
    Job {
        session_id: String,
        job_id: String,
    },
    Jobs {
        session_id: String,
    },
    CancelJob {
        session_id: String,
        job_id: String,
    },
    Context {
        session_id: String,
        #[serde(default)]
        epoch: Option<u64>,
    },
    Snapshot {
        session_id: String,
    },
    Fork {
        session_id: String,
        target_session_id: String,
        #[serde(default)]
        message_seq: Option<u64>,
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
    Approve {
        session_id: String,
        response: Response,
    },
    Shutdown,
}
fn recall_limit() -> usize {
    10
}
fn yes() -> bool {
    true
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mode = args.next();
    if matches!(
        mode.as_deref(),
        Some("__sandbox-run" | "__process-guardian")
    ) {
        let payload = args.next().ok_or("sandbox payload missing")?;
        if args.next().is_some() {
            return Err("unexpected sandbox arguments".into());
        }
        return if mode.as_deref() == Some("__process-guardian") {
            miao_engine::process::guardian(&payload)
        } else {
            miao_engine::process::sandbox_runner(&payload)
        };
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("miao-engine {}", env!("MIAO_ENGINE_VERSION"));
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("doctor") {
        let path = match &args[1..] {
            [] => None,
            [flag, path] if flag == "--db" => Some(std::path::PathBuf::from(path)),
            _ => return Err("Usage: miao-engine doctor [--db PATH]".into()),
        };
        let report =
            tokio::task::spawn_blocking(move || miao_engine::doctor::report(path.as_deref()))
                .await??;
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("credentials") {
        let (flags, remainder) = args[1..].as_chunks::<2>();
        let mut options = HashMap::new();
        for flag in flags {
            if !["--credential-db", "--auth-file"].contains(&flag[0].as_str())
                || options.insert(flag[0].clone(), flag[1].clone()).is_some()
            {
                return Err("invalid credential-list options".into());
            }
        }
        if !remainder.is_empty() || options.len() != 1 {
            return Err("select exactly one credential source".into());
        }
        let list = if let Some(path) = options.remove("--credential-db") {
            tokio::task::spawn_blocking(move || {
                miao_engine::credential::list_database(std::path::Path::new(&path))
            })
            .await??
        } else {
            let path = options.remove("--auth-file").ok_or("source missing")?;
            tokio::task::spawn_blocking(move || {
                miao_engine::credential::list_legacy(std::path::Path::new(&path))
            })
            .await??
        };
        for entry in list {
            println!("{}", serde_json::to_string(&entry)?);
        }
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
        eprintln!("Usage: miao-engine serve --db PATH --workspace PATH --model MODEL [--provider anthropic|openai-chat|openai-responses|subscription-responses] [--endpoint URL] [--policy PATH]\n       miao-engine export --db PATH --session ID [--after CURSOR]\n       miao-engine doctor [--db PATH]\nUse ANTHROPIC_API_KEY or OPENAI_API_KEY for the selected provider. An explicit engine database is required.");
        std::process::exit(2);
    }
    let mut options = HashMap::new();
    let (flags, remainder) = args[1..].as_chunks::<2>();
    for flag in flags {
        if ![
            "--db",
            "--workspace",
            "--model",
            "--endpoint",
            "--provider",
            "--policy",
            "--mcp-config",
            "--context-config",
            "--credential-db",
            "--credential-id",
            "--credential-integration",
            "--auth-file",
        ]
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
    let provider_name = options
        .get("--provider")
        .map(String::as_str)
        .unwrap_or("anthropic");
    let integration = options
        .get("--credential-integration")
        .cloned()
        .unwrap_or_else(|| {
            if provider_name == "anthropic" {
                "anthropic".into()
            } else {
                "openai".into()
            }
        });
    if options.contains_key("--credential-db") && options.contains_key("--auth-file") {
        return Err("select only one credential source".into());
    }
    let source = if let Some(path) = options.get("--credential-db") {
        Source::Database {
            path: tokio::fs::canonicalize(path).await?,
            id: options
                .get("--credential-id")
                .ok_or("--credential-id is required")?
                .clone(),
            integration,
        }
    } else if let Some(path) = options.get("--auth-file") {
        if options.contains_key("--credential-id") {
            return Err("credential-id requires credential-db".into());
        }
        Source::Legacy {
            path: tokio::fs::canonicalize(path).await?,
            integration,
        }
    } else {
        if options.contains_key("--credential-id")
            || options.contains_key("--credential-integration")
        {
            return Err("credential selection requires a file/database source".into());
        }
        if provider_name == "subscription-responses" {
            Source::Static(Credential::token(
                std::env::var("OPENAI_ACCESS_TOKEN")
                    .map_err(|_| "OPENAI_ACCESS_TOKEN is required")?,
                std::env::var("OPENAI_ACCOUNT_ID").ok(),
            ))
        } else {
            let name = if provider_name == "anthropic" {
                "ANTHROPIC_API_KEY"
            } else {
                "OPENAI_API_KEY"
            };
            Source::Static(Credential::key(
                std::env::var(name)
                    .map_err(|_| "API key or explicit credential source is required")?,
            ))
        }
    };
    source.load().await?;
    let provider: Arc<dyn Provider> = match provider_name {
        "anthropic" => {
            let endpoint = options
                .get("--endpoint")
                .cloned()
                .unwrap_or_else(|| "https://api.anthropic.com/v1/messages".into());
            Arc::new(Anthropic::with_source(
                endpoint,
                source.clone(),
                model.clone(),
            )?)
        }
        "openai-chat" => {
            let endpoint = options
                .get("--endpoint")
                .cloned()
                .unwrap_or_else(|| "https://api.openai.com/v1/chat/completions".into());
            Arc::new(OpenAIChat::with_source(
                endpoint,
                source.clone(),
                model.clone(),
            )?)
        }
        "openai-responses" | "subscription-responses" => {
            let subscription = provider_name == "subscription-responses";
            let endpoint = options.get("--endpoint").cloned().unwrap_or_else(|| {
                if subscription {
                    "https://chatgpt.com/backend-api/codex/responses".into()
                } else {
                    "https://api.openai.com/v1/responses".into()
                }
            });
            Arc::new(OpenAIResponses::with_source(
                endpoint,
                source.clone(),
                model.clone(),
                if subscription {
                    Profile::Subscription
                } else {
                    Profile::Api
                },
            )?)
        }
        _ => return Err("unknown provider".into()),
    };
    let config = if let Some(path) = options.get("--policy") {
        let bytes = tokio::fs::read(path).await?;
        if bytes.len() > 65536 {
            return Err("permission config exceeds 64 KiB".into());
        }
        serde_json::from_slice::<Config>(&bytes)?
    } else {
        Config::default()
    };
    let policy = Policy::new(config)?;
    let mut tools = Tools::new(workspace)
        .await?
        .with_process_runner(std::env::current_exe()?);
    if let Some(path) = source.path() {
        if policy.process_enabled() && path.starts_with(std::path::Path::new(tools.location())) {
            return Err("process-enabled credential sources must be outside workspace".into());
        }
        tools = tools.with_protected_resource(path);
    }
    if let Some(path) = options.get("--context-config") {
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("Context host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("Context config exceeds 64 KiB".into());
        }
        let sources = serde_json::from_slice::<Vec<miao_engine::context::Source>>(&bytes)
            .map_err(|_| "invalid Context host config")?;
        tools = tools
            .with_protected_resource(&path)
            .with_context_sources(sources)?;
    }
    if let Some(path) = options.get("--mcp-config") {
        if !policy.mcp_enabled() {
            return Err("MCP config requires explicit workspace allow_mcp authority".into());
        }
        let path = tokio::fs::canonicalize(path).await?;
        if path.starts_with(std::path::Path::new(tools.location())) {
            return Err("MCP host config must be outside model-writable workspace".into());
        }
        let bytes = tokio::fs::read(&path).await?;
        if bytes.len() > 65536 {
            return Err("MCP config exceeds 64 KiB".into());
        }
        let configs = serde_json::from_slice::<Vec<miao_engine::mcp::Config>>(&bytes)
            .map_err(|_| "invalid MCP host config")?;
        let registry =
            miao_engine::mcp::Registry::connect(configs, std::path::Path::new(tools.location()))
                .await?;
        tools = tools
            .with_protected_resource(&path)
            .with_mcp(Arc::new(registry));
    }
    let runtime = Runtime::with_policy(Store::open(db).await?, provider, tools, policy).await?;
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
    // Possession of this local stdio adapter is the controller authority.
    // Future network adapters must authenticate before receiving this handle.
    let controller = runtime.controller();
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
                        Command::Compact{session_id,compaction_id,through_message_seq,summary}=>runtime.store().compact(&session_id,&compaction_id,through_message_seq,summary).await,
                        Command::Recall{session_id,query,limit,before_message_seq}=>runtime.store().recall(&session_id,miao_engine::recall::Query{query,limit,before_message_seq}).await,
                        Command::Crons{session_id}=>runtime.store().crons(&session_id).await.and_then(|value|serde_json::to_value(value).map_err(Error::from)),
                        Command::CancelCron{session_id,cron_id}=>runtime.cancel_cron(&session_id,&cron_id).await.map(|accepted|json!({"accepted":accepted})),
                        Command::Wakeups{session_id}=>runtime.store().wakeups(&session_id).await.and_then(|value|serde_json::to_value(value).map_err(Error::from)),
                        Command::CancelWakeup{session_id,timer_id}=>runtime.cancel_wakeup(&session_id,&timer_id).await.map(|accepted|json!({"accepted":accepted})),
                        Command::Questions{session_id}=>runtime.store().questions(&session_id).await.and_then(|value|serde_json::to_value(value).map_err(Error::from)),
                        Command::AnswerQuestion{session_id,answer}=>runtime.answer_question(&controller,&session_id,answer).await.map(|_|json!({"accepted":true})),
                        Command::State{session_id}=>runtime.store().state(&session_id).await,
                        Command::UpdateState{session_id,operation_id,tool,input}=>match miao_engine::state::Mutation::parse(&tool,input){Ok(mutation)=>runtime.store().update_state(&session_id,&operation_id,mutation).await,Err(_)=>Err(Error::Invalid("invalid Session state update".into()))},
                        Command::History{session_id,selected}=>{let history=if selected {runtime.store().selected_history(&session_id).await}else{runtime.store().history(&session_id).await};history.and_then(|value|serde_json::to_value(value).map_err(Error::from))},
                        Command::Job{session_id,job_id}=>runtime.store().job(&session_id,&job_id).await.map(|v|v.unwrap_or(Value::Null)),
                        Command::Jobs{session_id}=>runtime.store().jobs(&session_id).await.and_then(|v|serde_json::to_value(v).map_err(Error::from)),
                        Command::CancelJob{session_id,job_id}=>runtime.cancel_job(&session_id,&job_id).await.map(|accepted|json!({"accepted":accepted})),
                        Command::Context{session_id,epoch}=>runtime.store().context(&session_id,epoch).await.map(|v|v.unwrap_or(Value::Null)),
                        Command::Snapshot{session_id}=>runtime.store().snapshot(&session_id).await,
                        Command::Fork{session_id,target_session_id,message_seq}=>runtime.fork(&session_id,&target_session_id,message_seq).await,
                        Command::Events{session_id,after}=>runtime.store().events(&session_id,after,100).await.and_then(|v|serde_json::to_value(v).map_err(Error::from)),
                        Command::Subscribe{session_id,after}=>{
                            if subscriptions.len()>=64 && !subscriptions.contains_key(&session_id) {Err(Error::Invalid("subscription limit".into()))}
                            else {subscriptions.insert(session_id,after);Ok(json!({"accepted":true}))}
                        },
                        Command::Unsubscribe{session_id}=>{subscriptions.remove(&session_id);Ok(json!({"accepted":true}))},
                        Command::Approve{session_id,response}=>runtime.approve(&controller,&session_id,response).await.map(|_|json!({"accepted":true})),
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
