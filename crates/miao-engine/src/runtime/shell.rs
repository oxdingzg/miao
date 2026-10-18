//! Operator shell work shares the Session actor, policy and process owner, but
//! never fabricates an assistant tool request or starts a provider turn.
use super::{
    authorize, keep_lease, DrainingGuard, Inner, LeaseKeepalive, TurnAuthority, SESSION_LEASE_MS,
};
use crate::{
    protocol::{CollaborationMode, Error},
    session_shell::Invocation,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub(super) async fn execute(
    session: String,
    inner: Arc<Inner>,
    invocation: Invocation,
    cancel: CancellationToken,
) -> Result<(), Error> {
    let _slot = tokio::select! {
        _=cancel.cancelled()=>return Ok(()),
        permit=inner.slots.clone().acquire_owned()=>permit.map_err(|_|Error::Closed)?,
    };
    if let Ok(mut draining) = inner.draining.lock() {
        draining.insert(session.clone());
    }
    let _draining = DrainingGuard(inner.clone(), session.clone());
    let cursor = inner.store.latest_seq(&session).await?;
    let lease = inner
        .store
        .claim_session(&session, SESSION_LEASE_MS)
        .await?;
    inner.store.recover_session(Some(&session)).await?;
    if inner
        .store
        .shell_status(&session, &invocation.call_id)
        .await?["state"]
        != "pending"
    {
        return Ok(());
    }
    let run = uuid::Uuid::new_v4().to_string();
    inner.store.start_run_fenced(&session, &run, &lease).await?;
    let _keepalive = LeaseKeepalive(tokio::spawn(keep_lease(
        inner.store.clone(),
        lease.clone(),
        run.clone(),
        cursor,
        cancel.clone(),
    )));
    let result=async {
        if !inner.store.claim_shell(&session,&run,invocation.clone(),&lease).await? {return Ok(());}
        let agent=inner.store.agent(&session).await?;
        let manifest=agent.as_ref().map(|(manifest,_)|manifest);
        let policy=inner.policy.for_agent(manifest)?;
        let prepared=match inner.tools.prepare("bash",json!({"command":invocation.command,"timeout_ms":invocation.timeout_ms})).await {
            Ok(prepared)=>prepared,
            Err(error)=> {
                inner.store.settle_shell(&session,&run,invocation.clone(),json!({"refused":true,"output":error.to_string(),"reason":"preparation_failed"}),&lease).await?;
                return Ok(());
            }
        };
        let allowed=authorize(&inner,&session,&run,&invocation.execution_id(&session),&prepared,cancel.clone(),TurnAuthority {
            plan:inner.store.mode(&session).await?==CollaborationMode::Plan || manifest.is_some_and(|agent|agent.mode==Some(CollaborationMode::Plan)),
            policy:&policy,
            agent:manifest,
        }).await?;
        if !allowed || cancel.is_cancelled() {
            inner.store.settle_shell(&session,&run,invocation.clone(),json!({"refused":true,"output":"Operator shell was refused or interrupted before execution.","reason":"permission_or_cancel"}),&lease).await?;
            return Ok(());
        }
        let started_seq=inner.store.start_shell(&session,&run,invocation.clone(),&lease).await?;
        let start=std::time::Instant::now();
        let result=inner.tools.execute_prepared(prepared,&policy,cancel.clone()).await;
        let result=match result {
            Ok(result)=> {
                let output=format!("{}{}",result["stdout"].as_str().unwrap_or(""),result["stderr"].as_str().unwrap_or(""));
                json!({"output":output,"exit_code":result["exit_code"],"reason":result["reason"],"truncated":result["reason"]=="output_limit" || result["output_incomplete"]==true,"started_seq":started_seq,"duration_ms":start.elapsed().as_millis().min(u64::MAX as u128) as u64})
            }
            Err(error)=>json!({"output":error.to_string(),"exit_code":Value::Null,"reason":"unknown","truncated":false,"started_seq":started_seq,"duration_ms":start.elapsed().as_millis().min(u64::MAX as u128) as u64}),
        };
        inner.store.settle_shell(&session,&run,invocation.clone(),result,&lease).await?;
        Ok::<_,Error>(())
    }.await;
    let reason = if cancel.is_cancelled() {
        "interrupted"
    } else if result.is_ok() {
        "completed"
    } else {
        "failed"
    };
    if inner.store.active_run(&session).await?.as_deref() == Some(&run) {
        inner
            .store
            .finish_run_fenced(&session, &run, reason, &lease)
            .await?;
    }
    result
}
