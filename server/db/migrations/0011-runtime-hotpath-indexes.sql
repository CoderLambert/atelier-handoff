-- The JSON payload remains authoritative. Adding virtual columns preserves existing rowids.
ALTER TABLE runs ADD COLUMN status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL;
ALTER TABLE tools ADD COLUMN run_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.runId')) VIRTUAL;
ALTER TABLE tools ADD COLUMN status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL;
ALTER TABLE permissions ADD COLUMN run_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.runId')) VIRTUAL;
ALTER TABLE permissions ADD COLUMN status TEXT GENERATED ALWAYS AS (json_extract(data, '$.status')) VIRTUAL;
ALTER TABLE artifacts ADD COLUMN run_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.runId')) VIRTUAL;

CREATE INDEX runs_status ON runs(status);
CREATE INDEX tools_run_status ON tools(run_id, status);
CREATE INDEX tools_status ON tools(status);
CREATE INDEX permissions_run_status ON permissions(run_id, status);
CREATE INDEX permissions_status ON permissions(status);
CREATE INDEX artifacts_run ON artifacts(run_id);

PRAGMA user_version=11;
