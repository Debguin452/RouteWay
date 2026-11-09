import type { Env, TokenJoinRow } from "./types";
import { getTokenWithRouteByHash } from "./db";
import { decryptSecret, sha256Hex } from "./crypto";
import { jsonError, corsHeaders, originMatches } from "./responses";
import { checkRateLimit, recordActivity } from "./rateLimiter";
import { PASS_TTL_SECONDS, deriveClientId, signPass, verifyPass, verifyTurnstile } from "./human";
import { buildTargetUrl } from "./target";
import { ipAllowed, pathAllowed, readExtraHeaders } from "./settings";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const RETRY_STATUSES = new Set([502, 503, 504]);
const RETRY_BASE_DELAY_MS = 250;
const CLIENT_BAN_MULTIPLE = 10;
const CLIENT_BAN_SECONDS = 3600;
const MAX_LOGGED_PATH = 120;
const REQUEST_HEADER_DROP = new Set([
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
  "origin",
  "x-real-ip",
  "x-turnstile-token",
  "x-routeway-pass",
]);
const RESPONSE_HEADER_DROP = new Set(["set-cookie", "set-cookie2", "content-encoding", "content-length", "transfer-encoding"]);

class UpstreamTimeout extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function shouldDropRequestHeader(name: string): boolean {
  return REQUEST_HEADER_DROP.has(name) || name.startsWith("cf-") || name.startsWith("x-forwarded-");
}

async function readBodyLimited(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchUpstream(url: string, init: RequestInit, timeoutMs: number, retries: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new UpstreamTimeout();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (RETRY_STATUSES.has(response.status) && attempt < retries) {
        await response.body?.cancel();
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        attempt += 1;
        continue;
      }
      return response;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") throw new UpstreamTimeout();
      if (attempt >= retries) throw err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      attempt += 1;
    }
  }
}

export async function handleProxyPreflight(request: Request, env: Env, token: string): Promise<Response> {
  let row: TokenJoinRow | null;
  try {
    row = await getTokenWithRouteByHash(env, await sha256Hex(token));
  } catch (err) {
    console.error("proxy preflight lookup failed", err);
    return jsonError("internal_error", "Something went wrong looking up this token.", 500);
  }

  if (!row || !row.allowed_origin) {
    return new Response(null, { status: 204 });
  }

  const headers = corsHeaders(request.headers.get("origin"), row.allowed_origin, false, request.headers.get("access-control-request-headers"));
  return new Response(null, { status: 204, headers });
}

export async function handleProxy(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
  restPath = "",
  clientSearch = ""
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const trace = { routeId: "", note: null as string | null };
  let result: Response;

  try {
    result = await proxy(request, env, token, restPath, clientSearch, requestId, trace);
  } catch (err) {
    console.error("proxy failed", requestId, err instanceof Error ? err.stack : err);
    trace.note = "internal_error";
    result = jsonError("internal_error", "Something went wrong on our end.", 500, { "x-request-id": requestId });
  }

  const ms = Date.now() - startedAt;
  console.log(JSON.stringify({ requestId, routeId: trace.routeId, method: request.method, status: result.status, ms }));

  if (trace.routeId && env.ACTIVITY_LOG !== "off") {
    const country = (request.cf?.country as string | undefined) ?? null;
    ctx.waitUntil(
      recordActivity(env, trace.routeId, {
        at: startedAt,
        method: request.method,
        path: ("/" + restPath.replace(/^\/+/, "")).slice(0, MAX_LOGGED_PATH),
        status: result.status,
        ms,
        country,
        note: trace.note,
      })
    );
  }
  return result;
}

async function proxy(
  request: Request,
  env: Env,
  token: string,
  restPath: string,
  clientSearch: string,
  requestId: string,
  trace: { routeId: string; note: string | null }
): Promise<Response> {
  const fail = (code: string, message: string, status: number, headers: Record<string, string> = {}) => {
    trace.note = code;
    return jsonError(code, message, status, headers);
  };

  let row: TokenJoinRow | null;
  try {
    row = await getTokenWithRouteByHash(env, await sha256Hex(token));
  } catch (err) {
    console.error("proxy lookup failed", requestId, err);
    return fail("internal_error", "Something went wrong looking up this token.", 500, { "x-request-id": requestId });
  }

  const origin = request.headers.get("origin");
  const cors = row?.allowed_origin
    ? corsHeaders(origin, row.allowed_origin, false, request.headers.get("access-control-request-headers"))
    : {};
  const common: Record<string, string> = { ...cors, "x-request-id": requestId };

  if (!row) {
    return fail("invalid_token", "This token is invalid or does not exist.", 401, common);
  }
  trace.routeId = row.route_id;

  if (row.token_revoked) {
    return fail("token_revoked", "This token has been revoked.", 401, common);
  }
  if (row.token_expires_at && Date.now() > row.token_expires_at) {
    return fail("token_expired", "This token has expired.", 401, common);
  }
  if (row.project_paused) {
    return fail("project_paused", "The project behind this token is paused.", 403, common);
  }
  if (row.route_paused) {
    return fail("route_paused", "This route is paused.", 403, common);
  }
  if (row.allowed_origin && origin && !originMatches(origin, row.allowed_origin)) {
    return fail("origin_not_allowed", "Requests from this origin are not allowed for this token.", 403, common);
  }
  if (row.allowed_methods && !row.allowed_methods.split(",").includes(request.method)) {
    return fail("method_not_allowed", `This route only allows ${row.allowed_methods}.`, 405, { ...common, Allow: row.allowed_methods });
  }

  if (!pathAllowed(restPath, row.allowed_paths)) {
    return fail("path_not_allowed", "This token is not allowed to call that path.", 403, common);
  }
  if (!ipAllowed(request.headers.get("cf-connecting-ip"), row.allowed_ips)) {
    return fail("ip_not_allowed", "Requests from this IP address are not allowed for this token.", 403, common);
  }

  const callerIp = request.headers.get("cf-connecting-ip");
  let client = "";
  if (row.client_rate_limit_per_minute > 0 || row.require_human) {
    try {
      client = await deriveClientId(env, row.route_id, callerIp);
    } catch (err) {
      console.error("client id derivation failed", requestId, err);
      return fail("internal_error", "Could not prepare this route right now.", 500, common);
    }
  }

  if (row.client_rate_limit_per_minute > 0) {
    let clientRate;
    try {
      clientRate = await checkRateLimit(env, `client:${row.route_id}:${client}`, row.client_rate_limit_per_minute, 60, {
        afterCount: row.client_rate_limit_per_minute * CLIENT_BAN_MULTIPLE,
        seconds: CLIENT_BAN_SECONDS,
      });
    } catch (err) {
      console.error("client limiter unavailable", requestId, err);
      return fail("internal_error", "Rate limiter is temporarily unavailable.", 503, common);
    }
    if (!clientRate.allowed) {
      const code = clientRate.blocked ? "client_blocked" : "client_rate_limited";
      const message = clientRate.blocked
        ? "This caller was temporarily blocked for sending far too many requests."
        : "You are sending requests too quickly. Slow down and retry.";
      return fail(code, message, 429, { ...common, "Retry-After": String(clientRate.retryAfter) });
    }
  }

  if (row.require_human) {
    const pass = request.headers.get("x-routeway-pass");
    const challenge = request.headers.get("x-turnstile-token");
    if (!(pass && (await verifyPass(env, pass, row.route_id, client)))) {
      if (!challenge) {
        return fail("human_required", "Send a Cloudflare Turnstile token in the X-Turnstile-Token header.", 403, common);
      }
      const verdict = await verifyTurnstile(env, challenge);
      if (verdict === "unavailable") {
        return fail("human_check_unavailable", "Human verification is temporarily unavailable.", 503, common);
      }
      if (verdict === "failed") {
        return fail("human_check_failed", "Human verification failed. Get a fresh Turnstile token and retry.", 403, common);
      }
      common["x-routeway-pass"] = await signPass(env, row.route_id, client);
      common["x-routeway-pass-ttl"] = String(PASS_TTL_SECONDS);
    }
  }

  let rate;
  try {
    rate = await checkRateLimit(env, `route:${row.route_id}`, row.rate_limit_per_minute, 60);
  } catch (err) {
    console.error("rate limiter unavailable", requestId, err);
    return fail("internal_error", "Rate limiter is temporarily unavailable.", 503, common);
  }
  const rateHeaders = {
    ...common,
    "x-ratelimit-limit": String(row.rate_limit_per_minute),
    "x-ratelimit-remaining": String(rate.remaining),
  };
  if (!rate.allowed) {
    return fail("rate_limited", "This route has exceeded its rate limit.", 429, {
      ...rateHeaders,
      "Retry-After": String(rate.retryAfter),
    });
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return fail("payload_too_large", "Request body exceeds the 5MB limit.", 413, rateHeaders);
  }

  let secret: string;
  try {
    secret = await decryptSecret(row.encrypted_secret, row.secret_iv, env.MASTER_KEY);
  } catch (err) {
    console.error("secret decryption failed for route", row.route_id, requestId, err);
    return fail("internal_error", "Could not prepare this route right now.", 500, rateHeaders);
  }

  let targetUrl: URL | null;
  try {
    targetUrl = buildTargetUrl(row.target_url, restPath, clientSearch);
  } catch {
    console.error("route has invalid target_url", row.route_id, requestId);
    return fail("internal_error", "This route is misconfigured.", 500, rateHeaders);
  }
  if (!targetUrl) {
    return fail("invalid_path", "That path is not allowed for this token.", 400, rateHeaders);
  }

  if (row.inject_as === "query") {
    targetUrl.searchParams.set(row.inject_key, secret);
  }

  const outboundHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!shouldDropRequestHeader(key.toLowerCase())) {
      outboundHeaders.set(key, value);
    }
  }
  for (const [name, value] of readExtraHeaders(row.extra_headers)) {
    outboundHeaders.set(name, value);
  }
  if (row.inject_as === "header") {
    outboundHeaders.set(row.inject_key, secret);
  }

  const hasBody = !["GET", "HEAD"].includes(request.method);
  let body: BodyInit | undefined;
  if (hasBody && request.body) {
    if (contentLength) {
      body = request.body;
    } else {
      const bytes = await readBodyLimited(request.body, MAX_BODY_BYTES);
      if (!bytes) {
        return fail("payload_too_large", "Request body exceeds the 5MB limit.", 413, rateHeaders);
      }
      body = bytes;
    }
  }
  const init: RequestInit = { method: request.method, headers: outboundHeaders, body, redirect: "manual" };
  const retries = hasBody ? 0 : row.retries;

  let upstream: Response;
  try {
    upstream = await fetchUpstream(targetUrl.toString(), init, row.timeout_seconds * 1000, retries);
  } catch (err) {
    if (err instanceof UpstreamTimeout) {
      return fail("upstream_timeout", "The upstream service took too long to respond.", 504, rateHeaders);
    }
    console.error("upstream fetch failed for route", row.route_id, requestId, err);
    return fail("upstream_unreachable", "Could not reach the upstream service.", 502, rateHeaders);
  }

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    const name = key.toLowerCase();
    if (RESPONSE_HEADER_DROP.has(name) || name.startsWith("access-control-")) continue;
    responseHeaders.set(key, value);
  }
  for (const [key, value] of Object.entries(rateHeaders)) {
    responseHeaders.set(key, value);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
