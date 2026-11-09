import type { Env } from "./types";

interface Window {
  count: number;
  windowStart: number;
  total?: number;
  lastUsedAt?: number;
}

export interface RouteStats {
  total: number;
  lastUsedAt: number | null;
}

export class RateLimiter {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const stored = await this.state.storage.get<Window>("window");

    if (new URL(request.url).pathname === "/stats") {
      return Response.json({ total: stored?.total ?? 0, lastUsedAt: stored?.lastUsedAt ?? null });
    }

    const { limit, windowSeconds } = await request.json<{ limit: number; windowSeconds: number }>();
    const now = Date.now();
    let windowStart = stored?.windowStart ?? now;
    let count = stored?.count ?? 0;

    if (now - windowStart >= windowSeconds * 1000) {
      windowStart = now;
      count = 0;
    }

    count += 1;
    await this.state.storage.put<Window>("window", { count, windowStart, total: (stored?.total ?? 0) + 1, lastUsedAt: now });

    const allowed = count <= limit;
    const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((windowStart + windowSeconds * 1000 - now) / 1000));

    return Response.json({ allowed, remaining: Math.max(0, limit - count), retryAfter });
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

export async function checkRateLimit(env: Env, bucketName: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(bucketName));
  const response = await stub.fetch("https://rate-limiter.internal/", {
    method: "POST",
    body: JSON.stringify({ limit, windowSeconds }),
  });
  return response.json<RateLimitResult>();
}

export async function getRouteStats(env: Env, routeId: string): Promise<RouteStats | null> {
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`route:${routeId}`));
    const response = await stub.fetch("https://rate-limiter.internal/stats");
    return await response.json<RouteStats>();
  } catch {
    return null;
  }
}
