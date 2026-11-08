const normalizeOrigin = (o: string) => o.trim().replace(/\/+$/, "");

export function corsHeaders(
  origin: string | null,
  allowedOrigin: string,
  credentials: boolean,
  requestedHeaders: string | null = null
): Record<string, string> {
  if (!origin || !allowedOrigin || normalizeOrigin(origin) !== normalizeOrigin(allowedOrigin)) return {};
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    // Reflect what the browser asks for so custom headers (CSRF, Authorization, ...) never break preflight.
    "Access-Control-Allow-Headers": requestedHeaders || "Content-Type,X-CSRF-Token,Authorization",
    "Access-Control-Expose-Headers": "Retry-After",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (credentials) headers["Access-Control-Allow-Credentials"] = "true";
  return headers;
}

/** Returns a copy of the response with extra headers. Safe for responses with immutable headers (fetch results). */
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
