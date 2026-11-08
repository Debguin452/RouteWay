import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTargetUrl } from "../src/target.ts";

const t = (base: string, rest = "", search = "") => buildTargetUrl(base, rest, search)?.toString() ?? null;

test("no sub-path keeps the exact base URL (backwards compatible)", () => {
  assert.equal(t("https://api.example.com/v1/chat"), "https://api.example.com/v1/chat");
  assert.equal(t("https://api.example.com/v1/chat", "/"), "https://api.example.com/v1/chat");
});

test("sub-path is appended under the base path", () => {
  assert.equal(t("https://api.openai.com/v1", "/chat/completions"), "https://api.openai.com/v1/chat/completions");
  assert.equal(t("https://api.openai.com/v1/", "/models/gpt"), "https://api.openai.com/v1/models/gpt");
  assert.equal(t("https://api.example.com", "/a/b"), "https://api.example.com/a/b");
});

test("client query string is forwarded; base query params win", () => {
  assert.equal(t("https://api.example.com/v1", "/x", "?a=1&b=2"), "https://api.example.com/v1/x?a=1&b=2");
  assert.equal(t("https://api.example.com/v1?key=route", "/x", "?key=evil&a=1"), "https://api.example.com/v1/x?a=1&key=route");
});

test("path traversal and smuggling are rejected", () => {
  for (const rest of ["/../admin", "/a/../../b", "/%2e%2e/admin", "/a%2fb", "/a%5cb", "/a\\b", "/./x", "/%2E%2E/x"]) {
    assert.equal(t("https://api.example.com/v1", rest), null, rest);
  }
});

test("cannot be redirected to another host", () => {
  for (const rest of ["//evil.com/x", "/@evil.com/x", "/\\evil.com", "/https://evil.com"]) {
    const out = buildTargetUrl("https://api.example.com/v1", rest, "");
    if (out) {
      assert.equal(out.origin, "https://api.example.com", rest);
      assert.ok(out.pathname.startsWith("/v1"), rest);
    }
  }
});
