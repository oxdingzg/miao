PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE engine_approval(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),run_id TEXT NOT NULL REFERENCES engine_run(id),call_id TEXT NOT NULL REFERENCES engine_tool(id),binding TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL);
CREATE TABLE engine_cache_prefix(session_id TEXT PRIMARY KEY REFERENCES engine_session(id), affinity_session TEXT NOT NULL, route_hash TEXT NOT NULL, parameters_hash TEXT NOT NULL, history_hash TEXT NOT NULL, message_count INTEGER NOT NULL, session_seq INTEGER NOT NULL);
CREATE TABLE engine_compaction(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),through_seq INTEGER NOT NULL,summary TEXT NOT NULL,created_seq INTEGER NOT NULL);
CREATE TABLE engine_context(session_id TEXT NOT NULL REFERENCES engine_session(id),epoch INTEGER NOT NULL,fingerprint TEXT NOT NULL,system TEXT NOT NULL,sources TEXT NOT NULL,selected_seq INTEGER NOT NULL,PRIMARY KEY(session_id,epoch));
CREATE TABLE engine_event(session_id TEXT NOT NULL REFERENCES engine_session(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, recorded_at_ms INTEGER, PRIMARY KEY(session_id,seq));
INSERT INTO "engine_event" VALUES('schema21-session',1,'input.admitted','{"delivery":"steer","input_id":"schema21-input","prompt":"historical admitted input"}',1793254388191);
CREATE TABLE engine_file_snapshot(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES engine_session(id),boundary_seq INTEGER NOT NULL,kind TEXT NOT NULL,manifest TEXT NOT NULL);
CREATE TABLE engine_file_touch(session_id TEXT NOT NULL REFERENCES engine_session(id),path TEXT NOT NULL,PRIMARY KEY(session_id,path));
CREATE TABLE engine_input(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES engine_session(id), prompt TEXT NOT NULL, delivery TEXT NOT NULL, state TEXT NOT NULL, admitted_seq INTEGER NOT NULL, attachments TEXT);
INSERT INTO "engine_input" VALUES('schema21-input','schema21-session','historical admitted input','steer','pending',1,'[]');
CREATE TABLE engine_job(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),request_key TEXT UNIQUE NOT NULL REFERENCES engine_tool(id),state TEXT NOT NULL,input TEXT NOT NULL,result TEXT);
CREATE TABLE engine_lease(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),interval_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL,epoch INTEGER NOT NULL,owner_pid INTEGER);
INSERT INTO "engine_lease" VALUES('schema21-session',30000,0,7,NULL);
CREATE TABLE engine_lineage(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),parent_session_id TEXT NOT NULL REFERENCES engine_session(id),message_seq INTEGER NOT NULL);
CREATE TABLE engine_location(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),root TEXT NOT NULL);
INSERT INTO "engine_location" VALUES('schema21-session','/fixture/schema21');
CREATE TABLE engine_message(session_id TEXT NOT NULL REFERENCES engine_session(id), seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, checkpoint TEXT, reverted INTEGER NOT NULL DEFAULT 0, quarantined INTEGER NOT NULL DEFAULT 0, recorded_at_ms INTEGER, PRIMARY KEY(session_id,seq));
CREATE TABLE engine_migration(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),direction TEXT NOT NULL,state TEXT NOT NULL,bundle_sha256 TEXT NOT NULL,source_high_seq INTEGER NOT NULL,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL);
CREATE TABLE engine_owned_permission_rule(
           workspace TEXT NOT NULL,
           digest TEXT NOT NULL,
           rule TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           PRIMARY KEY(workspace, digest)
         );
CREATE TABLE engine_permission_grant(scope_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE engine_permission_import(
           workspace TEXT NOT NULL, legacy_id TEXT NOT NULL, digest TEXT NOT NULL,
           rule TEXT NOT NULL, removed_at_ms INTEGER,
           PRIMARY KEY(workspace,legacy_id),
           FOREIGN KEY(workspace) REFERENCES engine_permission_migration(workspace)
         );
CREATE TABLE engine_permission_import_change(
           seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL,
           change TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL
         );
CREATE TABLE engine_permission_migration(
           workspace TEXT PRIMARY KEY, project TEXT NOT NULL, fingerprint TEXT NOT NULL,
           imported INTEGER NOT NULL, migrated_at_ms INTEGER NOT NULL
         );
CREATE TABLE engine_permission_pattern_change(
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           workspace TEXT NOT NULL,
           change TEXT NOT NULL,
           recorded_at_ms INTEGER NOT NULL
         );
CREATE TABLE engine_permission_request_scope(request_id TEXT PRIMARY KEY REFERENCES engine_approval(id) ON DELETE CASCADE,scope TEXT NOT NULL);
CREATE TABLE engine_permission_rule(
           workspace TEXT NOT NULL,
           digest TEXT NOT NULL,
           rule TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           PRIMARY KEY(workspace, digest)
         );
CREATE TABLE engine_product_permission_request(
           id TEXT PRIMARY KEY,
           session_id TEXT NOT NULL REFERENCES engine_session(id) ON DELETE CASCADE,
           run_id TEXT NOT NULL REFERENCES engine_run(id) ON DELETE CASCADE,
           call_id TEXT NOT NULL REFERENCES engine_tool(id) ON DELETE CASCADE,
           workspace TEXT NOT NULL,
           owner TEXT NOT NULL,
           state TEXT NOT NULL,
           data TEXT NOT NULL
         );
CREATE TABLE engine_run(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES engine_session(id), state TEXT NOT NULL);
INSERT INTO "engine_run" VALUES('historical-run','schema21-session','running');
CREATE TABLE engine_session(id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'build', title TEXT NOT NULL DEFAULT '', created_at_ms INTEGER, updated_at_ms INTEGER, archived_at_ms INTEGER);
INSERT INTO "engine_session" VALUES('schema21-session',1,'build','',NULL,NULL,NULL);
CREATE TABLE engine_staged_revert(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),boundary_seq INTEGER NOT NULL,snapshot_id INTEGER NOT NULL,restored TEXT NOT NULL,created TEXT NOT NULL,removed TEXT NOT NULL,previous TEXT NOT NULL);
CREATE TABLE engine_timing(session_id TEXT NOT NULL REFERENCES engine_session(id), run_id TEXT NOT NULL, step INTEGER NOT NULL, ttft_ms INTEGER NOT NULL, turn_ms INTEGER, PRIMARY KEY(session_id,run_id,step));
CREATE TABLE engine_tool(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engine_run(id), name TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL);
INSERT INTO "engine_tool" VALUES('historical-run/historical-call','historical-run','host_probe','{}','dispatched');
CREATE TABLE engine_transfer_import(
                    id TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL REFERENCES engine_session(id),
                    bundle_sha256 TEXT NOT NULL, bundle TEXT NOT NULL, state TEXT NOT NULL,
                    created_ms INTEGER NOT NULL);
CREATE TABLE engine_transfer_message(
                    import_id TEXT NOT NULL REFERENCES engine_transfer_import(id),source_message_id TEXT NOT NULL,seq INTEGER NOT NULL,
                    PRIMARY KEY(import_id,seq));
CREATE TABLE engine_transfer_preparation(
                    import_id TEXT PRIMARY KEY REFERENCES engine_transfer_import(id),data TEXT NOT NULL);
CREATE TABLE engine_transfer_snapshot(
                    import_id TEXT NOT NULL REFERENCES engine_transfer_import(id),snapshot_id TEXT NOT NULL,
                    boundary_message_id TEXT,manifest TEXT NOT NULL,order_index INTEGER,PRIMARY KEY(import_id,snapshot_id));
CREATE UNIQUE INDEX engine_active_run ON engine_run(session_id) WHERE state='running';
CREATE UNIQUE INDEX engine_pending_approval ON engine_approval(call_id) WHERE state='pending';
CREATE INDEX engine_pending_inputs ON engine_input(session_id,state,admitted_seq);
CREATE TRIGGER engine_projected_permission_budget
         BEFORE INSERT ON engine_permission_rule
         WHEN NOT EXISTS(SELECT 1 FROM engine_permission_rule WHERE workspace=NEW.workspace AND digest=NEW.digest)
         AND (SELECT COUNT(*) FROM engine_permission_rule WHERE workspace=NEW.workspace)
             +(SELECT COUNT(*) FROM engine_owned_permission_rule WHERE workspace=NEW.workspace)>=256
         BEGIN SELECT RAISE(ABORT, 'saved permission rule budget exceeded'); END;
CREATE TRIGGER engine_owned_permission_budget
         BEFORE INSERT ON engine_owned_permission_rule
         WHEN NOT EXISTS(SELECT 1 FROM engine_owned_permission_rule WHERE workspace=NEW.workspace AND digest=NEW.digest)
         AND (SELECT COUNT(*) FROM engine_permission_rule WHERE workspace=NEW.workspace)
             +(SELECT COUNT(*) FROM engine_owned_permission_rule WHERE workspace=NEW.workspace)>=256
         BEGIN SELECT RAISE(ABORT, 'saved permission rule budget exceeded'); END;
CREATE INDEX engine_permission_pattern_change_scope
           ON engine_permission_pattern_change(workspace,seq);
CREATE TRIGGER engine_permission_migration_no_legacy_insert
         BEFORE INSERT ON engine_permission_rule
         WHEN EXISTS(SELECT 1 FROM engine_permission_migration WHERE workspace=NEW.workspace)
         BEGIN SELECT RAISE(ABORT, 'saved permission ownership migrated'); END;
CREATE TRIGGER engine_permission_migration_no_legacy_delete
         BEFORE DELETE ON engine_permission_rule
         WHEN EXISTS(SELECT 1 FROM engine_permission_import WHERE workspace=OLD.workspace AND digest=OLD.digest AND removed_at_ms IS NULL)
         BEGIN SELECT RAISE(ABORT, 'saved permission ownership migrated'); END;
CREATE INDEX engine_permission_import_change_scope
           ON engine_permission_import_change(workspace,seq);
CREATE INDEX engine_product_permission_pending
         ON engine_product_permission_request(session_id,state);
CREATE INDEX engine_product_permission_owner_pending
         ON engine_product_permission_request(owner,workspace,state);
CREATE INDEX engine_snapshot_boundary ON engine_file_snapshot(session_id,boundary_seq);
CREATE INDEX engine_migration_session ON engine_migration(session_id,state);
CREATE TRIGGER engine_migration_event_fence
                    BEFORE INSERT ON engine_event
                    WHEN NEW.kind NOT IN ('migration.staged','migration.cutover','migration.completed','migration.aborted')
                    AND EXISTS(SELECT 1 FROM engine_migration WHERE session_id=NEW.session_id
                        AND (state IN ('staged','cutover') OR (state='completed' AND direction='rust_to_ts')))
                    BEGIN SELECT RAISE(ABORT,'Session is frozen for migration'); END;
CREATE TRIGGER engine_transfer_import_event_fence
                    BEFORE INSERT ON engine_event
                    WHEN EXISTS(SELECT 1 FROM engine_transfer_import WHERE session_id=NEW.session_id AND state!='active')
                    BEGIN SELECT RAISE(ABORT,'Imported Session has no execution authority'); END;
DELETE FROM "sqlite_sequence";
COMMIT;
PRAGMA application_id=1296646469;
PRAGMA user_version=21;
PRAGMA foreign_keys=ON;
