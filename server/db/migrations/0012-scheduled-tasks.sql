CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_mode TEXT NOT NULL,
  target_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  agent_revision_id TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  timing_kind TEXT NOT NULL,
  timing_json TEXT NOT NULL CHECK(json_valid(timing_json)),
  time_zone TEXT NOT NULL,
  mode TEXT NOT NULL,
  approval_mode TEXT,
  max_search_charge_fen INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER,
  misfire_policy TEXT NOT NULL DEFAULT 'run_once',
  overlap_policy TEXT NOT NULL DEFAULT 'skip',
  notify_policy TEXT NOT NULL DEFAULT 'on_error',
  status TEXT NOT NULL DEFAULT 'active',
  pause_reason TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
  ON scheduled_tasks(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_project
  ON scheduled_tasks(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_target_session
  ON scheduled_tasks(target_session_id);

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  trigger_kind TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  target_session_id TEXT,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  prompt_snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_task_runs_idempotency
  ON scheduled_task_runs(task_id, trigger_kind, scheduled_for)
  WHERE trigger_kind IN ('scheduled', 'misfire');
CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_history
  ON scheduled_task_runs(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_run_id
  ON scheduled_task_runs(run_id);

PRAGMA user_version=12;
