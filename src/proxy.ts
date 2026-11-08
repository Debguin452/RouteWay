import type { Env, TokenJoinRow } from "./types";
import { getTokenWithRouteByHash } from "./db";
import { decryptSecret, sha256Hex } from "./crypto";
import { jsonError, corsHeaders } from "./responses";
import { checkRateLimit } from "./rateLimiter";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10000;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "authorization",
  "cookie",
]);

export async function handleProxyPreflight(request: Request, env: Env, token: string): Promise<Response> {
  const tokenHash = await sha256Hex(token);
  const row = await getTokenWithRouteByHash(env, tokenHash);
  const origin = request.headers.get("origin");

  if (!row || !row.allowed_origin) {
    return new Response(null, { status: 204 });
  }

  const headers = corsHeaders(origin, row.allowed_origin, false);
  return new Response(null, { status: 204, headers });
}

export async function handleProxy(request: Request, env: Env, token: string): Promise<Response> {
  let row: TokenJoinRow | null;
  try {
    const tokenHash = await sha256Hex(token);
    row = await getTokenWithRouteByHash(env, tokenHash);
  } catch (err) {
    console.error("proxy lookup failed", err);
    return jsonError("internal_error", "Something went wrong looking up this token.", 500);
  }

  const origin = request.headers.get("origin");
  const cors = row?.allowed_origin ? corsHeaders(origin, row.allowed_origin, false) : {};

  if (!row) {
    return jsonError("invalid_token", "This token is invalid or does not exist.", 401, cors);
  }
  if (row.token_revoked) {
    return jsonError("token_revoked", "This token has been revoked.", 401, cors);
  }
  if (row.project_paused) {
    return jsonError("project_paused", "The project behind this token is paused.", 403, cors);
  }
  if (row.route_paused) {
    return jsonError("route_paused", "This route is paused.", 403, cors);
  }

  if (row.allowed_origin && origin && origin !== row.allowed_origin) {
    return jsonError("origin_not_allowed", "Requests from this origin are not allowed for this token.", 403);
  }

  let rate;
  try {
    rate = await checkRateLimit(env, `route:${row.route_id}`, row.rate_limit_per_minute, 60);
  } catch (err) {
    console.error("rate limiter unavailable", err);
    return jsonError("internal_error", "Rate limiter is temporarily unavailable.", 503, cors);
  }
  if (!rate.allowed) {
    return jsonError("rate_limited", "This route has exceeded its rate limit.", 429, {
      ...cors,
      "Retry-After": String(rate.retryAfter),
    });
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return jsonError("payload_too_large", "Request body exceeds the 5MB limit.", 413, cors);
  }

  let secret: string;
  try {
    secret = await decryptSecret(row.encrypted_secret, row.secret_iv, env.MASTER_KEY);
  } catch (err) {
    console.error("secret decryption failed for route", row.route_id, err);
    return jsonError("internal_error", "Could not prepare this route right now.", 500, cors);
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(row.target_url);
  } catch {
    console.error("route has invalid target_url", row.route_id);
    return jsonError("internal_error", "This route is misconfigured.", 500, cors);
  }

  if (row.inject_as === "query") {
    targetUrl.searchParams.set(row.inject_key, secret);
  }

  const outboundHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== "origin") {
      outboundHeaders.set(key, value);
    }
  }
  if (row.inject_as === "header") {
    outboundHeaders.set(row.inject_key, secret);
  }

  const bodyAllowed = !["GET", "HEAD"].includes(request.method);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: outboundHeaders,
      body: bodyAllowed ? request.body : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      return jsonError("upstream_timeout", "The upstream service took too long to respond.", 504, cors);
    }
    console.error("upstream fetch failed for route", row.route_id, err);
    return jsonError("upstream_unreachable", "Could not reach the upstream service.", 502, cors);
  }
  clearTimeout(timeout);

  const responseHeaders = new Headers();
  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (key.toLowerCase() !== "set-cookie") {
      responseHeaders.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(cors)) {
    responseHeaders.set(key, value);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
