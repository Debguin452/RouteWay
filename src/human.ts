import type { Env } from "./types";
import { clientId as deriveClientId, fromBase64Url, sign, subKey, toBase64Url, verify } from "./identity";

export const PASS_TTL_SECONDS = 600;
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface PassPayload {
  r: string;
  c: string;
  e: number;
}

export async function signPass(env: Pick<Env, "MASTER_KEY">, routeId: string, client: string, now: number = Date.now()): Promise<string> {
  const payload: PassPayload = { r: routeId, c: client, e: now + PASS_TTL_SECONDS * 1000 };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await sign(await subKey(env, "human-pass"), `v1.${body}`);
  return `v1.${body}.${toBase64Url(signature)}`;
}

export async function verifyPass(
  env: Pick<Env, "MASTER_KEY">,
  pass: string,
  routeId: string,
  client: string,
  now: number = Date.now()
): Promise<boolean> {
  const parts = pass.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  try {
    const valid = await verify(await subKey(env, "human-pass"), `v1.${parts[1]}`, fromBase64Url(parts[2]));
    if (!valid) return false;
    const payload = JSON.parse(decoder.decode(fromBase64Url(parts[1]))) as PassPayload;
    return payload.r === routeId && payload.c === client && payload.e > now;
  } catch {
    return false;
  }
}

export type TurnstileResult = "ok" | "failed" | "unavailable";

export async function verifyTurnstile(
  env: Pick<Env, "TURNSTILE_SECRET" | "TURNSTILE_VERIFY_URL">,
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET) return "unavailable";
  if (token.length > 2048) return "failed";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.set("secret", env.TURNSTILE_SECRET);
    form.set("response", token);
    const response = await fetchImpl(env.TURNSTILE_VERIFY_URL || TURNSTILE_URL, { method: "POST", body: form, signal: controller.signal });
    if (!response.ok) return "unavailable";
    const result = await response.json<{ success?: boolean }>();
    return result.success === true ? "ok" : "failed";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

export { deriveClientId };
