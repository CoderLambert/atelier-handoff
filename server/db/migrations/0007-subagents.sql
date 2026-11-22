-- A task belongs to both its session and its parent run; deleting either removes it.
CREATE UNIQUE INDEX runs_subagent_scope ON runs(id, session_id);
CREATE TABLE subagents (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('explore', 'worker')),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'stopped', 'interrupted')),
  summary TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY (run_id, session_id) REFERENCES runs(id, session_id) ON DELETE CASCADE,
  CHECK((status = 'running' AND ended_at IS NULL) OR (status != 'running' AND ended_at IS NOT NULL))
) STRICT;
CREATE INDEX subagents_session ON subagents(session_id, started_at, id);
CREATE INDEX subagents_run ON subagents(run_id, status);
PRAGMA user_version=7;
