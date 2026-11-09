import type { Env, RouteRecord, RouteSettings, TokenJoinRow } from "./types";

export async function getUserByEmail(env: Env, email: string) {
  return env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<{
    id: string;
    email: string;
    password_hash: string;
    password_salt: string;
  }>();
}

export async function getUserById(env: Env, id: string) {
  return env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(id).first<{ id: string; email: string }>();
}

export async function createUser(env: Env, id: string, email: string, hash: string, salt: string) {
  await env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, email, hash, salt, Date.now())
    .run();
}

export async function listProjects(env: Env, ownerId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, paused, created_at FROM projects WHERE owner_id = ? ORDER BY created_at DESC"
  )
    .bind(ownerId)
    .all();
  return results;
}

export async function getOwnedProject(env: Env, projectId: string, ownerId: string) {
  return env.DB.prepare("SELECT id, name, paused FROM projects WHERE id = ? AND owner_id = ?")
    .bind(projectId, ownerId)
    .first<{ id: string; name: string; paused: number }>();
}

export async function createProject(env: Env, id: string, ownerId: string, name: string) {
  await env.DB.prepare("INSERT INTO projects (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, ownerId, name, Date.now())
    .run();
}

export async function listRoutes(env: Env, projectId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id, label, target_url, inject_as, inject_key, allowed_origin,
            rate_limit_per_minute, paused, created_at, timeout_seconds, retries, allowed_methods,
            allowed_paths, allowed_ips, extra_headers, client_rate_limit_per_minute, require_human
     FROM routes WHERE project_id = ? ORDER BY created_at DESC`
  )
    .bind(projectId)
    .all();
  return results;
}

export async function getOwnedRoute(env: Env, routeId: string, ownerId: string): Promise<(RouteRecord & { owner_id: string }) | null> {
  return env.DB.prepare(
    `SELECT routes.*, projects.owner_id as owner_id
     FROM routes JOIN projects ON projects.id = routes.project_id
     WHERE routes.id = ? AND projects.owner_id = ?`
  )
    .bind(routeId, ownerId)
    .first<RouteRecord & { owner_id: string }>();
}

export async function labelTaken(env: Env, projectId: string, label: string) {
  const row = await env.DB.prepare("SELECT id FROM routes WHERE project_id = ? AND label = ?")
    .bind(projectId, label)
    .first();
  return row !== null;
}

export async function createRoute(
  env: Env,
  route: {
    id: string;
    projectId: string;
    label: string;
    targetUrl: string;
    injectAs: "header" | "query";
    injectKey: string;
    encryptedSecret: string;
    secretIv: string;
    allowedOrigin: string | null;
    allowedMethods: string | null;
    allowedPaths: string | null;
    allowedIps: string | null;
    extraHeaders: string | null;
    clientRateLimitPerMinute: number;
    requireHuman: boolean;
    rateLimitPerMinute: number;
    timeoutSeconds: number;
    retries: number;
  }
) {
  await env.DB.prepare(
    `INSERT INTO routes
      (id, project_id, label, target_url, inject_as, inject_key, encrypted_secret, secret_iv,
       allowed_origin, rate_limit_per_minute, created_at, timeout_seconds, retries, allowed_methods,
       allowed_paths, allowed_ips, extra_headers, client_rate_limit_per_minute, require_human)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      route.id,
      route.projectId,
      route.label,
      route.targetUrl,
      route.injectAs,
      route.injectKey,
      route.encryptedSecret,
      route.secretIv,
      route.allowedOrigin,
      route.rateLimitPerMinute,
      Date.now(),
      route.timeoutSeconds,
      route.retries,
      route.allowedMethods,
      route.allowedPaths,
      route.allowedIps,
      route.extraHeaders,
      route.clientRateLimitPerMinute,
      route.requireHuman ? 1 : 0
    )
    .run();
}

export async function updateRouteSettings(env: Env, routeId: string, settings: RouteSettings) {
  await env.DB.prepare(
    `UPDATE routes SET allowed_origin = ?, allowed_methods = ?, allowed_paths = ?, allowed_ips = ?, extra_headers = ?,
            rate_limit_per_minute = ?, timeout_seconds = ?, retries = ?, client_rate_limit_per_minute = ?, require_human = ?
     WHERE id = ?`
  )
    .bind(
      settings.allowedOrigin,
      settings.allowedMethods,
      settings.allowedPaths,
      settings.allowedIps,
      settings.extraHeaders,
      settings.rateLimitPerMinute,
      settings.timeoutSeconds,
      settings.retries,
      settings.clientRateLimitPerMinute,
      settings.requireHuman ? 1 : 0,
      routeId
    )
    .run();
}

export async function updateRouteSecret(env: Env, routeId: string, encryptedSecret: string, secretIv: string) {
  await env.DB.prepare("UPDATE routes SET encrypted_secret = ?, secret_iv = ? WHERE id = ?")
    .bind(encryptedSecret, secretIv, routeId)
    .run();
}

export async function setRoutePaused(env: Env, routeId: string, paused: boolean) {
  await env.DB.prepare("UPDATE routes SET paused = ? WHERE id = ?").bind(paused ? 1 : 0, routeId).run();
}

export async function listTokensForRoute(env: Env, routeId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, revoked, created_at, expires_at, label FROM tokens WHERE route_id = ? ORDER BY created_at DESC"
  )
    .bind(routeId)
    .all();
  return results;
}

export async function createToken(
  env: Env,
  id: string,
  routeId: string,
  tokenHash: string,
  expiresAt: number | null = null,
  label: string | null = null
) {
  await env.DB.prepare("INSERT INTO tokens (id, route_id, token_hash, created_at, expires_at, label) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, routeId, tokenHash, Date.now(), expiresAt, label)
    .run();
}

export async function getOwnedToken(env: Env, tokenId: string, ownerId: string) {
  return env.DB.prepare(
    `SELECT tokens.id FROM tokens
     JOIN routes ON routes.id = tokens.route_id
     JOIN projects ON projects.id = routes.project_id
     WHERE tokens.id = ? AND projects.owner_id = ?`
  )
    .bind(tokenId, ownerId)
    .first();
}

export async function revokeToken(env: Env, tokenId: string) {
  await env.DB.prepare("UPDATE tokens SET revoked = 1 WHERE id = ?").bind(tokenId).run();
}

export async function getTokenWithRouteByHash(env: Env, tokenHash: string): Promise<TokenJoinRow | null> {
  return env.DB.prepare(
    `SELECT tokens.id as token_id, tokens.revoked as token_revoked, tokens.expires_at as token_expires_at,
            routes.id as route_id, routes.target_url, routes.inject_as, routes.inject_key,
            routes.encrypted_secret, routes.secret_iv, routes.allowed_origin,
            routes.rate_limit_per_minute, routes.timeout_seconds, routes.retries, routes.allowed_methods,
            routes.allowed_paths, routes.allowed_ips, routes.extra_headers,
            routes.client_rate_limit_per_minute, routes.require_human,
            routes.paused as route_paused,
            projects.paused as project_paused
     FROM tokens
     JOIN routes ON routes.id = tokens.route_id
     JOIN projects ON projects.id = routes.project_id
     WHERE tokens.token_hash = ?`
  )
    .bind(tokenHash)
    .first<TokenJoinRow>();
}

export async function updateProject(env: Env, projectId: string, name: string, paused: boolean) {
  await env.DB.prepare("UPDATE projects SET name = ?, paused = ? WHERE id = ?").bind(name, paused ? 1 : 0, projectId).run();
}

export async function deleteRoute(env: Env, routeId: string) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tokens WHERE route_id = ?").bind(routeId),
    env.DB.prepare("DELETE FROM routes WHERE id = ?").bind(routeId),
  ]);
}

export async function deleteProject(env: Env, projectId: string) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tokens WHERE route_id IN (SELECT id FROM routes WHERE project_id = ?)").bind(projectId),
    env.DB.prepare("DELETE FROM routes WHERE project_id = ?").bind(projectId),
    env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId),
  ]);
}
