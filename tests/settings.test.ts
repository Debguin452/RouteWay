import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOrigins,
  parseMethods,
  parsePaths,
  parseIps,
  parseExtraHeaders,
  pathAllowed,
  ipAllowed,
  readExtraHeaders,
  applySettings,
  DEFAULT_SETTINGS,
} from "../src/settings.ts";

const ok = <T>(r: { value: T } | { error: unknown }) => ("value" in r ? r.value : null);

test("origins: list, normalisation, limits", () => {
  assert.equal(ok(parseOrigins("https://a.com, https://b.com/")), "https://a.com,https://b.com");
  assert.equal(ok(parseOrigins("")), null);
  assert.equal(ok(parseOrigins(["https://a.com", "https://a.com"])), "https://a.com");
  assert.ok("error" in parseOrigins("https://a.com/path"));
  assert.ok("error" in parseOrigins("ftp://a.com"));
  assert.ok("error" in parseOrigins("a,b,c,d,e,f".split(",").map((x) => `https://${x}.com`)));
});

test("methods: case-insensitive, validated", () => {
  assert.equal(ok(parseMethods("get, post")), "GET,POST");
  assert.ok("error" in parseMethods("GET,FLY"));
  assert.equal(ok(parseMethods(null)), null);
});

test("paths: exact, wildcard, traversal rejected", () => {
  assert.equal(ok(parsePaths("/chat/completions, /models/*")), "/chat/completions,/models/*");
  assert.ok("error" in parsePaths("chat"));
  assert.ok("error" in parsePaths("/a/../b"));
  assert.ok("error" in parsePaths("/a%2fb"));
  assert.ok("error" in parsePaths("/a b?x=1"));
});

test("pathAllowed matches exact and wildcard paths only", () => {
  const p = "/chat/completions,/models/*";
  assert.equal(pathAllowed("/chat/completions", p), true);
  assert.equal(pathAllowed("chat/completions/", p), true);
  assert.equal(pathAllowed("/chat/completions/extra", p), false);
  assert.equal(pathAllowed("/models/gpt-4", p), true);
  assert.equal(pathAllowed("/models", p), true);
  assert.equal(pathAllowed("/modelsx", p), false);
  assert.equal(pathAllowed("/admin", p), false);
  assert.equal(pathAllowed("/anything", null), true);
  assert.equal(pathAllowed("/anything", "/*"), true);
});

test("ips: validation and CIDR matching", () => {
  assert.equal(ok(parseIps("203.0.113.5, 10.0.0.0/8")), "203.0.113.5,10.0.0.0/8");
  assert.ok("error" in parseIps("999.1.1.1"));
  assert.ok("error" in parseIps("10.0.0.0/33"));
  assert.ok("error" in parseIps("not-an-ip"));
  const allowed = "203.0.113.5,10.0.0.0/8,2001:db8::1";
  assert.equal(ipAllowed("203.0.113.5", allowed), true);
  assert.equal(ipAllowed("203.0.113.6", allowed), false);
  assert.equal(ipAllowed("10.200.3.4", allowed), true);
  assert.equal(ipAllowed("11.0.0.1", allowed), false);
  assert.equal(ipAllowed("2001:db8::1", allowed), true);
  assert.equal(ipAllowed("2001:db8::2", allowed), false);
  assert.equal(ipAllowed(null, allowed), false);
  assert.equal(ipAllowed(null, null), true);
  assert.equal(ipAllowed("1.2.3.4", "0.0.0.0/0"), true);
});

test("extra headers: parse lines and objects, block unsafe ones", () => {
  const stored = ok(parseExtraHeaders("anthropic-version: 2023-06-01\nX-Team: blue"));
  assert.deepEqual(readExtraHeaders(stored), [["anthropic-version", "2023-06-01"], ["x-team", "blue"]]);
  assert.deepEqual(readExtraHeaders(ok(parseExtraHeaders({ "X-A": "1" }))), [["x-a", "1"]]);
  assert.ok("error" in parseExtraHeaders("Host: evil.com"));
  assert.ok("error" in parseExtraHeaders("Content-Length: 5"));
  assert.ok("error" in parseExtraHeaders("no colon here"));
  assert.ok("error" in parseExtraHeaders("Bad Name: x"));
  assert.ok("error" in parseExtraHeaders(Array.from({ length: 11 }, (_, i) => `x-${i}: v`).join("\n")));
  assert.equal(ok(parseExtraHeaders("")), null);
  assert.deepEqual(readExtraHeaders("{not json"), []);
});

test("applySettings only changes provided fields and validates numbers", () => {
  const r = ok(applySettings({ timeoutSeconds: 60 }, DEFAULT_SETTINGS));
  assert.equal(r?.timeoutSeconds, 60);
  assert.equal(r?.rateLimitPerMinute, 60);
  assert.ok("error" in applySettings({ timeoutSeconds: 121 }, DEFAULT_SETTINGS));
  assert.ok("error" in applySettings({ retries: 3 }, DEFAULT_SETTINGS));
  assert.ok("error" in applySettings({ rateLimitPerMinute: 0 }, DEFAULT_SETTINGS));
  const cleared = ok(applySettings({ allowedMethods: "" }, { ...DEFAULT_SETTINGS, allowedMethods: "GET" }));
  assert.equal(cleared?.allowedMethods, null);
});
