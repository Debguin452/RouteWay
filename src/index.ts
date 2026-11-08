import type { Env } from "./types";
import { getSession, requireCsrf, handleSignup, handleLogin, handleLogout, handleMe } from "./auth";
import {
  handleListProjects,
  handleCreateProject,
  handleListRoutes,
  handleCreateRoute,
  handlePauseRoute,
  handleListTokens,
  handleCreateToken,
  handleRevokeToken,
} from "./projects";
import { handleProxy, handleProxyPreflight } from "./proxy";
import { jsonError, corsHeaders, withHeaders } from "./responses";
import { handleDebug } from "./debug";

export { RateLimiter } from "./rateLimiter";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isProxy = url.pathname.startsWith("/proxy/");

    // CORS for the dashboard is decided up front and attached to EVERY non-proxy response,
    // including crashes, 404s and the debug page. A cross-origin response without these headers
    // is hidden from the browser and looks like "can't reach the server".
    const dashboardCors = isProxy
      ? {}
      : corsHeaders(request.headers.get("origin"), env.DASHBOARD_ORIGIN, true, request.headers.get("access-control-request-headers"));

    // Preflight for dashboard routes is answered before anything that touches D1, KV or Durable Objects.
    if (!isProxy && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: dashboardCors });
    }

    let response: Response;
    try {
      response = await route(request, env, url);
    } catch (err) {
      console.error("unhandled error", err instanceof Error ? err.stack : err);
      response = jsonError("internal_error", "Something went wrong on our end.", 500);
    }
    return isProxy ? response : withHeaders(response, dashboardCors);
  },
};

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (path.startsWith("/proxy/")) {
    const token = path.slice("/proxy/".length).split("/")[0];
    if (!token) {
      return jsonError("missing_token", "No token was provided in the URL.", 400);
    }
    if (request.method === "OPTIONS") {
      return handleProxyPreflight(request, env, token);
    }
    // Everything after /proxy/<token> is forwarded to the route's base URL (locked to its origin and path prefix).
    const restPath = path.slice("/proxy/".length + token.length);
    return handleProxy(request, env, token, restPath, url.search);
  }

  if (path === "/api/debug" && request.method === "GET") {
    return handleDebug(request, env);
  }

  if (!path.startsWith("/api/")) {
    return jsonError("not_found", "No such endpoint.", 404);
  }

  return handleApi(request, env, path);
}

async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/api/signup" && request.method === "POST") {
    return handleSignup(request, env);
  }
  if (path === "/api/login" && request.method === "POST") {
    return handleLogin(request, env);
  }
  if (path === "/api/logout" && request.method === "POST") {
    return handleLogout(request, env);
  }
  if (path === "/api/me" && request.method === "GET") {
    return handleMe(request, env);
  }

  const session = await getSession(request, env);
  if (!session) {
    return jsonError("not_authenticated", "You are not signed in.", 401);
  }

  if (MUTATING_METHODS.has(request.method)) {
    const csrfError = requireCsrf(request, session.data);
    if (csrfError) return csrfError;
  }

  if (path === "/api/projects" && request.method === "GET") {
    return handleListProjects(env, session.data);
  }
  if (path === "/api/projects" && request.method === "POST") {
    return handleCreateProject(request, env, session.data);
  }

  const routesMatch = path.match(/^\/api\/projects\/([^/]+)\/routes$/);
  if (routesMatch && request.method === "GET") {
    return handleListRoutes(env, session.data, routesMatch[1]);
  }
  if (routesMatch && request.method === "POST") {
    return handleCreateRoute(request, env, session.data, routesMatch[1]);
  }

  const pauseMatch = path.match(/^\/api\/routes\/([^/]+)\/pause$/);
  if (pauseMatch && request.method === "POST") {
    return handlePauseRoute(request, env, session.data, pauseMatch[1]);
  }

  const tokensMatch = path.match(/^\/api\/routes\/([^/]+)\/tokens$/);
  if (tokensMatch && request.method === "GET") {
    return handleListTokens(env, session.data, tokensMatch[1]);
  }
  if (tokensMatch && request.method === "POST") {
    return handleCreateToken(env, session.data, tokensMatch[1]);
  }

  const revokeMatch = path.match(/^\/api\/tokens\/([^/]+)\/revoke$/);
  if (revokeMatch && request.method === "POST") {
    return handleRevokeToken(env, session.data, revokeMatch[1]);
  }

  return jsonError("not_found", "No such endpoint.", 404);
}
