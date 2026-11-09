import type { Env, RouteRecord, SessionData } from "./types";
import { applySettings, DEFAULT_SETTINGS, LIMITS } from "./settings";
import {
  listProjects,
  getOwnedProject,
  createProject,
  updateProject,
  deleteProject,
  listRoutes,
  getOwnedRoute,
  labelTaken,
  createRoute,
  deleteRoute,
  setRoutePaused,
  updateRouteSettings,
  updateRouteSecret,
  listTokensForRoute,
  createToken,
  getOwnedToken,
  revokeToken,
} from "./db";
import { encryptSecret, randomId, randomToken, sha256Hex } from "./crypto";
import { jsonError, jsonOk } from "./responses";
import { getRouteStats } from "./rateLimiter";

const MAX_PROJECTS = 20;
const MAX_ROUTES_PER_PROJECT = 50;
const MAX_ACTIVE_TOKENS_PER_ROUTE = 10;
const VALID_INJECT_AS = new Set(["header", "query"]);

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const invalidBody = () => jsonError("invalid_body", "Request body must be valid JSON.", 400);
const routeNotFound = () => jsonError("not_found", "Route not found.", 404);
const projectNotFound = () => jsonError("not_found", "Project not found.", 404);

function settingsOf(route: RouteRecord) {
  return {
    allowedOrigin: route.allowed_origin,
    allowedMethods: route.allowed_methods,
    allowedPaths: route.allowed_paths,
    allowedIps: route.allowed_ips,
    extraHeaders: route.extra_headers,
    rateLimitPerMinute: route.rate_limit_per_minute,
    timeoutSeconds: route.timeout_seconds,
    retries: route.retries,
  };
}

export async function handleListProjects(env: Env, session: SessionData): Promise<Response> {
  const projects = await listProjects(env, session.userId);
  return jsonOk({ projects });
}

export async function handleCreateProject(request: Request, env: Env, session: SessionData): Promise<Response> {
  const body = await readJson(request);
  if (!body) return invalidBody();

  const name = String(body.name ?? "").trim();
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

export async function handleUpdateProject(request: Request, env: Env, session: SessionData, projectId: string): Promise<Response> {
  const project = await getOwnedProject(env, projectId, session.userId);
  if (!project) return projectNotFound();
  const body = await readJson(request);
  if (!body) return invalidBody();

  let name = project.name;
  if ("name" in body) {
    name = String(body.name ?? "").trim();
    if (!name || name.length > 80) {
      return jsonError("invalid_name", "Project name must be 1 to 80 characters.", 400);
    }
  }
  const paused = "paused" in body ? Boolean(body.paused) : project.paused === 1;

  await updateProject(env, projectId, name, paused);
  return jsonOk({ project: { id: projectId, name, paused: paused ? 1 : 0 } });
}

export async function handleDeleteProject(env: Env, session: SessionData, projectId: string): Promise<Response> {
  const project = await getOwnedProject(env, projectId, session.userId);
  if (!project) return projectNotFound();
  await deleteProject(env, projectId);
  return jsonOk({ ok: true });
}

export async function handleListRoutes(env: Env, session: SessionData, projectId: string): Promise<Response> {
  const project = await getOwnedProject(env, projectId, session.userId);
  if (!project) return projectNotFound();
  const routes = (await listRoutes(env, projectId)) as { id: string }[];
  const withStats = await Promise.all(routes.map(async (route) => ({ ...route, stats: await getRouteStats(env, route.id) })));
  return jsonOk({ routes: withStats });
}

export async function handleCreateRoute(request: Request, env: Env, session: SessionData, projectId: string): Promise<Response> {
  const project = await getOwnedProject(env, projectId, session.userId);
  if (!project) return projectNotFound();

  const body = await readJson(request);
  if (!body) return invalidBody();

  const label = String(body.label ?? "").trim();
  const targetUrl = String(body.targetUrl ?? "").trim();
  const injectAs = String(body.injectAs ?? "");
  const injectKey = String(body.injectKey ?? "").trim();
  const secret = String(body.secret ?? "");

  if (!label || label.length > 40 || !/^[a-z0-9-]+$/.test(label)) {
    return jsonError("invalid_label", "Label must be lowercase letters, numbers and hyphens, up to 40 characters.", 400);
  }
  if (!isHttpsUrl(targetUrl)) {
    return jsonError("invalid_target_url", "Target URL must be a full https:// URL.", 400);
  }
  if (!VALID_INJECT_AS.has(injectAs)) {
    return jsonError("invalid_inject_as", 'injectAs must be "header" or "query".', 400);
  }
  if (!injectKey || injectKey.length > 100) {
    return jsonError("invalid_inject_key", "Provide the header or query parameter name to inject the secret as.", 400);
  }
  if (!secret || secret.length > 4000) {
    return jsonError("invalid_secret", "Secret value must be 1 to 4000 characters.", 400);
  }

  const parsed = applySettings(body, DEFAULT_SETTINGS);
  if ("error" in parsed) return jsonError(parsed.error.code, parsed.error.message, 400);
  const settings = parsed.value;

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
    ...settings,
  });

  const token = randomToken();
  await createToken(env, randomId(), routeId, await sha256Hex(token));

  return jsonOk({ route: { id: routeId, label, targetUrl, injectAs, injectKey, ...settings, paused: 0 }, token }, 201);
}

export async function handleUpdateRoute(request: Request, env: Env, session: SessionData, routeId: string): Promise<Response> {
  const route = await getOwnedRoute(env, routeId, session.userId);
  if (!route) return routeNotFound();
  const body = await readJson(request);
  if (!body) return invalidBody();

  const parsed = applySettings(body, settingsOf(route));
  if ("error" in parsed) return jsonError(parsed.error.code, parsed.error.message, 400);

  await updateRouteSettings(env, routeId, parsed.value);
  return jsonOk({ ok: true, settings: parsed.value });
}

export async function handleRotateSecret(request: Request, env: Env, session: SessionData, routeId: string): Promise<Response> {
  const route = await getOwnedRoute(env, routeId, session.userId);
  if (!route) return routeNotFound();
  const body = await readJson(request);
  const secret = String(body?.secret ?? "");
  if (!secret || secret.length > 4000) {
    return jsonError("invalid_secret", "Secret value must be 1 to 4000 characters.", 400);
  }
  const { ciphertext, iv } = await encryptSecret(secret, env.MASTER_KEY);
  await updateRouteSecret(env, routeId, ciphertext, iv);
  return jsonOk({ ok: true });
}

export async function handleDeleteRoute(env: Env, session: SessionData, routeId: string): Promise<Response> {
  const route = await getOwnedRoute(env, routeId, session.userId);
  if (!route) return routeNotFound();
  await deleteRoute(env, routeId);
  return jsonOk({ ok: true });
}

export async function handlePauseRoute(request: Request, env: Env, session: SessionData, routeId: string): Promise<Response> {
  const route = await getOwnedRoute(env, routeId, session.userId);
  if (!route) return routeNotFound();
  const body = await readJson(request);
  if (!body) return invalidBody();
  await setRoutePaused(env, routeId, Boolean(body.paused));
  return jsonOk({ ok: true, paused: Boolean(body.paused) });
}

export async function handleListTokens(env: Env, session: SessionData, routeId: string): Promise<Response> {
  const route = await getOwnedRoute(env, routeId, session.userId);
  if (!route) return routeNotFound();
  const tokens = await listTokensForRoute(env, routeId);
  return jsonOk({ tokens });
}

export async function handleCreateToken(request: Request, env: Env, session: SessionData, routeId: string): Promise<Response> {
  const route = await getOwnedRoute(env, routeId, session.userId);
  if (!route) return routeNotFound();

  const body = (await readJson(request)) ?? {};

  let expiresAt: number | null = null;
  if (body.expiresInDays !== undefined && body.expiresInDays !== null && body.expiresInDays !== "") {
    const days = Number(body.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > LIMITS.tokenLifetimeDays) {
      return jsonError("invalid_expiry", `Expiry must be a whole number of days between 1 and ${LIMITS.tokenLifetimeDays}.`, 400);
    }
    expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
  }

  const label = body.label === undefined || body.label === null ? "" : String(body.label).trim();
  if (label.length > LIMITS.tokenLabel) {
    return jsonError("invalid_label", `Token label can be at most ${LIMITS.tokenLabel} characters.`, 400);
  }

  const existing = await listTokensForRoute(env, routeId);
  const activeCount = existing.filter((t: any) => t.revoked === 0).length;
  if (activeCount >= MAX_ACTIVE_TOKENS_PER_ROUTE) {
    return jsonError("token_limit", `This route already has the maximum of ${MAX_ACTIVE_TOKENS_PER_ROUTE} active tokens. Revoke one first.`, 403);
  }

  const token = randomToken();
  const tokenId = randomId();
  await createToken(env, tokenId, routeId, await sha256Hex(token), expiresAt, label || null);

  return jsonOk({ token, tokenId, expiresAt, label: label || null }, 201);
}

export async function handleRevokeToken(env: Env, session: SessionData, tokenId: string): Promise<Response> {
  const owned = await getOwnedToken(env, tokenId, session.userId);
  if (!owned) {
    return jsonError("not_found", "Token not found.", 404);
  }
  await revokeToken(env, tokenId);
  return jsonOk({ ok: true });
}
