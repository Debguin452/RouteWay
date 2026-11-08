export function corsHeaders(origin: string | null, allowedOrigin: string, credentials: boolean): Record<string, string> {
  if (!origin || origin !== allowedOrigin) return {};
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-CSRF-Token",
    Vary: "Origin",
  };
  if (credentials) headers["Access-Control-Allow-Credentials"] = "true";
  return headers;
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
