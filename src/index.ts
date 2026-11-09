import type { Env } from "./types";
import { getSession, requireCsrf, handleSignup, handleLogin, handleLogout, handleMe } from "./auth";
import {
  handleListProjects,
  handleCreateProject,
  handleListRoutes,
  handleCreateRoute,
  handlePauseRoute,
  handleUpdateRoute,
  handleDeleteRoute,
  handleRouteActivity,
  handleUpdateProject,
  handleDeleteProject,
  handleRotateSecret,
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isProxy = url.pathname.startsWith("/proxy/");

    const dashboardCors = isProxy
      ? {}
      : corsHeaders(request.headers.get("origin"), env.DASHBOARD_ORIGIN, true, request.headers.get("access-control-request-headers"));

    if (!isProxy && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: dashboardCors });
    }

    let response: Response;
    try {
      response = await route(request, env, url, ctx);
    } catch (err) {
      console.error("unhandled error", err instanceof Error ? err.stack : err);
      response = jsonError("internal_error", "Something went wrong on our end.", 500);
    }
    return isProxy ? response : withHeaders(response, dashboardCors);
  },
};

async function route(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;

  if (path.startsWith("/proxy/")) {
    const token = path.slice("/proxy/".length).split("/")[0];
    if (!token) {
      return jsonError("missing_token", "No token was provided in the URL.", 400);
    }
    if (request.method === "OPTIONS") {
      return handleProxyPreflight(request, env, token);
    }
    const restPath = path.slice("/proxy/".length + token.length);
    return handleProxy(request, env, ctx, token, restPath, url.search);
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

  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && request.method === "PATCH") {
    return handleUpdateProject(request, env, session.data, projectMatch[1]);
  }
  if (projectMatch && request.method === "DELETE") {
    return handleDeleteProject(env, session.data, projectMatch[1]);
  }

  const routesMatch = path.match(/^\/api\/projects\/([^/]+)\/routes$/);
  if (routesMatch && request.method === "GET") {
    return handleListRoutes(env, session.data, routesMatch[1]);
  }
  if (routesMatch && request.method === "POST") {
    return handleCreateRoute(request, env, session.data, routesMatch[1]);
  }

  const routeMatch = path.match(/^\/api\/routes\/([^/]+)$/);
  if (routeMatch && request.method === "PATCH") {
    return handleUpdateRoute(request, env, session.data, routeMatch[1]);
  }
  if (routeMatch && request.method === "DELETE") {
    return handleDeleteRoute(env, session.data, routeMatch[1]);
  }

  const activityMatch = path.match(/^\/api\/routes\/([^/]+)\/activity$/);
  if (activityMatch && request.method === "GET") {
    return handleRouteActivity(env, session.data, activityMatch[1]);
  }

  const secretMatch = path.match(/^\/api\/routes\/([^/]+)\/secret$/);
  if (secretMatch && request.method === "POST") {
    return handleRotateSecret(request, env, session.data, secretMatch[1]);
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
    return handleCreateToken(request, env, session.data, tokensMatch[1]);
  }

  const revokeMatch = path.match(/^\/api\/tokens\/([^/]+)\/revoke$/);
  if (revokeMatch && request.method === "POST") {
    return handleRevokeToken(env, session.data, revokeMatch[1]);
  }

  return jsonError("not_found", "No such endpoint.", 404);
}
