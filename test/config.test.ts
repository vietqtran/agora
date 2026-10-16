import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, mergeConfig, specFor, stripJsonComments } from "../src/config.ts";

test("line and block comments are stripped", () => {
  const src = `{
    // a comment
    "rounds": 2, /* inline */
    "language": "vi"
  }`;
  assert.deepEqual(JSON.parse(stripJsonComments(src)), { rounds: 2, language: "vi" });
});

test("a URL inside a string survives comment stripping", () => {
  // The naive regex approach eats everything after the "//" in every https:// URL.
  const src = `{"command": "https://example.com/x", "args": ["C:\\\\tools//bin"]}`;
  const out = JSON.parse(stripJsonComments(src));
  assert.equal(out.command, "https://example.com/x");
  assert.equal(out.args[0], "C:\\tools//bin");
});

test("an escaped quote does not end the string early", () => {
  const src = `{"label": "say \\"hi\\" // not a comment"}`;
  assert.equal(JSON.parse(stripJsonComments(src)).label, 'say "hi" // not a comment');
});

test("block comments preserve newlines so error line numbers stay honest", () => {
  const stripped = stripJsonComments("{\n/* one\ntwo */\n}");
  assert.equal(stripped.split("\n").length, 4);
});

test("an unknown config key fails loudly instead of being ignored", () => {
  assert.throws(() => mergeConfig(DEFAULTS, { roundz: 3 }, "test.json"), /khoá không hợp lệ: roundz/);
});

test("providers merge per key, so setting one model does not wipe the others", () => {
  const merged = mergeConfig(DEFAULTS, { providers: { claude: { model: "opus" } } }, "t");
  assert.equal(merged.providers.claude.model, "opus");
  assert.equal(merged.providers.claude.maxBudgetUsd, 5, "other claude defaults must survive");
  assert.ok("codex" in merged.providers, "other providers must survive");
});

test("judge: null means no judge", () => {
  assert.equal(mergeConfig(DEFAULTS, { judge: null }, "t").judge, null);
});

test("specFor applies provider defaults then role overrides", () => {
  const spec = specFor(DEFAULTS, "claude", "judge", { web: false, execute: false });
  assert.equal(spec.provider, "claude");
  assert.equal(spec.effort, "high", "role-generic override applies");
  assert.equal(spec.model, "opus", "provider-scoped override applies");
});

test("a provider-scoped model never leaks to another vendor", () => {
  // The bug this guards: a judge configured as model "opus" silently handing "opus" to
  // Codex the moment Claude is not installed on a machine.
  const spec = specFor(DEFAULTS, "codex", "judge", { web: false, execute: false });
  assert.equal(spec.provider, "codex");
  assert.equal(spec.effort, "high");
  assert.equal(spec.model, undefined, "opus must not reach codex");
});

test("granted capabilities reach the spec", () => {
  const spec = specFor(DEFAULTS, "codex", "researcher", { web: true, execute: true });
  assert.equal(spec.web, true);
  assert.equal(spec.execute, true);
});

test("the timeout is converted from minutes to ms once, centrally", () => {
  const spec = specFor({ ...DEFAULTS, timeoutMinutes: 3 }, "claude", "architect", { web: false, execute: false });
  assert.equal(spec.timeoutMs, 180_000);
});

test("a custom runtime is resolved by id and keeps its declared provider", () => {
  const cfg = {
    ...DEFAULTS,
    custom: [{ provider: "custom", id: "opencode", command: "opencode", args: ["run", "{prompt}"] }],
  };
  const spec = specFor(cfg, "opencode", "architect", { web: false, execute: false });
  assert.equal(spec.provider, "custom");
  assert.equal(spec.id, "opencode");
  assert.equal(spec.command, "opencode");
});

test("a pinned binary overrides the provider default", () => {
  const spec = specFor(DEFAULTS, "claude", "architect", { web: false, execute: false }, "/opt/homebrew/bin/claude");
  assert.equal(spec.bin, "/opt/homebrew/bin/claude");
});
