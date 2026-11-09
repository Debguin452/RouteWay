import type { Env } from "./types";

interface Window {
  count: number;
  windowStart: number;
  total?: number;
  lastUsedAt?: number;
  bannedUntil?: number;
}

export interface RouteStats {
  total: number;
  lastUsedAt: number | null;
}

export interface ActivityEntry {
  at: number;
  method: string;
  path: string;
  status: number;
  ms: number;
  country: string | null;
  note: string | null;
}

export interface BanPolicy {
  afterCount: number;
  seconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
  blocked?: boolean;
}

const MAX_ACTIVITY = 100;
const INTERNAL = "https://rate-limiter.internal";

export class RateLimiter {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const stored = await this.state.storage.get<Window>("window");

    if (path === "/stats") {
      return Response.json({ total: stored?.total ?? 0, lastUsedAt: stored?.lastUsedAt ?? null });
    }

    if (path === "/activity") {
      const entries = (await this.state.storage.get<ActivityEntry[]>("activity")) ?? [];
      return Response.json({ entries });
    }

    if (path === "/log") {
      const entry = await request.json<ActivityEntry>();
      const entries = (await this.state.storage.get<ActivityEntry[]>("activity")) ?? [];
      entries.unshift(entry);
      await this.state.storage.put("activity", entries.slice(0, MAX_ACTIVITY));
      return Response.json({ ok: true });
    }

    const { limit, windowSeconds, ban } = await request.json<{ limit: number; windowSeconds: number; ban?: BanPolicy }>();
    const now = Date.now();

    if (stored?.bannedUntil && stored.bannedUntil > now) {
      const retryAfter = Math.max(1, Math.ceil((stored.bannedUntil - now) / 1000));
      return Response.json({ allowed: false, remaining: 0, retryAfter, blocked: true } satisfies RateLimitResult);
    }

    let windowStart = stored?.windowStart ?? now;
    let count = stored?.count ?? 0;
    if (now - windowStart >= windowSeconds * 1000) {
      windowStart = now;
      count = 0;
    }

    count += 1;
    const bannedUntil = ban && count > ban.afterCount ? now + ban.seconds * 1000 : undefined;
    await this.state.storage.put<Window>("window", {
      count,
      windowStart,
      total: (stored?.total ?? 0) + 1,
      lastUsedAt: now,
      bannedUntil,
    });

    if (bannedUntil) {
      return Response.json({ allowed: false, remaining: 0, retryAfter: ban!.seconds, blocked: true } satisfies RateLimitResult);
    }

    const allowed = count <= limit;
    const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((windowStart + windowSeconds * 1000 - now) / 1000));
    return Response.json({ allowed, remaining: Math.max(0, limit - count), retryAfter } satisfies RateLimitResult);
  }
}

export async function checkRateLimit(
  env: Env,
  bucketName: string,
  limit: number,
  windowSeconds: number,
  ban?: BanPolicy
): Promise<RateLimitResult> {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(bucketName));
  const response = await stub.fetch(`${INTERNAL}/`, {
    method: "POST",
    body: JSON.stringify({ limit, windowSeconds, ban }),
  });
  return response.json<RateLimitResult>();
}

export async function getRouteStats(env: Env, routeId: string): Promise<RouteStats | null> {
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`route:${routeId}`));
    const response = await stub.fetch(`${INTERNAL}/stats`);
    return await response.json<RouteStats>();
  } catch {
    return null;
  }
}

export async function getActivity(env: Env, routeId: string): Promise<ActivityEntry[]> {
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`route:${routeId}`));
    const response = await stub.fetch(`${INTERNAL}/activity`);
    return (await response.json<{ entries: ActivityEntry[] }>()).entries;
  } catch {
    return [];
  }
}

export async function recordActivity(env: Env, routeId: string, entry: ActivityEntry): Promise<void> {
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`route:${routeId}`));
    await stub.fetch(`${INTERNAL}/log`, { method: "POST", body: JSON.stringify(entry) });
  } catch (err) {
    console.error("activity log failed", err);
  }
}
