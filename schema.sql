CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_projects_owner ON projects(owner_id);

CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  label TEXT NOT NULL,
  target_url TEXT NOT NULL,
  inject_as TEXT NOT NULL,
  inject_key TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  allowed_origin TEXT,
  rate_limit_per_minute INTEGER NOT NULL DEFAULT 60,
  paused INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  timeout_seconds INTEGER NOT NULL DEFAULT 30,
  retries INTEGER NOT NULL DEFAULT 0,
  allowed_methods TEXT,
  allowed_paths TEXT,
  allowed_ips TEXT,
  extra_headers TEXT,
  client_rate_limit_per_minute INTEGER NOT NULL DEFAULT 0,
  require_human INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, label)
);

CREATE INDEX idx_routes_project ON routes(project_id);

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  token_hash TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  label TEXT
);

CREATE INDEX idx_tokens_route ON tokens(route_id);
CREATE INDEX idx_tokens_hash ON tokens(token_hash);
