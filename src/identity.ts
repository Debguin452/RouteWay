import type { Env } from "./types";
import { validateMasterKey } from "./crypto";

const encoder = new TextEncoder();

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(raw: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function subKey(env: Pick<Env, "MASTER_KEY">, purpose: string): Promise<CryptoKey> {
  const master = await hmacKey(encoder.encode(validateMasterKey(env.MASTER_KEY)));
  const derived = await crypto.subtle.sign("HMAC", master, encoder.encode(`routeway/${purpose}/v1`));
  return hmacKey(derived);
}

export async function sign(key: CryptoKey, message: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign("HMAC", key, encoder.encode(message));
}

export async function verify(key: CryptoKey, message: string, signature: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify("HMAC", key, signature, encoder.encode(message));
}

export async function clientId(env: Pick<Env, "MASTER_KEY">, routeId: string, ip: string | null, now: number = Date.now()): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10);
  const key = await subKey(env, "client-id");
  const digest = await sign(key, `${day}|${routeId}|${ip ?? "unknown"}`);
  return toBase64Url(digest).slice(0, 24);
}
