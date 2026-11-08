import type { Env } from "./types";

interface Window {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const { limit, windowSeconds } = await request.json<{ limit: number; windowSeconds: number }>();
    const now = Date.now();
    const stored = await this.state.storage.get<Window>("window");
    let windowStart = stored?.windowStart ?? now;
    let count = stored?.count ?? 0;

    if (now - windowStart >= windowSeconds * 1000) {
      windowStart = now;
      count = 0;
    }

    count += 1;
    await this.state.storage.put<Window>("window", { count, windowStart });

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
  const id = env.RATE_LIMITER.idFromName(bucketName);
  const stub = env.RATE_LIMITER.get(id);
  const response = await stub.fetch("https://rate-limiter.internal/", {
    method: "POST",
    body: JSON.stringify({ limit, windowSeconds }),
  });
  return response.json<RateLimitResult>();
}
