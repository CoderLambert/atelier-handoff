CREATE TABLE IF NOT EXISTS channel_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  username TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(channel, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_bindings_channel
  ON channel_bindings(channel, created_at DESC);

CREATE TABLE IF NOT EXISTS channel_sessions (
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  atelier_session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_sessions_atelier
  ON channel_sessions(atelier_session_id);

PRAGMA user_version = 16;
