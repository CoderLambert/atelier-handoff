ALTER TABLE scheduled_tasks ADD COLUMN slug TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN remote_trigger_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_tasks ADD COLUMN trigger_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_project_slug
  ON scheduled_tasks(project_id, slug) WHERE slug IS NOT NULL;

ALTER TABLE scheduled_task_runs ADD COLUMN idempotency_key TEXT;
ALTER TABLE scheduled_task_runs ADD COLUMN trigger_source TEXT;
ALTER TABLE scheduled_task_runs ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_task_runs_idempotency
  ON scheduled_task_runs(task_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
