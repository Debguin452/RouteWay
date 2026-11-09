import type { RouteSettings } from "./types";

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
]);

export const LIMITS = {
  origins: 5,
  paths: 20,
  ips: 10,
  headers: 10,
  headerValue: 1000,
  timeoutSeconds: 120,
  retries: 2,
  rateLimitPerMinute: 6000,
  tokenLifetimeDays: 365,
  tokenLabel: 40,
};

export const DEFAULT_SETTINGS: RouteSettings = {
  allowedOrigin: null,
  allowedMethods: null,
  allowedPaths: null,
  allowedIps: null,
  extraHeaders: null,
  rateLimitPerMinute: 60,
  clientRateLimitPerMinute: 0,
  requireHuman: false,
  timeoutSeconds: 30,
  retries: 0,
};

export type Parsed<T> = { value: T } | { error: { code: string; message: string } };

function toItems(value: unknown, separator: RegExp): string[] | null {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(separator) : null;
  if (!raw) return null;
  return raw.map((item) => String(item).trim()).filter(Boolean);
}

function isOriginString(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/" && !url.search && !url.hash && !url.username;
  } catch {
    return false;
  }
}

export function parseOrigins(value: unknown): Parsed<string | null> {
  const items = toItems(value, /,/);
  const fail = { error: { code: "invalid_allowed_origin", message: `Allowed origins must look like https://example.com with no path, at most ${LIMITS.origins}, separated by commas.` } };
  if (!items || items.length > LIMITS.origins) return fail;
  const out: string[] = [];
  for (const item of items) {
    if (!isOriginString(item)) return fail;
    const origin = new URL(item).origin;
    if (!out.includes(origin)) out.push(origin);
  }
  return { value: out.length ? out.join(",") : null };
}

export function parseMethods(value: unknown): Parsed<string | null> {
  const items = toItems(value, /[,\s]+/);
  const fail = { error: { code: "invalid_methods", message: "Allowed methods must be a list of GET, POST, PUT, PATCH, DELETE, HEAD." } };
  if (!items) return fail;
  const out: string[] = [];
  for (const item of items.map((m) => m.toUpperCase())) {
    if (!VALID_METHODS.has(item)) return fail;
    if (!out.includes(item)) out.push(item);
  }
  return { value: out.length ? out.join(",") : null };
}

export function normalizePath(path: string): string {
  const collapsed = "/" + path.replace(/^\/+/, "");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

export function parsePaths(value: unknown): Parsed<string | null> {
  const items = toItems(value, /[,\s]+/);
  const fail = { error: { code: "invalid_allowed_paths", message: `Allowed paths must start with /, use only letters, numbers and /_-.~:%, may end with * as a wildcard, and number at most ${LIMITS.paths}.` } };
  if (!items || items.length > LIMITS.paths) return fail;
  const out: string[] = [];
  for (const item of items) {
    if (!item.startsWith("/") || !/^[A-Za-z0-9/_\-.~:%]*\*?$/.test(item) || item.length > 200) return fail;
    if (/%2e|%2f|%5c/i.test(item) || item.split("/").some((segment) => segment === ".." || segment === ".")) return fail;
    const wildcard = item.endsWith("*");
    const stored = wildcard ? "/" + item.slice(0, -1).replace(/^\/+/, "") + "*" : normalizePath(item);
    if (!out.includes(stored)) out.push(stored);
  }
  return { value: out.length ? out.join(",") : null };
}

export function pathAllowed(restPath: string, patterns: string | null): boolean {
  if (!patterns) return true;
  const path = normalizePath(restPath);
  return patterns.split(",").some((pattern) => {
    if (!pattern.endsWith("*")) return path === pattern;
    const prefix = pattern.slice(0, -1);
    return path.startsWith(prefix) || (prefix.endsWith("/") && path === prefix.slice(0, -1));
  });
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
}

function isValidIpEntry(entry: string): boolean {
  const [addr, bits, extra] = entry.split("/");
  if (extra !== undefined) return false;
  if (ipv4ToInt(addr) !== null) {
    return bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32);
  }
  return bits === undefined && addr.includes(":") && /^[0-9a-fA-F:.]{2,45}$/.test(addr);
}

export function parseIps(value: unknown): Parsed<string | null> {
  const items = toItems(value, /[,\s]+/);
  const fail = { error: { code: "invalid_allowed_ips", message: `Allowed IPs must be IPv4 addresses, IPv4 CIDR ranges like 203.0.113.0/24, or IPv6 addresses, at most ${LIMITS.ips}.` } };
  if (!items || items.length > LIMITS.ips) return fail;
  const out: string[] = [];
  for (const item of items) {
    if (!isValidIpEntry(item)) return fail;
    const entry = item.toLowerCase();
    if (!out.includes(entry)) out.push(entry);
  }
  return { value: out.length ? out.join(",") : null };
}

export function ipAllowed(ip: string | null, allowed: string | null): boolean {
  if (!allowed) return true;
  if (!ip) return false;
  const candidate = ip.toLowerCase();
  const candidateInt = ipv4ToInt(candidate);
  return allowed.split(",").some((entry) => {
    const [addr, bits] = entry.split("/");
    if (candidateInt === null || ipv4ToInt(addr) === null) return entry === candidate;
    const prefix = bits === undefined ? 32 : Number(bits);
    if (prefix === 0) return true;
    const mask = prefix === 32 ? 0xffffffff : (~0 << (32 - prefix)) >>> 0;
    return ((candidateInt & mask) >>> 0) === (((ipv4ToInt(addr) as number) & mask) >>> 0);
  });
}

export function parseExtraHeaders(value: unknown): Parsed<string | null> {
  const fail = (message: string) => ({ error: { code: "invalid_extra_headers", message } });
  if (value === undefined || value === null || value === "") return { value: null };

  let entries: [string, string][];
  if (typeof value === "string") {
    entries = [];
    for (const line of value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const index = line.indexOf(":");
      if (index < 1) return fail(`Each header must look like "Name: value". Problem line: ${line.slice(0, 40)}`);
      entries.push([line.slice(0, index).trim(), line.slice(index + 1).trim()]);
    }
  } else if (typeof value === "object" && !Array.isArray(value)) {
    entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [k.trim(), String(v).trim()]);
  } else {
    return fail("Extra headers must be lines of \"Name: value\" or an object.");
  }

  if (entries.length > LIMITS.headers) return fail(`At most ${LIMITS.headers} extra headers are allowed.`);
  const out: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    const lower = name.toLowerCase();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) return fail(`"${name.slice(0, 40)}" is not a valid header name.`);
    if (FORBIDDEN_HEADERS.has(lower)) return fail(`The header "${name}" cannot be set.`);
    if (headerValue.length > LIMITS.headerValue || /[\u0000-\u001f\u007f]/.test(headerValue)) return fail(`The value for "${name}" is too long or contains control characters.`);
    out[lower] = headerValue;
  }
  return { value: Object.keys(out).length ? JSON.stringify(out) : null };
}

export function readExtraHeaders(stored: string | null): [string, string][] {
  if (!stored) return [];
  try {
    return Object.entries(JSON.parse(stored) as Record<string, string>);
  } catch {
    return [];
  }
}

export function applySettings(body: Record<string, unknown>, current: RouteSettings): Parsed<RouteSettings> {
  const next: RouteSettings = { ...current };

  const text: [keyof RouteSettings, string, (v: unknown) => Parsed<string | null>][] = [
    ["allowedOrigin", "allowedOrigin", parseOrigins],
    ["allowedMethods", "allowedMethods", parseMethods],
    ["allowedPaths", "allowedPaths", parsePaths],
    ["allowedIps", "allowedIps", parseIps],
    ["extraHeaders", "extraHeaders", parseExtraHeaders],
  ];
  for (const [field, key, parse] of text) {
    if (!(key in body)) continue;
    const result = parse(body[key]);
    if ("error" in result) return result;
    (next[field] as string | null) = result.value;
  }

  const numbers: [keyof RouteSettings, string, number, number, string, string][] = [
    ["rateLimitPerMinute", "rateLimitPerMinute", 1, LIMITS.rateLimitPerMinute, "invalid_rate_limit", "Rate limit must be a whole number between 1 and 6000 requests per minute."],
    ["clientRateLimitPerMinute", "clientRateLimitPerMinute", 0, LIMITS.rateLimitPerMinute, "invalid_client_rate_limit", "Per-caller rate limit must be a whole number between 0 (off) and 6000 requests per minute."],
    ["timeoutSeconds", "timeoutSeconds", 1, LIMITS.timeoutSeconds, "invalid_timeout", `Timeout must be a whole number between 1 and ${LIMITS.timeoutSeconds} seconds.`],
    ["retries", "retries", 0, LIMITS.retries, "invalid_retries", `Retries must be a whole number between 0 and ${LIMITS.retries}.`],
  ];
  for (const [field, key, min, max, code, message] of numbers) {
    if (!(key in body)) continue;
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < min || n > max) return { error: { code, message } };
    (next[field] as number) = n;
  }

  if ("requireHuman" in body) {
    next.requireHuman = body.requireHuman === true || body.requireHuman === "true" || body.requireHuman === 1;
  }

  return { value: next };
}
