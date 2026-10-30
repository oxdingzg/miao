-- Captured from the compiled pre-change MIAP schema-v2 controller.
PRAGMA application_id=1296646480;
PRAGMA user_version=2;
BEGIN TRANSACTION;
CREATE TABLE permission_authority(id TEXT PRIMARY KEY);
INSERT INTO "permission_authority" VALUES('a063c86b-b3a5-4a42-9d06-25484cd6dd3c');
CREATE TABLE permission_directory(project TEXT NOT NULL REFERENCES permission_project(project),location TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),PRIMARY KEY(project,location));
CREATE TABLE permission_directory_migration(project TEXT NOT NULL,location TEXT NOT NULL,fingerprint TEXT NOT NULL,patterns TEXT NOT NULL,PRIMARY KEY(project,location),FOREIGN KEY(project,location) REFERENCES permission_directory(project,location));
CREATE TABLE permission_directory_rule(project TEXT NOT NULL,location TEXT NOT NULL,id TEXT NOT NULL,rule TEXT NOT NULL,digest TEXT NOT NULL,created_at_ms INTEGER NOT NULL,PRIMARY KEY(project,location,id),FOREIGN KEY(project,location) REFERENCES permission_directory(project,location));
CREATE TABLE permission_project(project TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991));
INSERT INTO "permission_project" VALUES('fixture-project',3);
CREATE TABLE permission_project_migration(project TEXT PRIMARY KEY REFERENCES permission_project(project),fingerprint TEXT NOT NULL,imported INTEGER NOT NULL);
INSERT INTO "permission_project_migration" VALUES('fixture-project','d6d98409ef80d0516f505632455e765067db6040ea797b90a2f9e911190a885d',2);
CREATE TABLE permission_project_rule(project TEXT NOT NULL REFERENCES permission_project(project),id TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('native','legacy')),rule TEXT NOT NULL,digest TEXT NOT NULL,revoked_at_ms INTEGER,CHECK(origin='legacy' OR revoked_at_ms IS NULL),PRIMARY KEY(project,id));
INSERT INTO "permission_project_rule" VALUES('fixture-project','legacy-a','legacy','{"action":"read","resource":"private/**","effect":"allow"}','123f2d52c0787d7406a97cba1db9f69621a465a8791cfa106240bb0883bc7a43',1793276893321);
INSERT INTO "permission_project_rule" VALUES('fixture-project','legacy-b','legacy','{"action":"read","resource":"public/**","effect":"allow"}','14ba86b0a06424236795a3c733f82e94672de3ee2b5f080f665a6168472faed2',NULL);
INSERT INTO "permission_project_rule" VALUES('fixture-project','psv_native_project_16c86c9e996581da2a6081eb0d7781ba949a9d552cca425d3833e653b1ce779b','native','{"action":"read","resource":"native/**","effect":"allow"}','b0008b38b265a72db83a93135d6b38206121416b66ff463e0e27f8aac5f4879a',NULL);
CREATE TRIGGER permission_project_directory_budget_INSERT AFTER INSERT ON permission_project_rule
             WHEN EXISTS(SELECT 1 FROM permission_directory d WHERE d.project=NEW.project AND (SELECT count(*) FROM (SELECT digest FROM permission_project_rule WHERE project=NEW.project AND revoked_at_ms IS NULL UNION SELECT digest FROM permission_directory_rule WHERE project=NEW.project AND location=d.location))>256)
             BEGIN SELECT RAISE(ABORT,'combined project and directory permission budget exceeded'); END;
CREATE TRIGGER permission_directory_project_budget_INSERT AFTER INSERT ON permission_directory_rule
             WHEN (SELECT count(*) FROM (SELECT digest FROM permission_project_rule WHERE project=NEW.project AND revoked_at_ms IS NULL UNION SELECT digest FROM permission_directory_rule WHERE project=NEW.project AND location=NEW.location))>256
             BEGIN SELECT RAISE(ABORT,'combined project and directory permission budget exceeded'); END;
CREATE TRIGGER permission_project_directory_budget_UPDATE AFTER UPDATE ON permission_project_rule
             WHEN EXISTS(SELECT 1 FROM permission_directory d WHERE d.project=NEW.project AND (SELECT count(*) FROM (SELECT digest FROM permission_project_rule WHERE project=NEW.project AND revoked_at_ms IS NULL UNION SELECT digest FROM permission_directory_rule WHERE project=NEW.project AND location=d.location))>256)
             BEGIN SELECT RAISE(ABORT,'combined project and directory permission budget exceeded'); END;
CREATE TRIGGER permission_directory_project_budget_UPDATE AFTER UPDATE ON permission_directory_rule
             WHEN (SELECT count(*) FROM (SELECT digest FROM permission_project_rule WHERE project=NEW.project AND revoked_at_ms IS NULL UNION SELECT digest FROM permission_directory_rule WHERE project=NEW.project AND location=NEW.location))>256
             BEGIN SELECT RAISE(ABORT,'combined project and directory permission budget exceeded'); END;
COMMIT;
