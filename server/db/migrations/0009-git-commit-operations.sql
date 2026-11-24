CREATE TABLE git_commit_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL CHECK(length(repository_id)=64 AND repository_id NOT GLOB '*[^a-f0-9]*'),
  worktree_identity TEXT NOT NULL,
  admin_identity TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK(state IN ('prepared', 'ref_updated', 'completed', 'recovery_required')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 3),
  ref TEXT NOT NULL,
  old_head TEXT,
  new_head TEXT NOT NULL,
  commits TEXT NOT NULL CHECK(json_valid(commits) AND json_type(commits) IS 'object' AND json_extract(commits,'$.version') IS 1 AND json_type(commits,'$.oids') IS 'array'),
  original_index_file TEXT,
  original_index_hash TEXT,
  target_index_file TEXT NOT NULL,
  target_index_hash TEXT NOT NULL CHECK(length(target_index_hash)=64 AND target_index_hash NOT GLOB '*[^a-f0-9]*'),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK((original_index_file IS NULL) = (original_index_hash IS NULL)),
  CHECK(original_index_hash IS NULL OR (length(original_index_hash)=64 AND original_index_hash NOT GLOB '*[^a-f0-9]*')),
  CHECK((state='prepared' AND revision=1) OR (state='ref_updated' AND revision=2) OR (state='completed' AND revision=3) OR (state='recovery_required' AND revision>=2)),
  CHECK((state='recovery_required') = (error_code IS NOT NULL)),
  CHECK((state='completed') = (finished_at IS NOT NULL)),
  CHECK(updated_at >= created_at AND (finished_at IS NULL OR finished_at=updated_at))
) STRICT;
CREATE UNIQUE INDEX git_commit_request ON git_commit_operations(project_id, repository_id, worktree_identity, admin_identity, request_id);
CREATE UNIQUE INDEX git_commit_one_unfinished ON git_commit_operations(project_id, repository_id, worktree_identity) WHERE state!='completed';
CREATE INDEX git_commit_unfinished ON git_commit_operations(project_id, repository_id, worktree_identity, admin_identity, created_at, operation_id) WHERE state!='completed';
CREATE INDEX git_commit_project_unfinished ON git_commit_operations(project_id, created_at, operation_id) WHERE state!='completed';
PRAGMA user_version=9;
