//! Shared-authority writes read a locked Session source without writing it.
use crate::{product_permission_request::Context, protocol::Error};
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    Connection, Transaction, TransactionBehavior,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

/// Opaque process-local authority captured from a real Runtime product call.
#[derive(Clone)]
pub struct Source {
    pub(crate) path: PathBuf,
    pub(crate) context: Context,
}

impl Source {
    /// Execute trusted shared-store work while the captured Session source is
    /// live and locked. Call this on the store's blocking worker. Only the main
    /// shared database may be written; the attached Session source is read-only.
    ///
    /// This is a source-liveness fence, not a permission decision or ownership
    /// handoff. The caller must bind its project/directory authority separately.
    pub(crate) fn with_root_transaction<T>(
        &self,
        connection: &mut Connection,
        execute: impl FnOnce(&Transaction<'_>) -> Result<T, Error>,
    ) -> Result<T, Error> {
        self.with_root_sources(connection, |transaction, _| execute(transaction))
    }

    pub(crate) fn with_root_sources<T>(
        &self,
        connection: &mut Connection,
        execute: impl FnOnce(
            &Transaction<'_>,
            &[(
                crate::product_permission::Source,
                &crate::product_permission::Authority,
            )],
        ) -> Result<T, Error>,
    ) -> Result<T, Error> {
        with_sources(connection, &self.path, &self.context, execute)
    }
}

fn with_sources<T>(
    connection: &mut Connection,
    path: &Path,
    context: &Context,
    execute: impl FnOnce(
        &Transaction<'_>,
        &[(
            crate::product_permission::Source,
            &crate::product_permission::Authority,
        )],
    ) -> Result<T, Error>,
) -> Result<T, Error> {
    if !connection.is_autocommit() || !path.is_file() {
        return Err(Error::Invalid(
            "permission source transaction requires an existing store".into(),
        ));
    }
    let root: u32 = connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if root != 0x4d494150 {
        return Err(Error::Invalid(
            "permission source transaction requires a shared authority".into(),
        ));
    }
    let path = path
        .to_str()
        .ok_or_else(|| Error::Invalid("permission source requires a UTF-8 database path".into()))?;
    let uri = format!(
        "file:{}?mode=rw",
        percent_encoding::utf8_percent_encode(path, percent_encoding::NON_ALPHANUMERIC)
    );
    connection.execute("ATTACH DATABASE ?1 AS permission_source", [&uri])?;
    let result = (|| {
        let application: u32 =
            connection.query_row("PRAGMA permission_source.application_id", [], |row| {
                row.get(0)
            })?;
        let version: u32 =
            connection.query_row("PRAGMA permission_source.user_version", [], |row| {
                row.get(0)
            })?;
        if application != crate::store::APPLICATION_ID
            || !(22..=crate::store::SCHEMA_VERSION).contains(&version)
        {
            return Err(Error::Invalid(
                "permission source has no supported execution fence".into(),
            ));
        }
        let callback = Arc::new(AtomicBool::new(false));
        let phase = callback.clone();
        connection.authorizer(Some(move |context: AuthContext<'_>| {
            if phase.load(Ordering::SeqCst)
                && matches!(
                    context.action,
                    AuthAction::Transaction { .. } | AuthAction::Savepoint { .. }
                )
            {
                return Authorization::Deny;
            }
            read_only_source(context)
        }));
        // SQLite acquires both databases before any process-local source lock.
        // Only main is writable, so no multi-database WAL atomicity is assumed.
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let product = context.product.read().unwrap();
        if !product
            .bridge
            .as_ref()
            .is_some_and(|bridge| bridge.same_connection(&context.bridge))
        {
            return Err(Error::Invalid("inactive shared permission source".into()));
        }
        context
            .bridge
            .with_permission_sources(&context.source, |sources| {
                require_active(&transaction, context)?;
                callback.store(true, Ordering::SeqCst);
                let guard = CallbackPhase(callback.clone());
                let result = execute(&transaction, sources);
                drop(guard);
                let result = result?;
                require_active(&transaction, context)?;
                transaction.commit()?;
                Ok(result)
            })
    })();
    connection.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
    let detached = connection.execute_batch("DETACH DATABASE permission_source");
    match result {
        Ok(value) => {
            detached?;
            Ok(value)
        }
        Err(error) => Err(error),
    }
}

fn require_active(connection: &Connection, context: &Context) -> Result<(), Error> {
    if context.authority.cancel.is_cancelled()
        || !crate::product_permission::source_active_in(
            connection,
            &context.source.session_id,
            &context.authority.run_id,
            &context.source.call_id,
            &context.workspace,
            true,
        )?
    {
        return Err(Error::Invalid("inactive shared permission source".into()));
    }
    Ok(())
}

fn read_only_source(context: AuthContext<'_>) -> Authorization {
    if matches!(
        context.action,
        AuthAction::Attach { .. } | AuthAction::Detach { .. } | AuthAction::Unknown { .. }
    ) {
        return Authorization::Deny;
    }
    if context
        .database_name
        .is_some_and(|database| database != "main")
        && !matches!(
            context.action,
            AuthAction::Read { .. }
                | AuthAction::Pragma {
                    pragma_value: None,
                    ..
                }
        )
    {
        return Authorization::Deny;
    }
    Authorization::Allow
}

struct CallbackPhase(Arc<AtomicBool>);

impl Drop for CallbackPhase {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
