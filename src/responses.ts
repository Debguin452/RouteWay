const normalizeOrigin = (o: string) => o.trim().replace(/\/+$/, "");

export function originMatches(origin: string | null, allowedOrigins: string | null): boolean {
  if (!origin || !allowedOrigins) return false;
  const wanted = normalizeOrigin(origin);
  return allowedOrigins.split(",").some((allowed) => normalizeOrigin(allowed) === wanted);
}

export function corsHeaders(
  origin: string | null,
  allowedOrigin: string,
  credentials: boolean,
  requestedHeaders: string | null = null
): Record<string, string> {
  if (!originMatches(origin, allowedOrigin)) return {};
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin as string,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": requestedHeaders || "Content-Type,X-CSRF-Token,Authorization",
    "Access-Control-Expose-Headers": "Retry-After,X-Request-Id,X-RateLimit-Limit,X-RateLimit-Remaining,X-Routeway-Pass,X-Routeway-Pass-Ttl",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (credentials) headers["Access-Control-Allow-Credentials"] = "true";
  return headers;
}

export function withHeaders(res: Response, extra: Record<string, string>): Response {
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  for (const [key, value] of Object.entries(extra)) {
    if (key.toLowerCase() === "vary") out.headers.append("Vary", value);
    else out.headers.set(key, value);
  }
  return out;
}

export function jsonError(code: string, message: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export function jsonOk(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
