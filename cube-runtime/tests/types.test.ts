import assert from "node:assert/strict";
import test from "node:test";
import { toRuntimeNotice } from "../src/types.js";

test("error notices preserve original errors and HTTP status instead of guessing their category", () => {
  const upstream = Object.assign(new Error("Provider returned error"), {
    statusCode: 404,
    requestBodyValues: { messages: ["private prompt"] },
    responseHeaders: { "set-cookie": "private cookie" },
  });
  assert.deepEqual(toRuntimeNotice(upstream), { level: "error", message: "HTTP 404: Provider returned error" });
  for (const message of [
    "Invalid config.yaml: expected string",
    "OpenAI sign-in cancelled.",
    "Model catalog could not be saved: EACCES",
    "Provider is temporarily rate-limited",
    "fetch failed",
  ]) {
    assert.equal(toRuntimeNotice(new Error(message)).message, message);
    assert.equal(toRuntimeNotice({ message }).message, message);
    assert.equal(toRuntimeNotice(message).message, message);
  }
  assert.equal(toRuntimeNotice({ code: 502 }).message, "HTTP 502");
  assert.equal(toRuntimeNotice(new Error(JSON.stringify({ code: 502, request: "private prompt" }))).message, "HTTP 502");
  assert.equal(toRuntimeNotice({ code: "ECONNRESET" }).message, "ECONNRESET");
  assert.equal(toRuntimeNotice({ statusCode: 429, message: "HTTP 429: exhausted" }).message, "HTTP 429: exhausted");
});

test("error notices redact echoed credentials and never dump unknown objects", () => {
  for (const secret of [
    "Bearer private-token", "Basic private-token", "api_key=private-token",
    '"access_token": "private-token"', "refreshToken='private-token'",
    "https://example.test?key=public&apiKey=private-token&model=test",
    "sk-private-token", "AIzaPrivateToken",
  ]) {
    const notice = toRuntimeNotice(new Error(`Request rejected: ${secret}`));
    assert.match(notice.message, /^Request rejected: /);
    assert.match(notice.message, /\[Redacted\]/);
    assert.doesNotMatch(notice.message, /private-token|AIzaPrivateToken/);
  }
  for (const error of [null, undefined, {}, { request: "private-token" }, new Error("")]) {
    assert.deepEqual(toRuntimeNotice(error), { level: "error", message: "Unknown error. Check Cube logs for details." });
  }
});
