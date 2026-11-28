ALTER TABLE scheduled_tasks ADD COLUMN model TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN effort TEXT;

PRAGMA user_version=15;
