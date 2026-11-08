export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  MASTER_KEY: string;
  DASHBOARD_ORIGIN: string;
  /** Optional. If set, /api/debug requires ?key=<DEBUG_TOKEN>. */
  DEBUG_TOKEN?: string;
  /** Optional. PBKDF2 iterations for NEW password hashes (1000 to 100000, default 100000). Lower it if the free plan's 10 ms CPU limit is exceeded. */
  PBKDF2_ITERATIONS?: string;
}

export interface SessionData {
  userId: string;
  csrf: string;
}

export interface RouteRecord {
  id: string;
  project_id: string;
  label: string;
  target_url: string;
  inject_as: "header" | "query";
  inject_key: string;
  encrypted_secret: string;
  secret_iv: string;
  allowed_origin: string | null;
  rate_limit_per_minute: number;
  paused: number;
  created_at: number;
}

export interface TokenJoinRow {
  token_id: string;
  token_revoked: number;
  route_id: string;
  target_url: string;
  inject_as: "header" | "query";
  inject_key: string;
  encrypted_secret: string;
  secret_iv: string;
  allowed_origin: string | null;
  rate_limit_per_minute: number;
  route_paused: number;
  project_paused: number;
}
