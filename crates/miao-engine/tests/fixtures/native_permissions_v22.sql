-- Actual schema-22 engine output, including its SQLite header; no provider work.
PRAGMA foreign_keys=OFF;
PRAGMA application_id=1296646469;
PRAGMA user_version=22;
BEGIN TRANSACTION;
CREATE TABLE engine_approval(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),run_id TEXT NOT NULL REFERENCES engine_run(id),call_id TEXT NOT NULL REFERENCES engine_tool(id),binding TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL);
CREATE TABLE engine_cache_prefix(session_id TEXT PRIMARY KEY REFERENCES engine_session(id), affinity_session TEXT NOT NULL, route_hash TEXT NOT NULL, parameters_hash TEXT NOT NULL, history_hash TEXT NOT NULL, message_count INTEGER NOT NULL, session_seq INTEGER NOT NULL);
CREATE TABLE engine_compaction(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),through_seq INTEGER NOT NULL,summary TEXT NOT NULL,created_seq INTEGER NOT NULL);
CREATE TABLE engine_context(session_id TEXT NOT NULL REFERENCES engine_session(id),epoch INTEGER NOT NULL,fingerprint TEXT NOT NULL,system TEXT NOT NULL,sources TEXT NOT NULL,selected_seq INTEGER NOT NULL,PRIMARY KEY(session_id,epoch));
CREATE TABLE engine_event(session_id TEXT NOT NULL REFERENCES engine_session(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, recorded_at_ms INTEGER, PRIMARY KEY(session_id,seq));
CREATE TABLE engine_file_snapshot(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES engine_session(id),boundary_seq INTEGER NOT NULL,kind TEXT NOT NULL,manifest TEXT NOT NULL);
CREATE TABLE engine_file_touch(session_id TEXT NOT NULL REFERENCES engine_session(id),path TEXT NOT NULL,PRIMARY KEY(session_id,path));
CREATE TABLE engine_input(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES engine_session(id), prompt TEXT NOT NULL, delivery TEXT NOT NULL, state TEXT NOT NULL, admitted_seq INTEGER NOT NULL, attachments TEXT);
CREATE TABLE engine_job(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),request_key TEXT UNIQUE NOT NULL REFERENCES engine_tool(id),state TEXT NOT NULL,input TEXT NOT NULL,result TEXT);
CREATE TABLE engine_lease(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),interval_ms INTEGER NOT NULL,last_ms INTEGER NOT NULL,epoch INTEGER NOT NULL,owner_pid INTEGER);
CREATE TABLE engine_lineage(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),parent_session_id TEXT NOT NULL REFERENCES engine_session(id),message_seq INTEGER NOT NULL);
CREATE TABLE engine_location(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),root TEXT NOT NULL);
CREATE TABLE engine_message(session_id TEXT NOT NULL REFERENCES engine_session(id), seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, checkpoint TEXT, reverted INTEGER NOT NULL DEFAULT 0, quarantined INTEGER NOT NULL DEFAULT 0, recorded_at_ms INTEGER, PRIMARY KEY(session_id,seq));
CREATE TABLE engine_migration(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES engine_session(id),direction TEXT NOT NULL,state TEXT NOT NULL,bundle_sha256 TEXT NOT NULL,source_high_seq INTEGER NOT NULL,created_ms INTEGER NOT NULL,updated_ms INTEGER NOT NULL);
CREATE TABLE engine_owned_permission_rule(
           workspace TEXT NOT NULL,
           digest TEXT NOT NULL,
           rule TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           PRIMARY KEY(workspace, digest)
         );
INSERT INTO "engine_owned_permission_rule" VALUES('/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace','af5eb6ba8a0dcd2e663116e884caa6be708e3409368505ba434b15b7b2b24866','{"action":"read","resource":"native-b/**","effect":"allow"}',1793263361682);
CREATE TABLE engine_permission_grant(scope_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
CREATE TABLE engine_permission_import(
           workspace TEXT NOT NULL, legacy_id TEXT NOT NULL, digest TEXT NOT NULL,
           rule TEXT NOT NULL, removed_at_ms INTEGER,
           PRIMARY KEY(workspace,legacy_id),
           FOREIGN KEY(workspace) REFERENCES engine_permission_migration(workspace)
         );
INSERT INTO "engine_permission_import" VALUES('/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace','legacy-a','9da3628cab74a802535b48f58b241992c03a5d7fdb59b0d9637f61412373f0b9','{"action":"read","resource":"legacy-a/**","effect":"allow"}',1793263361689);
INSERT INTO "engine_permission_import" VALUES('/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace','legacy-b','59bf5c816ce1a62cbb3e196b3a2d51246c4d684ab841c30a70a8b4f91f0f4c9f','{"action":"read","resource":"legacy-b/**","effect":"allow"}',NULL);
CREATE TABLE engine_permission_import_change(
           seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL,
           change TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL
         );
INSERT INTO "engine_permission_import_change" VALUES(1,'/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace','{"kind":"migrated","receipt":{"project":"fixture-project","fingerprint":"a940aa4eb1774cc2e813857ee6d6ac5e17f289786cb19d22a034e620563caa40","imported":2},"rules":[{"id":"legacy-a","rule":{"action":"read","resource":"legacy-a/**","effect":"allow"}},{"id":"legacy-b","rule":{"action":"read","resource":"legacy-b/**","effect":"allow"}}]}',1793263361689);
INSERT INTO "engine_permission_import_change" VALUES(2,'/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace','{"kind":"removed","id":"legacy-a","fingerprint":"a940aa4eb1774cc2e813857ee6d6ac5e17f289786cb19d22a034e620563caa40"}',1793263361689);
CREATE TABLE engine_permission_migration(
           workspace TEXT PRIMARY KEY, project TEXT NOT NULL, fingerprint TEXT NOT NULL,
           imported INTEGER NOT NULL, migrated_at_ms INTEGER NOT NULL
         );
INSERT INTO "engine_permission_migration" VALUES('/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace','fixture-project','a940aa4eb1774cc2e813857ee6d6ac5e17f289786cb19d22a034e620563caa40',2,1793263361689);
CREATE TABLE engine_permission_pattern_change(
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           workspace TEXT NOT NULL,
           change TEXT NOT NULL,
           recorded_at_ms INTEGER NOT NULL
         );
INSERT INTO "engine_permission_pattern_change" VALUES(1,'/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace','{"kind":"upsert","pattern":{"id":"prule_8bd91a0ab078a45d866b510e4dfbbe2cb1aadc1b4fda8b0be02f0287022f710e","workspace":"/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace","rule":{"action":"read","resource":"native-a/**","effect":"allow"},"source":"native","created_at_ms":1793263361645}}',1793263361681);
INSERT INTO "engine_permission_pattern_change" VALUES(2,'/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace','{"kind":"upsert","pattern":{"id":"prule_af5eb6ba8a0dcd2e663116e884caa6be708e3409368505ba434b15b7b2b24866","workspace":"/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace","rule":{"action":"read","resource":"native-b/**","effect":"allow"},"source":"native","created_at_ms":1793263361682}}',1793263361686);
INSERT INTO "engine_permission_pattern_change" VALUES(3,'/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace','{"kind":"remove","id":"prule_8bd91a0ab078a45d866b510e4dfbbe2cb1aadc1b4fda8b0be02f0287022f710e"}',1793263361687);
CREATE TABLE engine_permission_request_scope(request_id TEXT PRIMARY KEY REFERENCES engine_approval(id) ON DELETE CASCADE,scope TEXT NOT NULL);
CREATE TABLE engine_permission_rule(
           workspace TEXT NOT NULL,
           digest TEXT NOT NULL,
           rule TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           PRIMARY KEY(workspace, digest)
         );
INSERT INTO "engine_permission_rule" VALUES('/private/tmp/miao-native-permissions-v22-s6bxqigr/workspace','59bf5c816ce1a62cbb3e196b3a2d51246c4d684ab841c30a70a8b4f91f0f4c9f','{"action":"read","resource":"legacy-b/**","effect":"allow"}',1793263361689);
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
CREATE TABLE engine_run(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES engine_session(id), state TEXT NOT NULL, lease_epoch INTEGER);
CREATE TABLE engine_session(id TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'build', title TEXT NOT NULL DEFAULT '', created_at_ms INTEGER, updated_at_ms INTEGER, archived_at_ms INTEGER);
CREATE TABLE engine_staged_revert(session_id TEXT PRIMARY KEY REFERENCES engine_session(id),boundary_seq INTEGER NOT NULL,snapshot_id INTEGER NOT NULL,restored TEXT NOT NULL,created TEXT NOT NULL,removed TEXT NOT NULL,previous TEXT NOT NULL);
CREATE TABLE engine_timing(session_id TEXT NOT NULL REFERENCES engine_session(id), run_id TEXT NOT NULL, step INTEGER NOT NULL, ttft_ms INTEGER NOT NULL, turn_ms INTEGER, PRIMARY KEY(session_id,run_id,step));
CREATE TABLE engine_tool(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES engine_run(id), name TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL);
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
INSERT INTO "sqlite_sequence" VALUES('engine_permission_pattern_change',3);
INSERT INTO "sqlite_sequence" VALUES('engine_permission_import_change',2);
COMMIT;
PRAGMA foreign_keys=ON;
