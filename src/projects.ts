import type { Env, SessionData } from "./types";
import {
  listProjects,
  getOwnedProject,
  createProject,
  listRoutes,
  getOwnedRoute,
  labelTaken,
  createRoute,
  setRoutePaused,
  listTokensForRoute,
  createToken,
  getOwnedToken,
  revokeToken,
} from "./db";
import { encryptSecret, randomId, randomToken, sha256Hex } from "./crypto";
import { jsonError, jsonOk } from "./responses";

const MAX_PROJECTS = 20;
const MAX_ROUTES_PER_PROJECT = 50;
const MAX_ACTIVE_TOKENS_PER_ROUTE = 10;
const VALID_INJECT_AS = new Set(["header", "query"]);

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/" && !url.search;
  } catch {
    return false;
  }
}

export async function handleListProjects(env: Env, session: SessionData): Promise<Response> {
  const projects = await listProjects(env, session.userId);
  return jsonOk({ projects });
}

export async function handleCreateProject(request: Request, env: Env, session: SessionData): Promise<Response> {
  let body: { name?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid_body", "Request body must be valid JSON.", 400);
  }

  const name = (body.name ?? "").trim();
  if (!name || name.length > 80) {
    return jsonError("invalid_name", "Project name must be 1 to 80 characters.", 400);
  }

  const existing = await listProjects(env, session.userId);
  if (existing.length >= MAX_PROJECTS) {
    return jsonError("project_limit", `You can have at most ${MAX_PROJECTS} projects on this plan.`, 403);
  }

  const id = randomId();
  await createProject(env, id, session.userId, name);
  return jsonOk({ project: { id, name, paused: 0 } }, 201);
}

export async function handleListRoutes(env: Env, session: SessionData, projectId: string): Promise<Response> {
  const project = await getOwnedProject(env, projectId, session.userId);
  if (!project) {
    return jsonError("not_found", "Project not found.", 404);
  }
  const routes = await listRoutes(env, projectId);
  return jsonOk({ routes });
}

export async function handleCreateRoute(request: Request, env: Env, session: SessionData, projectId: string): Promise<Response> {
  const project = await getOwnedProject(env, projectId, session.userId);
  if (!project) {
    return jsonError("not_found", "Project not found.", 404);
  }

  let body: {
    label?: string;
    targetUrl?: string;
    injectAs?: string;
    injectKey?: string;
    secret?: string;
    allowedOrigin?: string;
    rateLimitPerMinute?: number;
  };
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid_body", "Request body must be valid JSON.", 400);
  }

  const label = (body.label ?? "").trim();
  const targetUrl = (body.targetUrl ?? "").trim();
  const injectAs = body.injectAs ?? "";
  const injectKey = (body.injectKey ?? "").trim();
  const secret = body.secret ?? "";
  const allowedOrigin = body.allowedOrigin ? body.allowedOrigin.trim() : null;
  const rateLimitPerMinute = Number.isFinite(body.rateLimitPerMinute) ? Math.floor(body.rateLimitPerMinute as number) : 60;

  if (!label || label.length > 40 || !/^[a-z0-9-]+$/.test(label)) {
    return jsonError("invalid_label", "Label must be lowercase letters, numbers and hyphens, up to 40 characters.", 400);
  }
  if (!isHttpsUrl(targetUrl)) {
    return jsonError("invalid_target_url", "Target URL must be a full https:// URL.", 400);
  }
  if (!VALID_INJECT_AS.has(injectAs)) {
    return jsonError("invalid_inject_as", "injectAs must be \"header\" or \"query\".", 400);
  }
  if (!injectKey || injectKey.length > 100) {
    return jsonError("invalid_inject_key", "Provide the header or query parameter name to inject the secret as.", 400);
  }
  if (!secret || secret.length > 4000) {
    return jsonError("invalid_secret", "Secret value must be 1 to 4000 characters.", 400);
  }
  if (allowedOrigin && !isValidOrigin(allowedOrigin)) {
    return jsonError("invalid_allowed_origin", "Allowed origin must look like https://example.com with no path.", 400);
  }
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 6000) {
    return jsonError("invalid_rate_limit", "Rate limit must be an integer between 1 and 6000 requests per minute.", 400);
  }

  const existingRoutes = await listRoutes(env, projectId);
  if (existingRoutes.length >= MAX_ROUTES_PER_PROJECT) {
    return jsonError("route_limit", `This project already has the maximum of ${MAX_ROUTES_PER_PROJECT} routes.`, 403);
  }
  if (await labelTaken(env, projectId, label)) {
    return jsonError("label_taken", "A route with this label already exists in this project.", 409);
  }

  const { ciphertext, iv } = await encryptSecret(secret, env.MASTER_KEY);
  const routeId = randomId();
  await createRoute(env, {
    id: routeId,
    projectId,
    label,
    targetUrl,
    injectAs: injectAs as "header" | "query",
    injectKey,
    encryptedSecret: ciphertext,
    secretIv: iv,
    allowedOrigin,
    rateLimitPerMinute,
  });

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const tokenId = randomId();
  await createToken(env, tokenId, routeId, tokenHash);

  return jsonOk(
    {
      route: { id: routeId, label, targetUrl, injectAs, injectKey, allowedOrigin, rateLimitPerMinute, paused: 0 },
      token,
    },
    201
  );
}

export async function handlePauseRoute(request: Request, env: Env, session: SessionData, routeId: string): Promise<Response> {
  const route = await getOwnedRoute(env, routeId, session.userId);
  if (!route) {
    return jsonError("not_found", "Route not found.", 404);
  }

  let body: { paused?: boolean };
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid_body", "Request body must be valid JSON.", 400);
  }

  await setRoutePaused(env, routeId, Boolean(body.paused));
  return jsonOk({ ok: true, paused: Boolean(body.paused) });
}

export async function handleListTokens(env: Env, session: SessionData, routeId: string): Promise<Response> {
  const route = await getOwnedRoute(env, routeId, session.userId);
  if (!route) {
    return jsonError("not_found", "Route not found.", 404);
  }
  const tokens = await listTokensForRoute(env, routeId);
  return jsonOk({ tokens });
}

export async function handleCreateToken(env: Env, session: SessionData, routeId: string): Promise<Response> {
  const route = await getOwnedRoute(env, routeId, session.userId);
  if (!route) {
    return jsonError("not_found", "Route not found.", 404);
  }

  const existing = await listTokensForRoute(env, routeId);
  const activeCount = existing.filter((t: any) => t.revoked === 0).length;
  if (activeCount >= MAX_ACTIVE_TOKENS_PER_ROUTE) {
    return jsonError("token_limit", `This route already has the maximum of ${MAX_ACTIVE_TOKENS_PER_ROUTE} active tokens. Revoke one first.`, 403);
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const tokenId = randomId();
  await createToken(env, tokenId, routeId, tokenHash);

  return jsonOk({ token, tokenId }, 201);
}

export async function handleRevokeToken(env: Env, session: SessionData, tokenId: string): Promise<Response> {
  const owned = await getOwnedToken(env, tokenId, session.userId);
  if (!owned) {
    return jsonError("not_found", "Token not found.", 404);
  }
  await revokeToken(env, tokenId);
  return jsonOk({ ok: true });
}
