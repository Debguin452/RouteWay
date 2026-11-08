import type { Env, SessionData } from "./types";
import { getUserByEmail, createUser, getUserById } from "./db";
import { hashPassword, verifyPassword, randomId, randomToken } from "./crypto";
import { jsonError, jsonOk } from "./responses";
import { checkRateLimit } from "./rateLimiter";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("cookie");
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function sessionCookie(sessionId: string): string {
  return `session=${sessionId}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie(): string {
  return "session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0";
}

export async function getSession(request: Request, env: Env): Promise<{ sessionId: string; data: SessionData } | null> {
  const cookies = parseCookies(request);
  const sessionId = cookies.session;
  if (!sessionId) return null;
  const raw = await env.SESSIONS.get(`session:${sessionId}`);
  if (!raw) return null;
  return { sessionId, data: JSON.parse(raw) as SessionData };
}

export function requireCsrf(request: Request, session: SessionData): Response | null {
  const header = request.headers.get("x-csrf-token");
  if (!header || header !== session.csrf) {
    return jsonError("csrf_mismatch", "This request is missing a valid CSRF token.", 403);
  }
  return null;
}

export async function handleSignup(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid_body", "Request body must be valid JSON.", 400);
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  if (!EMAIL_RE.test(email)) {
    return jsonError("invalid_email", "Enter a valid email address.", 400);
  }
  if (password.length < 10) {
    return jsonError("weak_password", "Password must be at least 10 characters.", 400);
  }

  const rate = await checkRateLimit(env, `signup:${email}`, 5, 600);
  if (!rate.allowed) {
    return jsonError("rate_limited", "Too many signup attempts. Try again later.", 429, {
      "Retry-After": String(rate.retryAfter),
    });
  }

  const existing = await getUserByEmail(env, email);
  if (existing) {
    return jsonError("email_taken", "An account with this email already exists.", 409);
  }

  const { hash, salt } = await hashPassword(password);
  const userId = randomId();
  await createUser(env, userId, email, hash, salt);

  return startSession(env, userId, email);
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid_body", "Request body must be valid JSON.", 400);
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  const rate = await checkRateLimit(env, `login:${email}`, 10, 900);
  if (!rate.allowed) {
    return jsonError("rate_limited", "Too many login attempts. Try again later.", 429, {
      "Retry-After": String(rate.retryAfter),
    });
  }

  const user = await getUserByEmail(env, email);
  if (!user) {
    return jsonError("invalid_credentials", "Incorrect email or password.", 401);
  }

  const valid = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!valid) {
    return jsonError("invalid_credentials", "Incorrect email or password.", 401);
  }

  return startSession(env, user.id, email);
}

async function startSession(env: Env, userId: string, email: string): Promise<Response> {
  const sessionId = randomToken();
  const csrf = randomToken();
  const data: SessionData = { userId, csrf };
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(data), { expirationTtl: SESSION_TTL_SECONDS });

  return jsonOk(
    { user: { id: userId, email }, csrf },
    200,
    { "Set-Cookie": sessionCookie(sessionId) }
  );
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (session) {
    await env.SESSIONS.delete(`session:${session.sessionId}`);
  }
  return jsonOk({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) {
    return jsonError("not_authenticated", "You are not signed in.", 401);
  }
  const user = await getUserById(env, session.data.userId);
  if (!user) {
    return jsonError("not_authenticated", "You are not signed in.", 401);
  }
  return jsonOk({ user, csrf: session.data.csrf });
}
