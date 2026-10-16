import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deliverPrompt, isArgvTooLong, PROMPT_ARGV_LIMIT, STDIN_POINTER } from "../src/providers/delivery.ts";
import { claudeProvider } from "../src/providers/claude.ts";
import { codexProvider } from "../src/providers/codex.ts";

const FAKES = join(dirname(fileURLToPath(import.meta.url)), "fakes");
const CWD = tmpdir();

test("a small prompt stays on argv — the well-trodden path is unchanged", () => {
  const d = deliverPrompt("ngắn");
  assert.equal(d.argvPrompt, "ngắn");
  assert.equal(d.viaStdin, false);
  assert.equal(d.stdin, undefined);
});

test("a prompt over the limit moves to stdin with a pointer left in argv", () => {
  const big = "x".repeat(PROMPT_ARGV_LIMIT + 1);
  const d = deliverPrompt(big);
  assert.equal(d.viaStdin, true);
  assert.equal(d.argvPrompt, STDIN_POINTER);
  assert.equal(d.stdin, big);
});

test("the limit is measured in BYTES, not characters", () => {
  // Vietnamese text averages well over one byte per character; counting characters
  // would let a prompt past the OS limit and fail three rounds into a paid run.
  const vietnamese = "ạ".repeat(PROMPT_ARGV_LIMIT); // 3 bytes each in UTF-8
  assert.ok(vietnamese.length <= PROMPT_ARGV_LIMIT);
  assert.equal(deliverPrompt(vietnamese).viaStdin, true);
});

test("the argv limit stays safely under the Linux per-argument cap", () => {
  assert.ok(PROMPT_ARGV_LIMIT < 131_072, "must be below MAX_ARG_STRLEN");
});

test("delivery can be pinned either way regardless of size", () => {
  assert.equal(deliverPrompt("ngắn", "stdin").viaStdin, true);
  assert.equal(deliverPrompt("x".repeat(PROMPT_ARGV_LIMIT + 1), "argv").viaStdin, false);
});

test("E2BIG is recognised in either phrasing", () => {
  assert.ok(isArgvTooLong("spawn E2BIG"));
  assert.ok(isArgvTooLong("Argument list too long"));
  assert.equal(isArgvTooLong("quota exceeded"), false);
});

test("claude: a small prompt really does arrive on argv", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: join(FAKES, "fake-source.mjs") });
  const r = await agent.run("câu hỏi ngắn", CWD);
  assert.ok(r.ok);
  assert.match(r.text, /stdin=0/);
  assert.doesNotMatch(r.text, /argv=0 /);
});

test("claude: an oversized prompt really does arrive on stdin", async () => {
  // The end-to-end proof: without this path the run dies with E2BIG on Linux once the
  // transcript and the user's material grow past 128 KiB.
  const big = `câu hỏi dài ${"ạ".repeat(60_000)}`;
  const agent = claudeProvider.make({ provider: "claude", bin: join(FAKES, "fake-source.mjs") });
  const r = await agent.run(big, CWD);
  assert.ok(r.ok, `expected success, got ${JSON.stringify(r)}`);
  const m = r.text.match(/argv=(\d+) stdin=(\d+)/);
  assert.ok(m);
  assert.ok(Number(m[2]) > 100_000, `stdin should carry the prompt, got ${m[2]} bytes`);
  assert.ok(Number(m[1]) < 1_000, `argv should carry only the pointer, got ${m[1]} bytes`);
});

test("claude: promptMode stdin forces stdin even for a short prompt", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: join(FAKES, "fake-source.mjs"), promptMode: "stdin" });
  const r = await agent.run("ngắn", CWD);
  assert.ok(r.ok);
  const m = r.text.match(/stdin=(\d+)/);
  assert.ok(m && Number(m[1]) > 0, "stdin must carry the prompt when pinned");
});

test("codex: an oversized prompt switches to `exec -` with the body on stdin", async () => {
  const big = "y".repeat(PROMPT_ARGV_LIMIT + 10);
  const agent = codexProvider.make({ provider: "codex", bin: join(FAKES, "fake-codex-source.mjs") });
  const r = await agent.run(big, CWD);
  assert.ok(r.ok, `expected success, got ${JSON.stringify(r)}`);
  assert.match(r.text, /dash=true/);
  assert.match(r.text, /stdin=96010/);
});

test("codex: a small prompt keeps the positional form and no dash", async () => {
  const agent = codexProvider.make({ provider: "codex", bin: join(FAKES, "fake-codex-source.mjs") });
  const r = await agent.run("ngắn", CWD);
  assert.ok(r.ok);
  assert.match(r.text, /dash=false/);
});
