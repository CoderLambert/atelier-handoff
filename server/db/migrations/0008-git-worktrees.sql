CREATE TABLE git_worktrees (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('linked', 'in_place')),
  branch TEXT NOT NULL,
  directory_identity TEXT,
  admin_identity TEXT,
  snapshot_id TEXT,
  snapshot_digest TEXT,
  retained TEXT,
  rebuildable TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(rebuildable))
) STRICT;
CREATE INDEX git_worktrees_project ON git_worktrees(project_id);

CREATE TABLE git_session_worktrees (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL REFERENCES git_worktrees(id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX git_session_worktrees_tree ON git_session_worktrees(worktree_id);

CREATE TABLE git_worktree_operations (
  id TEXT PRIMARY KEY NOT NULL,
  worktree_id TEXT NOT NULL REFERENCES git_worktrees(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('create', 'reclaim', 'restore')),
  state TEXT NOT NULL CHECK(state IN ('pending', 'completed', 'failed')),
  session_id TEXT,
  branch TEXT NOT NULL,
  oid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  scratch_identity TEXT,
  error TEXT
) STRICT;
CREATE UNIQUE INDEX git_worktree_one_pending ON git_worktree_operations(worktree_id) WHERE state='pending';
PRAGMA user_version=8;
