import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProvider } from "../src/providers/claude.ts";
import { codexProvider } from "../src/providers/codex.ts";
import { geminiProvider, antigravityProvider } from "../src/providers/google.ts";
import { customProvider, buildArgs, dotPath, extractText } from "../src/providers/custom.ts";
import { unsupportedFlag, sandboxUnavailable, flagOrSandbox, flatten } from "../src/providers/argplan.ts";
import { detectSandbox, wantSandbox } from "../src/providers/sandbox.ts";
import { classify, outcomeNotes, remedy } from "../src/providers/types.ts";
import { runCli } from "../src/spawn.ts";

// The fake CLIs live OUTSIDE test/ on purpose: Node's default test discovery
// treats every file under a test/ directory as a test file, and one of these
// fakes deliberately sleeps for two minutes.
const FAKES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "clis");
const CWD = tmpdir();
const fake = (n: string) => join(FAKES, n);

/** Each fake reads FAKE_MODE; set it for the duration of one adapter call. */
async function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.FAKE_MODE;
  process.env.FAKE_MODE = mode;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.FAKE_MODE;
    else process.env.FAKE_MODE = prev;
  }
}

// --- claude -------------------------------------------------------------------------

test("claude: a success envelope yields text, cost and turn count", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs"), model: "sonnet" });
  const r = await withMode("success", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.match(r.text, /ĐÃ TRẢ LỜI/);
  assert.equal(r.costUsd, 0.0425);
  assert.equal(r.usage?.turns, 3);
});

test("claude: is_error wins over subtype — a 'success' subtype with is_error is a failure", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs") });
  const r = await withMode("liar", () => agent.run("hỏi", CWD));
  assert.equal(r.ok, false);
  // The spend on a failed turn must still be reported, not discarded.
  assert.equal(r.costUsd, 0.12);
});

test("claude: budget exhaustion is classified as budget and reads the errors array", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs"), maxBudgetUsd: 2 });
  const r = await withMode("budget", () => agent.run("hỏi", CWD));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.kind === "budget");
  assert.ok(!r.ok && /Max budget/.test(r.error), "message must come from errors[] when result is absent");
  assert.equal(r.costUsd, 2.0031);
});

test("claude: exit 127 is a setup problem, not an agent failure", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs") });
  const r = await withMode("exit127", () => agent.run("hỏi", CWD));
  assert.ok(!r.ok && r.kind === "not-runnable");
  assert.match((r as { error: string }).error, /PATH/);
});

test("claude: a missing binary is reported as not-runnable, never as a crash", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("does-not-exist") });
  const r = await agent.run("hỏi", CWD);
  assert.equal(r.ok, false);
});

test("claude: an unknown optional flag triggers one retry without it", async () => {
  // This is the fleet-compatibility guarantee: an older CLI that rejects a newer
  // convenience flag must still produce a turn, not kill the debate.
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs") });
  const r = await withMode("unknown-flag", () => agent.run("hỏi", CWD));
  assert.ok(r.ok, "the retry without optional flags must succeed");
});

test("claude: --bare is passed by default and removable with bare:false", async () => {
  // The flag that keeps the user's CLAUDE.md/hooks/MCP out of the persona. It must be
  // on without being asked for, and off when asked — it is the escape hatch for the
  // reported --bare vs OAuth-login conflict.
  const on = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs") });
  const rOn = await withMode("success", () => on.run("hỏi", CWD));
  assert.ok(rOn.ok);
  assert.match(rOn.text, /bare=true/);

  const off = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs"), bare: false });
  const rOff = await withMode("success", () => off.run("hỏi", CWD));
  assert.ok(rOff.ok);
  assert.match(rOff.text, /bare=false/);
});

test("claude: an auth failure under --bare names the opt-out instead of dead-ending", async () => {
  // argplan retries only on an UNKNOWN flag, so this failure is never retried. The one
  // thing the user can act on is the hint, so it has to travel with the error.
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs") });
  const r = await withMode("bare-auth", () => agent.run("hỏi", CWD));
  assert.ok(!r.ok && r.kind === "auth");
  assert.match((r as { error: string }).error, /OAuth session expired/);
  assert.match((r as { error: string }).error, /"bare": false/);

  // And the hint must be true: turning it off actually gets the turn through.
  const off = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs"), bare: false });
  const rOff = await withMode("bare-auth", () => off.run("hỏi", CWD));
  assert.ok(rOff.ok, "bare:false must get past the auth failure the hint blames on --bare");
});

test("claude: the bare hint is not bolted onto unrelated failures", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs"), maxBudgetUsd: 2 });
  const r = await withMode("budget", () => agent.run("hỏi", CWD));
  assert.ok(!r.ok && r.kind === "budget");
  assert.doesNotMatch((r as { error: string }).error, /bare/);
});

test("claude: a dropped --bare is recorded as a degraded turn, not passed off as clean", async () => {
  // The whole point of the note: this turn SUCCEEDS and reads like any other, while the
  // isolation the README advertises silently did not apply to it.
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs") });
  const r = await withMode("unknown-flag", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  const notes = outcomeNotes(r);
  assert.equal(notes.length, 1, "a degraded turn must carry exactly one retry note");
  assert.match(notes[0], /--bare/);
  assert.match(notes[0], /CLAUDE\.md/, "the note must say what context may have leaked in");
});

test("claude: a clean turn carries no notes at all", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs") });
  const r = await withMode("success", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.deepEqual(outcomeNotes(r), []);
});

test("claude: an all-whitespace answer is a failure, not a success", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs") });
  const r = await withMode("empty", () => agent.run("hỏi", CWD));
  assert.ok(!r.ok && r.kind === "empty");
});

test("claude: unparsable stdout fails without throwing", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs") });
  const r = await withMode("garbage", () => agent.run("hỏi", CWD));
  assert.equal(r.ok, false);
});

test("claude: granted capabilities expand the tool allowlist, and writes stay banned", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs"), web: true, execute: true });
  const r = await withMode("success", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.match(r.text, /WebSearch/);
  assert.match(r.text, /Bash\(/);
  const argv = r.capture?.stdout ?? "";
  assert.ok(argv.length > 0);
});

test("claude: without grants the allowlist is read-only and has no web", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs") });
  const r = await withMode("success", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.doesNotMatch(r.text, /WebSearch/);
  assert.doesNotMatch(r.text, /Bash\(/);
});

test("claude: a timeout is reported as a timeout", async () => {
  const agent = claudeProvider.make({ provider: "claude", bin: fake("fake-claude.mjs"), timeoutMs: 600 });
  const r = await withMode("hang", () => agent.run("hỏi", CWD));
  assert.ok(!r.ok && r.kind === "timeout");
});

// --- codex --------------------------------------------------------------------------

test("codex: the last agent_message wins and tool calls count completed events only", async () => {
  const agent = codexProvider.make({ provider: "codex", bin: fake("fake-codex.mjs") });
  const r = await withMode("success", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.equal(r.text, "CÂU TRẢ LỜI CUỐI");
  // command_execution + web_search = 2; `reasoning` is narration and `item.started`
  // must not be double-counted.
  assert.equal(r.usage?.toolCalls, 2);
  assert.equal(r.usage?.ranCommands, 1);
  assert.equal(r.usage?.tokens, 1234);
});

test("codex: turn.failed is a failure even though the process exited 0", async () => {
  const agent = codexProvider.make({ provider: "codex", bin: fake("fake-codex.mjs") });
  const r = await withMode("turn-failed", () => agent.run("hỏi", CWD));
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /rate limit/);
});

test("codex: a stream with no turn.completed is not a success", async () => {
  const agent = codexProvider.make({ provider: "codex", bin: fake("fake-codex.mjs") });
  const r = await withMode("no-turn-completed", () => agent.run("hỏi", CWD));
  assert.equal(r.ok, false);
});

test("codex: an error event fails the turn", async () => {
  const agent = codexProvider.make({ provider: "codex", bin: fake("fake-codex.mjs") });
  const r = await withMode("error-event", () => agent.run("hỏi", CWD));
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /stream broke/);
});

// --- gemini / antigravity -----------------------------------------------------------

test("gemini: the json envelope yields response and stats", async () => {
  const agent = geminiProvider.make({ provider: "gemini", bin: fake("fake-gemini.mjs") });
  const r = await withMode("success", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.equal(r.text, "trả lời từ gemini");
  assert.equal(r.usage?.tokens, 900);
  assert.equal(r.usage?.toolCalls, 2);
});

test("gemini: an error object fails the turn with its message", async () => {
  const agent = geminiProvider.make({ provider: "gemini", bin: fake("fake-gemini.mjs") });
  const r = await withMode("error", () => agent.run("hỏi", CWD));
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /quota exceeded/);
});

test("gemini: plain-text stdout degrades to a text answer instead of being thrown away", async () => {
  // An older build without --output-format still produces a usable answer.
  const agent = geminiProvider.make({ provider: "gemini", bin: fake("fake-gemini.mjs") });
  const r = await withMode("text-only", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.match(r.text, /văn bản thuần/);
});

test("gemini: --sandbox is requested, and yolo without it is the shape we refuse to ship", async () => {
  // These two flags are a pair: --approval-mode yolo removes the human from every tool
  // call, so the sandbox is the only boundary left. Asking for yolo alone was the bug.
  const agent = geminiProvider.make({ provider: "gemini", bin: fake("fake-gemini.mjs"), sandbox: true });
  const r = await withMode("echo-args", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.match(r.text, /--sandbox/);
  assert.match(r.text, /--approval-mode yolo/);
});

test("gemini: a host with no sandbox backend runs anyway and SAYS it is unsandboxed", async () => {
  const agent = geminiProvider.make({ provider: "gemini", bin: fake("fake-gemini.mjs"), sandbox: false });
  const r = await withMode("echo-args", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.doesNotMatch(r.text, /--sandbox/);
  assert.match(outcomeNotes(r).join(" "), /KHÔNG sandbox/);
});

test("gemini: a sandbox the host cannot honour is retried without it, with a note", async () => {
  // Not an unknown-flag error, which is the retry gap this adapter had to opt out of:
  // a docker-less host would otherwise lose every Gemini turn the moment we ask for a
  // sandbox. Recover, then say the boundary is gone.
  const agent = geminiProvider.make({ provider: "gemini", bin: fake("fake-gemini.mjs"), sandbox: true });
  const r = await withMode("sandbox-missing", () => agent.run("hỏi", CWD));
  assert.ok(r.ok, "the turn must survive a host without docker/podman");
  assert.match(outcomeNotes(r).join(" "), /sandbox/i);
});

test("antigravity: a sandbox the host cannot honour is retried without it, with a note", async () => {
  const agent = antigravityProvider.make({ provider: "antigravity", bin: fake("fake-text.mjs"), sandbox: true });
  const r = await withMode("sandbox-missing", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.doesNotMatch(r.text, /--sandbox/, "the retry must actually drop the flag");
  assert.match(outcomeNotes(r).join(" "), /không bị OS chặn ghi/);
});

test("codex: losing web search is named, because a researcher without it may fabricate", async () => {
  const agent = codexProvider.make({ provider: "codex", bin: fake("fake-codex.mjs"), web: true });
  const r = await withMode("unknown-flag", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.match(outcomeNotes(r).join(" "), /web search/);
});

test("gemini is marked retired so casting deprioritises it", () => {
  assert.ok(geminiProvider.deprecated, "gemini CLI was retired on 2026-06-18");
  assert.equal(antigravityProvider.deprecated, undefined);
});

test("antigravity: stdout is the answer", async () => {
  const agent = antigravityProvider.make({ provider: "antigravity", bin: fake("fake-text.mjs"), model: "m" });
  const r = await withMode("success", () => agent.run("hỏi", CWD));
  assert.ok(r.ok);
  assert.match(r.text, /^OK args=/);
  assert.match(r.text, /-p hỏi/, "the prompt must be passed with -p");
});

test("antigravity: exit 0 with empty stdout is a failure, not an empty success", async () => {
  const agent = antigravityProvider.make({ provider: "antigravity", bin: fake("fake-text.mjs") });
  const r = await withMode("silent", () => agent.run("hỏi", CWD));
  assert.ok(!r.ok && r.kind === "empty");
});

test("antigravity: an auth error is classified as auth, not as a generic failure", async () => {
  const agent = antigravityProvider.make({ provider: "antigravity", bin: fake("fake-text.mjs") });
  const r = await withMode("fail", () => agent.run("hỏi", CWD));
  assert.ok(!r.ok && r.kind === "auth", `expected auth, got ${(r as { kind: string }).kind}`);
});

// --- custom -------------------------------------------------------------------------

test("custom: {prompt} is substituted wherever the user put it", () => {
  assert.deepEqual(buildArgs(["run", "--p", "{prompt}", "--json"], "xin chào", "arg"), [
    "run",
    "--p",
    "xin chào",
    "--json",
  ]);
});

test("custom: with no placeholder the prompt becomes the final positional", () => {
  assert.deepEqual(buildArgs(["run"], "q", "arg"), ["run", "q"]);
});

test("custom: stdin mode removes the placeholder from argv", () => {
  assert.deepEqual(buildArgs(["run", "{prompt}"], "q", "stdin"), ["run"]);
});

test("custom: dotPath walks nested objects and refuses non-scalars", () => {
  assert.equal(dotPath({ a: { b: "x" } }, "a.b"), "x");
  assert.equal(dotPath({ a: { b: { c: 1 } } }, "a.b"), "");
  assert.equal(dotPath({ a: 5 }, "a"), "5");
  assert.equal(dotPath({}, "nope.deep"), "");
});

test("custom: jsonl extraction takes the last line that carries an answer", () => {
  const stream = '{"t":"x"}\n{"reply":"đầu"}\nnoise\n{"reply":"cuối"}\n{"t":"done"}';
  assert.equal(extractText(stream, "jsonl", "reply"), "cuối");
});

test("custom: a declared CLI runs end to end over stdin", async () => {
  const agent = customProvider.make({
    provider: "custom",
    id: "mycli",
    label: "My CLI",
    command: fake("fake-stdin.mjs"),
    promptMode: "stdin",
    parse: "json",
    textPath: "reply",
  });
  const r = await agent.run("câu hỏi của tôi", CWD);
  assert.ok(r.ok);
  assert.match(r.text, /nhận được: câu hỏi của tôi/);
  assert.equal(agent.label, "My CLI");
});

test("custom: a command that is missing fails cleanly", async () => {
  const agent = customProvider.make({ provider: "custom", id: "x", command: fake("nope.mjs") });
  const r = await agent.run("q", CWD);
  assert.equal(r.ok, false);
});

// --- transport ----------------------------------------------------------------------

test("a timed-out CLI that leaked a child still resolves promptly (process-group kill)", async () => {
  // Without detached + negative-pid kill, the leaked grandchild holds stdout open,
  // `close` never fires, and this call would hang for the full 120s the fake sleeps.
  const t0 = Date.now();
  const r = await runCli(fake("fake-hang-tree.mjs"), [], { cwd: CWD, timeoutMs: 800 });
  const elapsed = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.ok(elapsed < 10_000, `took ${elapsed}ms — the process group was not killed`);
});

test("sandboxUnavailable separates a missing backend from an unknown flag", () => {
  const base = { code: 1, signal: null, stdout: "", stderr: "", timedOut: false, ms: 1 };
  for (const msg of [
    "Error: Sandbox is enabled but docker is not running",
    "failed to start sandbox: podman not found",
    "sandbox not supported on this platform",
    "Sandboxing failed; see logs",
    "error: cannot connect to the Docker daemon",
  ]) {
    assert.ok(sandboxUnavailable({ ...base, stderr: msg }), `missed: ${msg}`);
  }
  // A turn that merely talks about sandboxes is not a sandbox failure.
  assert.equal(sandboxUnavailable({ ...base, stderr: "quota exceeded" }), false);
  assert.equal(sandboxUnavailable({ ...base, stdout: "tôi đã chạy trong sandbox read-only" }), false);
  // The combined trigger is what the Google adapters pass in.
  assert.ok(flagOrSandbox({ ...base, stderr: "unknown option '--sandbox'" }));
  assert.ok(flagOrSandbox({ ...base, stderr: "failed to create sandbox" }));
  assert.equal(flagOrSandbox({ ...base, stderr: "quota exceeded" }), false);
});

test("the sandbox probe reports a backend, or names what is missing", async () => {
  // Every branch gets a FAKE filesystem. Faking only the platform would make this test
  // pass on a Mac and fail on the Linux server it exists to protect — which is exactly
  // what happened the first time it ran there.
  const has = (...paths: string[]) => async (p: string) => paths.includes(p);
  const nothing = async () => false;

  const none = await detectSandbox({ PATH: "/usr/bin:/bin" }, "linux", nothing);
  assert.equal(none.available, false);
  assert.match(none.how, /docker\/podman/);

  const docker = await detectSandbox({ PATH: "/usr/bin:/bin" }, "linux", has("/usr/bin/docker"));
  assert.deepEqual(docker, { available: true, how: "docker" });

  const podman = await detectSandbox({ PATH: "/opt/bin" }, "linux", has("/opt/bin/podman"));
  assert.equal(podman.how, "podman");

  const seatbelt = await detectSandbox({ PATH: "" }, "darwin", has("/usr/bin/sandbox-exec"));
  assert.equal(seatbelt.available, true);
  assert.match(seatbelt.how, /seatbelt/);

  // A Mac without seatbelt must fall through, not claim a sandbox it does not have.
  const macNoSeatbelt = await detectSandbox({ PATH: "/usr/bin" }, "darwin", has("/usr/bin/docker"));
  assert.equal(macNoSeatbelt.how, "docker");

  // And the default (real filesystem) path still answers without throwing on any host.
  assert.equal((await detectSandbox({ PATH: "" }, "linux")).available, false);
});

test("explicit config beats the probe in both directions", async () => {
  assert.deepEqual(await wantSandbox(true, { PATH: "" }), { on: true, note: null });
  const off = await wantSandbox(false, { PATH: "" });
  assert.equal(off.on, false);
  assert.match(off.note ?? "", /cấu hình/, "an opt-out must still be recorded on the turn");
});

test("unsupportedFlag recognises the common phrasings and ignores unrelated errors", () => {
  const base = { code: 1, signal: null, stdout: "", timedOut: false, ms: 1 };
  for (const msg of [
    "error: unknown option '--x'",
    "Unknown argument: x",
    "unrecognized option",
    "error: unexpected argument '--x' found",
    "flag provided but not defined: -x",
  ]) {
    assert.ok(unsupportedFlag({ ...base, stderr: msg }), `missed: ${msg}`);
  }
  assert.equal(unsupportedFlag({ ...base, stderr: "quota exceeded" }), false);
  // A sandbox that cannot start is a DIFFERENT family: the CLI understood the flag.
  assert.equal(unsupportedFlag({ ...base, stderr: "failed to start sandbox: podman not found" }), false);
});

test("flatten can drop the optional groups", () => {
  const groups = [{ args: ["-p", "x"] }, { args: ["--nice"], optional: true }];
  assert.deepEqual(flatten(groups, true), ["-p", "x", "--nice"]);
  assert.deepEqual(flatten(groups, false), ["-p", "x"]);
});

// --- failure classification ---------------------------------------------------------
// The strings below are VERBATIM from a real Ubuntu server running claude 2.1.292 and
// codex 0.145.0. They are the reason this classifier exists: both failures look alike
// from a distance and call for opposite fixes.

test("a model/plan rejection is classified as model, not auth", () => {
  // Real codex 0.145.0 output. A naive auth check claims this first (it contains
  // "account") and sends the user to re-login, which fixes nothing at all.
  const real = "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";
  assert.equal(classify(real), "model");
  assert.equal(classify("Model metadata for `gpt-5.1-codex` not found."), "model");
  assert.equal(classify("model_not_found"), "model");
  assert.equal(classify("unsupported model: foo"), "model");
});

test("an expired session is classified as auth", () => {
  // Real claude 2.1.292 output.
  const real = "Failed to authenticate: OAuth session expired and could not be refreshed";
  assert.equal(classify(real), "auth");
  assert.equal(classify("You are not logged in"), "auth");
});

test("ordinary content is not mistaken for either", () => {
  assert.equal(classify("rate limit reached"), "other");
  // "author" must not trip the auth pattern.
  assert.equal(classify("the author of this model proposal"), "other");
  assert.equal(classify("stream broke", "empty"), "empty");
});

test("every failure kind names an action, and the action differs by kind", () => {
  const kinds = ["auth", "model", "not-runnable", "timeout", "budget", "empty", "other"] as const;
  const messages = kinds.map((k) => remedy(k, "codex", "/usr/bin/codex"));
  assert.equal(new Set(messages).size, kinds.length, "two kinds share a remedy");
  assert.match(remedy("auth", "claude", "/usr/local/bin/claude"), /\/usr\/local\/bin\/claude/);
  // Claude's auth remedy must mention the second cause, or a logged-in user has
  // nothing to try after /login fails to change anything.
  assert.match(remedy("auth", "claude", "claude"), /"bare": false/);
  assert.doesNotMatch(remedy("auth", "codex", "codex"), /bare/);
  assert.match(remedy("model", "codex", "codex"), /providers/);
  assert.match(remedy("not-runnable", "codex", "codex"), /PATH/);
});

test("codex surfaces a turn.failed model rejection as kind model", async () => {
  // End-to-end through the adapter: the stream shape plus the classifier together.
  const agent = codexProvider.make({ provider: "codex", bin: fake("fake-codex.mjs") });
  const r = await withMode("model-rejected", () => agent.run("hỏi", CWD));
  assert.ok(!r.ok && r.kind === "model", `expected model, got ${(r as { kind: string }).kind}`);
});
