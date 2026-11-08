import type { Env } from "./types";
import { checkRateLimit } from "./rateLimiter";
import { encryptSecret, decryptSecret, hashPassword, verifyPassword, validateMasterKey, resolveIterations } from "./crypto";

interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

async function run(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - start, detail };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { name, ok: false, ms: Date.now() - start, detail: message.slice(0, 300) };
  }
}

const EXPECTED_TABLES = ["users", "projects", "routes", "tokens"];

/** Tests every dependency separately and reports plain text. Never prints secret values. */
export async function handleDebug(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (env.DEBUG_TOKEN && url.searchParams.get("key") !== env.DEBUG_TOKEN) {
    return new Response("Not found", { status: 404 });
  }

  const results: CheckResult[] = [];

  results.push(
    await run("config: DASHBOARD_ORIGIN", async () => {
      const o = env.DASHBOARD_ORIGIN;
      if (!o) throw new Error("not set in wrangler.toml [vars]");
      const u = new URL(o);
      if (u.pathname !== "/" ) throw new Error(`must be a bare origin with no path, got "${o}"`);
      const seen = request.headers.get("origin");
      return `${o}` + (seen ? (seen.replace(/\/+$/, "") === o.replace(/\/+$/, "") ? " (matches this request's Origin)" : ` (WARNING: this request's Origin is ${seen}, which does not match)`) : "");
    })
  );

  results.push(
    await run("config: MASTER_KEY", async () => {
      validateMasterKey(env.MASTER_KEY);
      return "present, 64 hex characters";
    })
  );

  results.push(
    await run("D1: connection", async () => {
      const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      if (row?.ok !== 1) throw new Error("unexpected result");
      return "reachable";
    })
  );

  results.push(
    await run("D1: schema", async () => {
      const { results: rows } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
      const have = new Set(rows.map((r) => r.name));
      const missing = EXPECTED_TABLES.filter((t) => !have.has(t));
      if (missing.length) {
        throw new Error(`missing tables: ${missing.join(", ")}. Run: wrangler d1 execute <db-name> --remote --file=./schema.sql`);
      }
      return `tables present: ${EXPECTED_TABLES.join(", ")}`;
    })
  );

  results.push(
    await run("KV: sessions store", async () => {
      const key = `debug:${crypto.randomUUID()}`;
      await env.SESSIONS.put(key, "ping", { expirationTtl: 60 });
      const got = await env.SESSIONS.get(key);
      await env.SESSIONS.delete(key);
      if (got !== "ping") throw new Error("wrote a value but could not read it back (KV is eventually consistent; retry once)");
      return "write, read, delete OK";
    })
  );

  results.push(
    await run("Durable Object: rate limiter", async () => {
      const r = await checkRateLimit(env, `debug:${crypto.randomUUID()}`, 5, 60);
      if (!r.allowed) throw new Error("fresh bucket reported as rate limited");
      return "responds correctly";
    })
  );

  results.push(
    await run("crypto: secret encryption", async () => {
      const { ciphertext, iv } = await encryptSecret("round-trip", env.MASTER_KEY);
      const back = await decryptSecret(ciphertext, iv, env.MASTER_KEY);
      if (back !== "round-trip") throw new Error("decrypted value did not match");
      return "AES-GCM round trip OK";
    })
  );

  results.push(
    await run("crypto: password hashing", async () => {
      const iterations = resolveIterations(env.PBKDF2_ITERATIONS);
      const { hash, salt } = await hashPassword("correct horse battery", iterations);
      const good = await verifyPassword("correct horse battery", hash, salt);
      const bad = await verifyPassword("wrong", hash, salt);
      if (!good || bad) throw new Error("verify gave the wrong answer");
      return `PBKDF2-SHA256 at ${iterations} iterations OK (Workers caps this at 100000). If signup returns Worker exceeded CPU limit on the free plan, set PBKDF2_ITERATIONS lower in [vars].`;
    })
  );

  const failed = results.filter((r) => !r.ok);
  const lines = results.map((r) => `${r.ok ? "[ OK ]" : "[FAIL]"} ${r.name} (${r.ms} ms)\n       ${r.detail}`);
  lines.push("");
  lines.push(failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED. Fix the [FAIL] lines above first.`);

  return new Response(lines.join("\n") + "\n", {
    status: failed.length === 0 ? 200 : 500,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
