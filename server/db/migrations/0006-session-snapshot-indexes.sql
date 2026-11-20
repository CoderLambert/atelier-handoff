-- The payload remains authoritative. Adding virtual columns preserves existing rowids.
ALTER TABLE runs ADD COLUMN session_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sessionId')) VIRTUAL;
ALTER TABLE messages ADD COLUMN session_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sessionId')) VIRTUAL;
ALTER TABLE tools ADD COLUMN session_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sessionId')) VIRTUAL;
ALTER TABLE permissions ADD COLUMN session_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sessionId')) VIRTUAL;
ALTER TABLE artifacts ADD COLUMN session_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sessionId')) VIRTUAL;
ALTER TABLE attachments ADD COLUMN session_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.sessionId')) VIRTUAL;
ALTER TABLE attachments ADD COLUMN snapshot_visible INTEGER GENERATED ALWAYS AS
  (coalesce(json_extract(data, '$.removed'), 0) = 0 OR json_extract(data, '$.status') = 'used') VIRTUAL;

CREATE INDEX runs_snapshot_session ON runs(session_id);
CREATE INDEX messages_snapshot_session ON messages(session_id);
CREATE INDEX tools_snapshot_session ON tools(session_id);
CREATE INDEX permissions_snapshot_session ON permissions(session_id);
CREATE INDEX artifacts_snapshot_session ON artifacts(session_id);
CREATE INDEX attachments_snapshot_session ON attachments(session_id);
DROP INDEX runs_session;
DROP INDEX messages_session;
PRAGMA user_version=6;
