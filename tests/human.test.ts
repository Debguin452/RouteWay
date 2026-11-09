import { test } from "node:test";
import assert from "node:assert/strict";
import { signPass, verifyPass, verifyTurnstile, PASS_TTL_SECONDS } from "../src/human.ts";
import { clientId } from "../src/identity.ts";
import { applySettings, DEFAULT_SETTINGS } from "../src/settings.ts";

const env = { MASTER_KEY: "ab".repeat(32) };
const otherEnv = { MASTER_KEY: "cd".repeat(32) };

test("pass verifies for the same route and client", async () => {
  const pass = await signPass(env, "route-1", "client-a");
  assert.equal(await verifyPass(env, pass, "route-1", "client-a"), true);
});

test("pass is bound to route, client and key", async () => {
  const pass = await signPass(env, "route-1", "client-a");
  assert.equal(await verifyPass(env, pass, "route-2", "client-a"), false);
  assert.equal(await verifyPass(env, pass, "route-1", "client-b"), false);
  assert.equal(await verifyPass(otherEnv, pass, "route-1", "client-a"), false);
});

test("pass expires and rejects tampering and garbage", async () => {
  const now = Date.now();
  const pass = await signPass(env, "r", "c", now);
  assert.equal(await verifyPass(env, pass, "r", "c", now + PASS_TTL_SECONDS * 1000 - 1000), true);
  assert.equal(await verifyPass(env, pass, "r", "c", now + PASS_TTL_SECONDS * 1000 + 1000), false);

  const [v, body, sig] = pass.split(".");
  const forged = Buffer.from(JSON.stringify({ r: "r", c: "c", e: now + 10 ** 12 })).toString("base64url");
  assert.equal(await verifyPass(env, `${v}.${forged}.${sig}`, "r", "c"), false);
  assert.equal(await verifyPass(env, `${v}.${body}.${sig.slice(0, -2)}AA`, "r", "c"), false);
  for (const junk of ["", "x", "v1.a.b", "v2.a.b", "a.b.c.d", "v1..", "v1.%%%.%%%"]) {
    assert.equal(await verifyPass(env, junk, "r", "c"), false, junk);
  }
});

test("client id is stable per day, rotates daily, differs by route and ip, and does not contain the ip", async () => {
  const day1 = Date.parse("2026-11-09T10:00:00Z");
  const day2 = Date.parse("2026-11-10T10:00:00Z");
  const a = await clientId(env, "route-1", "203.0.113.7", day1);
  assert.equal(a, await clientId(env, "route-1", "203.0.113.7", day1 + 3600_000));
  assert.notEqual(a, await clientId(env, "route-1", "203.0.113.7", day2));
  assert.notEqual(a, await clientId(env, "route-2", "203.0.113.7", day1));
  assert.notEqual(a, await clientId(env, "route-1", "203.0.113.8", day1));
  assert.notEqual(a, await clientId(otherEnv, "route-1", "203.0.113.7", day1));
  assert.ok(!a.includes("203"));
  assert.equal(a.length, 24);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("turnstile verification maps responses to results", async () => {
  const withSecret = { TURNSTILE_SECRET: "s" };
  const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
  assert.equal(await verifyTurnstile({}, "t", reply({ success: true })), "unavailable");
  assert.equal(await verifyTurnstile(withSecret, "t", reply({ success: true })), "ok");
  assert.equal(await verifyTurnstile(withSecret, "t", reply({ success: false })), "failed");
  assert.equal(await verifyTurnstile(withSecret, "t", reply({})), "failed");
  assert.equal(await verifyTurnstile(withSecret, "t", reply({ success: true }, 500)), "unavailable");
  assert.equal(await verifyTurnstile(withSecret, "t", async () => { throw new Error("net"); }), "unavailable");
  assert.equal(await verifyTurnstile(withSecret, "x".repeat(3000), reply({ success: true })), "failed");
});

test("turnstile request carries the secret and token but not the caller ip", async () => {
  let sent: FormData | null = null;
  await verifyTurnstile({ TURNSTILE_SECRET: "sek" }, "tok", async (_url, init) => {
    sent = init?.body as FormData;
    return new Response(JSON.stringify({ success: true }));
  });
  assert.equal(sent!.get("secret"), "sek");
  assert.equal(sent!.get("response"), "tok");
  assert.equal(sent!.get("remoteip"), null);
});

test("settings: per-caller limit and human gate", () => {
  const ok = applySettings({ clientRateLimitPerMinute: 20, requireHuman: true }, DEFAULT_SETTINGS);
  assert.ok("value" in ok);
  if ("value" in ok) {
    assert.equal(ok.value.clientRateLimitPerMinute, 20);
    assert.equal(ok.value.requireHuman, true);
  }
  assert.ok("error" in applySettings({ clientRateLimitPerMinute: -1 }, DEFAULT_SETTINGS));
  assert.ok("error" in applySettings({ clientRateLimitPerMinute: 7000 }, DEFAULT_SETTINGS));
  const off = applySettings({ requireHuman: false }, { ...DEFAULT_SETTINGS, requireHuman: true });
  assert.ok("value" in off && off.value.requireHuman === false);
});
