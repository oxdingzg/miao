-- Generated from the actual v1 authority via project control; see adjacent provenance JSON.
BEGIN TRANSACTION;
CREATE TABLE permission_authority(id TEXT PRIMARY KEY);
INSERT INTO "permission_authority" VALUES('f9c5bc45-2f85-4511-9e39-e59a1cc33085');
CREATE TABLE permission_project(project TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991));
INSERT INTO "permission_project" VALUES('fixture-project',3);
CREATE TABLE permission_project_migration(project TEXT PRIMARY KEY REFERENCES permission_project(project),fingerprint TEXT NOT NULL,imported INTEGER NOT NULL);
INSERT INTO "permission_project_migration" VALUES('fixture-project','e6e68464957c166b06953e55216bb952fd665733d305142693dad4ca4ecd285a',2);
CREATE TABLE permission_project_rule(project TEXT NOT NULL REFERENCES permission_project(project),id TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('native','legacy')),rule TEXT NOT NULL,digest TEXT NOT NULL,revoked_at_ms INTEGER,CHECK(origin='legacy' OR revoked_at_ms IS NULL),PRIMARY KEY(project,id));
INSERT INTO "permission_project_rule" VALUES('fixture-project','psv_native_project_16c86c9e996581da2a6081eb0d7781ba949a9d552cca425d3833e653b1ce779b','native','{"action":"read","resource":"native/**","effect":"allow"}','b0008b38b265a72db83a93135d6b38206121416b66ff463e0e27f8aac5f4879a',NULL);
INSERT INTO "permission_project_rule" VALUES('fixture-project','legacy-a','legacy','{"action":"read","resource":"public/**","effect":"allow"}','14ba86b0a06424236795a3c733f82e94672de3ee2b5f080f665a6168472faed2',1793250188927);
INSERT INTO "permission_project_rule" VALUES('fixture-project','legacy-b','legacy','{"action":"read","resource":"public/**","effect":"allow"}','14ba86b0a06424236795a3c733f82e94672de3ee2b5f080f665a6168472faed2',NULL);
COMMIT;
PRAGMA application_id=1296646480;
PRAGMA user_version=1;
