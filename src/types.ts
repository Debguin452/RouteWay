export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  MASTER_KEY: string;
  DASHBOARD_ORIGIN: string;
  DEBUG_TOKEN?: string;
  PBKDF2_ITERATIONS?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_VERIFY_URL?: string;
  ACTIVITY_LOG?: string;
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
  timeout_seconds: number;
  retries: number;
  allowed_methods: string | null;
  allowed_paths: string | null;
  allowed_ips: string | null;
  extra_headers: string | null;
  client_rate_limit_per_minute: number;
  require_human: number;
}

export interface TokenJoinRow {
  token_id: string;
  token_revoked: number;
  token_expires_at: number | null;
  route_id: string;
  target_url: string;
  inject_as: "header" | "query";
  inject_key: string;
  encrypted_secret: string;
  secret_iv: string;
  allowed_origin: string | null;
  rate_limit_per_minute: number;
  timeout_seconds: number;
  retries: number;
  allowed_methods: string | null;
  allowed_paths: string | null;
  allowed_ips: string | null;
  extra_headers: string | null;
  client_rate_limit_per_minute: number;
  require_human: number;
  route_paused: number;
  project_paused: number;
}

export interface RouteSettings {
  allowedOrigin: string | null;
  allowedMethods: string | null;
  allowedPaths: string | null;
  allowedIps: string | null;
  extraHeaders: string | null;
  rateLimitPerMinute: number;
  clientRateLimitPerMinute: number;
  requireHuman: boolean;
  timeoutSeconds: number;
  retries: number;
}
