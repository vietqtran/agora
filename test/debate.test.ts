import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runDebate, runIsolated, parseVerdictStatus, type Seat } from "../src/debate.ts";
import type { Agent, AgentOutcome } from "../src/providers/types.ts";
import type { Role } from "../src/roles.ts";
import type { Binding } from "../src/casting.ts";
import { renderArtifact, renderContext, renderCostFooter, summarizeCost, type Turn } from "../src/transcript.ts";

const execFileAsync = promisify(execFile);

const role = (id: string): Role => ({
  id,
  name: id.toUpperCase(),
  prefer: [],
  needs: [],
  wants: [],
  summary: "",
  kind: id === "judge" ? "judge" : "debater",
  body: `persona ${id}`,
  source: "test",
});

const binding = (roleId: string, provider: string): Binding => ({
  roleId,
  roleName: roleId.toUpperCase(),
  provider,
  providerLabel: provider,
  vendor: provider,
  grants: { web: false, execute: false },
  shared: false,
  reason: "test",
});

/** Records every prompt it is given, so tests can assert what the engine actually sent. */
function stubAgent(
  provider: string,
  reply: (prompt: string, calls: number) => AgentOutcome,
): Agent & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    provider,
    label: provider,
    vendor: provider,
    bin: "(stub)",
    caps: { execute: false, web: false, reportsCost: false },
    prompts,
    async run(prompt) {
      prompts.push(prompt);
      return reply(prompt, prompts.length);
    },
  };
}

const ok = (text: string): AgentOutcome => ({ ok: true, text });
const fail = (error: string): AgentOutcome => ({ ok: false, error, kind: "other" });

function seat(id: string, provider: string, reply: (p: string, n: number) => AgentOutcome): Seat {
  return { role: role(id), binding: binding(id, provider), agent: stubAgent(provider, reply) };
}

test("the full protocol runs opening → rounds → verdict → synthesis in order", async () => {
  const seats = [
    seat("architect", "p1", () => ok("ý kiến kiến trúc")),
    seat("researcher", "p2", () => ok("ý kiến nghiên cứu")),
  ];
  const judge = seat("judge", "p3", (p) => (/AGORA-PHASE:verdict/.test(p) ? ok("STATUS: RESOLVED\nchốt") : ok("# hồ sơ")));

  const r = await runDebate({
    topic: "chủ đề",
    seats,
    judge,
    rounds: 1,
    language: "vi",
    maxQuestions: 3,
  });

  assert.deepEqual(r.turns.map((t) => t.phase), [
    "opening",
    "opening",
    "cross-exam",
    "cross-exam",
    "verdict",
    "synthesis",
  ]);
  assert.equal(r.verdict?.status, "RESOLVED");
  assert.equal(r.dossier, "# hồ sơ");
  assert.equal(r.aborted, undefined);
});

test("a question asked in the opening is delivered to its target in the next round", async () => {
  // The mechanic the whole tool is built around: without this, agents produce parallel
  // monologues and the user's "gemini asks claude whether this is feasible" never happens.
  const asker = seat("domain-expert", "p1", (_p, n) =>
    n === 1 ? ok("quan điểm\n\nQUESTIONS\n@architect: Nghiệp vụ hồi tố có khả thi không?") : ok("tiếp tục"),
  );
  const target = seat("architect", "p2", () => ok("trả lời"));

  const r = await runDebate({
    topic: "t",
    seats: [asker, target],
    rounds: 1,
    language: "vi",
    maxQuestions: 3,
  });

  const targetPrompts = (target.agent as unknown as { prompts: string[] }).prompts;
  assert.equal(targetPrompts.length, 2);
  assert.match(targetPrompts[1], /Câu hỏi gửi trực tiếp cho bạn/);
  assert.match(targetPrompts[1], /Nghiệp vụ hồi tố có khả thi không\?/);
  assert.match(targetPrompts[1], /DOMAIN-EXPERT hỏi bạn/);
  // The asker must not receive its own question back.
  const askerPrompts = (asker.agent as unknown as { prompts: string[] }).prompts;
  assert.doesNotMatch(askerPrompts[1], /Câu hỏi gửi trực tiếp cho bạn/);
  assert.equal(r.questionLog.length, 1);
});

test("the opening turn is blind — it carries no transcript", async () => {
  const s = seat("architect", "p1", () => ok("x"));
  await runDebate({ topic: "t", seats: [s, seat("researcher", "p2", () => ok("y"))], rounds: 0, language: "vi", maxQuestions: 3 });
  const prompts = (s.agent as unknown as { prompts: string[] }).prompts;
  assert.doesNotMatch(prompts[0], /Biên bản tranh luận/);
  assert.match(prompts[0], /AGORA-PHASE:opening/);
});

test("every participant in a round sees the same snapshot, not each other's new turn", async () => {
  // Otherwise the result depends on which CLI happened to answer fastest.
  const a = seat("a", "p1", () => ok("AAA"));
  const b = seat("b", "p2", () => ok("BBB"));
  await runDebate({ topic: "t", seats: [a, b], rounds: 1, language: "vi", maxQuestions: 3 });
  const bRound1 = (b.agent as unknown as { prompts: string[] }).prompts[1];
  assert.match(bRound1, /AAA/, "must see the opening statements");
  assert.equal((bRound1.match(/BBB/g) ?? []).length, 1, "must see only its own opening, not its own round-1 turn");
});

test("fewer than two surviving openings aborts loudly instead of faking a debate", async () => {
  const r = await runDebate({
    topic: "t",
    seats: [
      seat("a", "p1", () => ok("sống")),
      seat("b", "p2", () => fail("hết quota")),
      seat("c", "p3", () => fail("chưa đăng nhập")),
    ],
    rounds: 2,
    language: "vi",
    maxQuestions: 3,
  });
  assert.ok(r.aborted);
  assert.match(r.aborted, /1\/3/);
  assert.match(r.aborted, /hết quota/);
  // It must stop before paying for rounds, a verdict or a dossier.
  assert.equal(r.turns.filter((t) => t.phase !== "opening").length, 0);
  assert.equal(r.dossier, undefined);
});

test("a single configured seat degrades to a single-expert analysis rather than aborting", async () => {
  const warnings: string[] = [];
  const r = await runDebate({
    topic: "t",
    seats: [seat("a", "p1", () => ok("phân tích"))],
    rounds: 1,
    language: "vi",
    maxQuestions: 3,
    onEvent: (e) => {
      if (e.type === "warn") warnings.push(e.message);
    },
  });
  assert.equal(r.aborted, undefined);
  assert.ok(warnings.some((w) => /độc thoại|phân tích đơn/.test(w)));
});

test("all openings failing aborts even with a single seat", async () => {
  const r = await runDebate({
    topic: "t",
    seats: [seat("a", "p1", () => fail("chết"))],
    rounds: 1,
    language: "vi",
    maxQuestions: 3,
  });
  assert.ok(r.aborted);
});

test("NEEDS_INPUT withholds the dossier so the open questions are not buried", async () => {
  const judge = seat("judge", "p3", () => ok("STATUS: NEEDS_INPUT\n## Câu hỏi cho người dùng\n- ngân sách?"));
  const r = await runDebate({
    topic: "t",
    seats: [seat("a", "p1", () => ok("x")), seat("b", "p2", () => ok("y"))],
    judge,
    rounds: 0,
    language: "vi",
    maxQuestions: 3,
  });
  assert.equal(r.verdict?.status, "NEEDS_INPUT");
  assert.equal(r.dossier, undefined);
  assert.equal(r.turns.filter((t) => t.phase === "synthesis").length, 0);
});

test("a failed judge is non-fatal: the debate still happened and is still on record", async () => {
  const r = await runDebate({
    topic: "t",
    seats: [seat("a", "p1", () => ok("x")), seat("b", "p2", () => ok("y"))],
    judge: seat("judge", "p3", () => fail("timeout")),
    rounds: 0,
    language: "vi",
    maxQuestions: 3,
  });
  assert.equal(r.verdict?.status, "FAILED");
  assert.equal(r.dossier, undefined);
  assert.equal(r.turns.filter((t) => t.phase === "opening").length, 2);
});

test("--no-synthesis stops after the verdict", async () => {
  const r = await runDebate({
    topic: "t",
    seats: [seat("a", "p1", () => ok("x")), seat("b", "p2", () => ok("y"))],
    judge: seat("judge", "p3", () => ok("STATUS: RESOLVED\nchốt")),
    rounds: 0,
    language: "vi",
    maxQuestions: 3,
    skipSynthesis: true,
  });
  assert.equal(r.verdict?.status, "RESOLVED");
  assert.equal(r.dossier, undefined);
});

test("with no judge the debate still produces a dossier, written by the first seat", async () => {
  const r = await runDebate({
    topic: "t",
    seats: [seat("a", "p1", () => ok("hồ sơ từ a")), seat("b", "p2", () => ok("y"))],
    rounds: 0,
    language: "vi",
    maxQuestions: 3,
  });
  assert.equal(r.verdict, undefined);
  assert.equal(r.dossier, "hồ sơ từ a");
});

test("the judge rules on the transcript alone and never gets the repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agora-repo-"));
  await execFileAsync("git", ["-C", dir, "init", "-q"]);
  await writeFile(join(dir, "README.md"), "# repo", "utf8");
  await execFileAsync("git", ["-C", dir, "add", "."]);
  await execFileAsync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

  const seen: Record<string, boolean> = {};
  const probe = (id: string): Seat => ({
    role: role(id),
    binding: binding(id, id),
    agent: {
      provider: id,
      label: id,
      vendor: id,
      bin: "(stub)",
      caps: { execute: true, web: false, reportsCost: false },
      async run(_p, cwd) {
        // A worktree checkout contains the committed file; a bare temp dir does not.
        const files = await readdir(cwd);
        seen[id] = files.includes("README.md");
        return ok("x");
      },
    },
  });

  await runDebate({
    topic: "t",
    seats: [probe("a"), probe("b")],
    judge: probe("judge"),
    rounds: 0,
    language: "vi",
    maxQuestions: 3,
    repoPath: dir,
  });

  assert.equal(seen.a, true, "debaters must see the repo via a worktree");
  assert.equal(seen.judge, false, "the judge must be transcript-only");
});

test("each turn is isolated: an agent cannot see another agent's working directory", async () => {
  const dirs: string[] = [];
  const spy = (id: string): Seat => ({
    role: role(id),
    binding: binding(id, id),
    agent: {
      provider: id,
      label: id,
      vendor: id,
      bin: "(stub)",
      caps: { execute: false, web: false, reportsCost: false },
      async run(_p, cwd) {
        dirs.push(cwd);
        return ok("x");
      },
    },
  });
  await runDebate({ topic: "t", seats: [spy("a"), spy("b")], rounds: 0, language: "vi", maxQuestions: 3 });
  assert.equal(new Set(dirs).size, dirs.length, "two turns shared a directory");
});

test("runIsolated removes its temp directory afterwards", async () => {
  let captured = "";
  const agent: Agent = {
    provider: "x",
    label: "x",
    vendor: "x",
    bin: "x",
    caps: { execute: false, web: false, reportsCost: false },
    async run(_p, cwd) {
      captured = cwd;
      return ok("ok");
    },
  };
  const r = await runIsolated(agent, "p");
  assert.ok(r.outcome.ok);
  assert.ok(r.promptBytes > 0);
  await assert.rejects(() => readdir(captured), /ENOENT/);
});

test("verdict status parsing only honours an explicit NEEDS_INPUT on the first line", () => {
  assert.equal(parseVerdictStatus("STATUS: NEEDS_INPUT\n..."), "NEEDS_INPUT");
  assert.equal(parseVerdictStatus("\n\n  status: needs_input  \nrest"), "NEEDS_INPUT");
  assert.equal(parseVerdictStatus("STATUS: RESOLVED"), "RESOLVED");
  // A garbled or missing marker on an otherwise good verdict must not block the run.
  assert.equal(parseVerdictStatus("Tôi quyết định rằng..."), "RESOLVED");
  assert.equal(parseVerdictStatus("phần đầu\nSTATUS: NEEDS_INPUT"), "RESOLVED");
});

test("the artifact view keeps failures and cost; the context view hides the plumbing", () => {
  const turn: Turn = {
    phase: "opening",
    roleId: "a",
    roleName: "A",
    provider: "p",
    providerLabel: "P",
    shared: false,
    outcome: { ok: false, error: "quota hết", kind: "budget", costUsd: 1.5 },
    promptBytes: 10,
    agentMs: 1000,
    turnMs: 1100,
    questions: [],
    unrouted: [],
  };
  const art = renderArtifact(turn);
  assert.match(art, /THẤT BẠI/);
  assert.match(art, /quota hết/);
  assert.match(art, /1\.5000/);

  const ctx = renderContext(turn);
  assert.doesNotMatch(ctx, /quota hết/, "raw errors must not be fed back to agents");
  assert.doesNotMatch(ctx, /1\.5000/, "cost footnotes must not be fed back to agents");
  assert.match(ctx, /không đưa ra ý kiến/);
});

test("the live stream carries degradation, so a UI cannot draw a clean turn", async () => {
  // A green tick in the terminal or the web pipeline is exactly where a lost sandbox
  // would otherwise disappear: the answer arrived, so the seat looks fine.
  const note = "lượt này chạy KHÔNG sandbox: không thấy backend sandbox nào";
  const degraded = (text: string): AgentOutcome => ({
    ok: true,
    text,
    capture: { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ms: 5, notes: [note] },
  });
  const events: { roleId: string; notes?: string[] }[] = [];
  await runDebate({
    topic: "t",
    seats: [seat("a", "p1", () => degraded("x")), seat("b", "p2", () => ok("y"))],
    rounds: 0,
    language: "vi",
    maxQuestions: 3,
    skipSynthesis: true,
    onEvent: (e) => {
      if (e.type === "turn-end") events.push({ roleId: e.roleId, ...(e.notes && { notes: e.notes }) });
    },
  });
  assert.deepEqual(events.find((e) => e.roleId === "a")?.notes, [note]);
  assert.equal(events.find((e) => e.roleId === "b")?.notes, undefined, "a clean turn stays clean");
});

test("a degraded turn is flagged in the artifact and in the footer, never in the prompt", () => {
  // The failure mode this guards: a turn that lost its sandbox or its context isolation
  // produces a perfectly normal-looking answer. The audit view must say so; the next
  // agent's prompt must not, or the debate starts arguing about our flag handling.
  const capture = {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    ms: 5,
    notes: ["CLI từ chối một cờ nên lượt này đã chạy LẠI không có các cờ tuỳ chọn (--bare) — mất: cách ly context (--bare)"],
  };
  const turn: Turn = {
    phase: "opening",
    roleId: "a",
    roleName: "A",
    provider: "p",
    providerLabel: "P",
    shared: false,
    outcome: { ok: true, text: "ý kiến chuyên môn", capture },
    promptBytes: 10,
    agentMs: 1000,
    turnMs: 1100,
    questions: [],
    unrouted: [],
  };

  const art = renderArtifact(turn);
  assert.match(art, /HẠ CẤP/);
  assert.match(art, /--bare/);
  assert.match(art, /ý kiến chuyên môn/, "the answer itself must still be there");

  const ctx = renderContext(turn);
  assert.doesNotMatch(ctx, /HẠ CẤP/);
  assert.doesNotMatch(ctx, /--bare/);

  // Also countable at the bottom of the transcript, next to the money.
  assert.equal(summarizeCost([turn]).degradedTurns, 1);
  assert.match(renderCostFooter([turn]), /1 lượt hạ cấp/);

  // A failed turn that was ALSO degraded must report both, not pick one.
  const failed: Turn = { ...turn, outcome: { ok: false, error: "quota hết", kind: "budget", capture } };
  const failedArt = renderArtifact(failed);
  assert.match(failedArt, /HẠ CẤP/);
  assert.match(failedArt, /THẤT BẠI/);
});

test("the cost summary never presents an unpriced run as free", () => {
  const base = {
    phase: "opening" as const,
    roleId: "a",
    roleName: "A",
    provider: "p",
    providerLabel: "P",
    shared: false,
    promptBytes: 1,
    agentMs: 100,
    turnMs: 110,
    questions: [],
    unrouted: [],
  };
  const s = summarizeCost([
    { ...base, outcome: { ok: true, text: "x", costUsd: 0.25 } },
    { ...base, outcome: { ok: true, text: "y" } },
    { ...base, outcome: { ok: false, error: "e", kind: "other" } },
  ]);
  assert.equal(s.knownCostUsd, 0.25);
  assert.equal(s.unpricedTurns, 2);
  assert.equal(s.ok, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.degradedTurns, 0, "no notes means no degradation, not unknown");
});

test("rounds: 0 runs the opening only", async () => {
  const r = await runDebate({
    topic: "t",
    seats: [seat("a", "p1", () => ok("x")), seat("b", "p2", () => ok("y"))],
    rounds: 0,
    language: "vi",
    maxQuestions: 3,
    skipSynthesis: true,
  });
  assert.equal(r.turns.length, 2);
  assert.ok(r.turns.every((t) => t.phase === "opening"));
});

test("a question aimed at a role that is not seated is surfaced, not swallowed", async () => {
  const r = await runDebate({
    topic: "t",
    seats: [
      seat("a", "p1", () => ok("x\n\nQUESTIONS\n@lawyer: hợp pháp không?")),
      seat("b", "p2", () => ok("y")),
    ],
    rounds: 0,
    language: "vi",
    maxQuestions: 3,
    skipSynthesis: true,
  });
  const turn = r.turns.find((t) => t.roleId === "a")!;
  assert.equal(turn.unrouted.length, 1);
  assert.match(r.transcript, /Đã hỏi vai không có trong phiên/);
});

// --- per-role material --------------------------------------------------------------
// The asymmetry is the feature: one expert reads the industry process, another reads the
// schema. The thing that can silently destroy it is a leak — private material reaching
// the shared transcript, after which every agent sees everything and the debate is back
// to paraphrase. These tests pin the boundary.

test("private material reaches only its own role", async () => {
  const a = seat("architect", "p1", () => ok("x"));
  const b = seat("domain-expert", "p2", () => ok("y"));
  await runDebate({
    topic: "t",
    material: {
      shared: "AI CŨNG ĐỌC ĐƯỢC",
      byRole: { architect: "CHỈ KIẾN TRÚC SƯ", "domain-expert": "CHỈ CHUYÊN GIA NGÀNH" },
      sources: { architect: ["schema.sql"], "domain-expert": ["quy-trinh.md"] },
    },
    seats: [a, b],
    rounds: 1,
    language: "vi",
    maxQuestions: 3,
  });

  const aPrompts = (a.agent as unknown as { prompts: string[] }).prompts;
  const bPrompts = (b.agent as unknown as { prompts: string[] }).prompts;

  assert.ok(aPrompts.every((p) => !p.includes("CHỈ CHUYÊN GIA NGÀNH")), "architect saw the other role's private material");
  assert.ok(bPrompts.every((p) => !p.includes("CHỈ KIẾN TRÚC SƯ")), "domain-expert saw the other role's private material");
  assert.match(aPrompts[0], /CHỈ KIẾN TRÚC SƯ/);
  assert.match(bPrompts[0], /CHỈ CHUYÊN GIA NGÀNH/);
});

test("private material is re-attached every round, since the transcript never carries it", async () => {
  const a = seat("architect", "p1", () => ok("x"));
  await runDebate({
    topic: "t",
    material: { byRole: { architect: "TƯ LIỆU RIÊNG" } },
    seats: [a, seat("domain-expert", "p2", () => ok("y"))],
    rounds: 2,
    language: "vi",
    maxQuestions: 3,
    // Without a judge the first seat also writes the dossier; skip it so this test
    // counts debate turns only.
    skipSynthesis: true,
  });
  const prompts = (a.agent as unknown as { prompts: string[] }).prompts;
  assert.equal(prompts.length, 3, "opening + two rounds");
  for (const [i, p] of prompts.entries()) {
    assert.match(p, /TƯ LIỆU RIÊNG/, `round ${i} lost the private material`);
  }
});

test("a role using private material is told to quote it, or the others cannot rebut", async () => {
  const a = seat("architect", "p1", () => ok("x"));
  await runDebate({
    topic: "t",
    material: { byRole: { architect: "TƯ LIỆU RIÊNG" } },
    seats: [a, seat("domain-expert", "p2", () => ok("y"))],
    rounds: 0,
    language: "vi",
    maxQuestions: 3,
    skipSynthesis: true,
  });
  const prompt = (a.agent as unknown as { prompts: string[] }).prompts[0];
  assert.match(prompt, /không đọc được/);
  assert.match(prompt, /trích lại đoạn liên quan/);
});

test("the transcript records WHO got which private source but never the contents", async () => {
  const r = await runDebate({
    topic: "t",
    material: {
      byRole: { architect: "NỘI DUNG TUYỆT ĐỐI KHÔNG ĐƯỢC VÀO BIÊN BẢN" },
      sources: { architect: ["schema.sql"] },
    },
    seats: [seat("architect", "p1", () => ok("x")), seat("domain-expert", "p2", () => ok("y"))],
    rounds: 0,
    language: "vi",
    maxQuestions: 3,
    skipSynthesis: true,
  });
  assert.match(r.transcript, /Tư liệu riêng theo vai/);
  assert.match(r.transcript, /schema\.sql/, "the source name must be auditable");
  assert.doesNotMatch(r.transcript, /KHÔNG ĐƯỢC VÀO BIÊN BẢN/, "private contents leaked into the shared artifact");
});

test("shared material is sent once, then carried by the transcript", async () => {
  // Re-sending it every turn would pay for the same tokens on every later round.
  const a = seat("architect", "p1", () => ok("x"));
  await runDebate({
    topic: "t",
    material: { shared: "NỀN CHUNG" },
    seats: [a, seat("domain-expert", "p2", () => ok("y"))],
    rounds: 1,
    language: "vi",
    maxQuestions: 3,
    skipSynthesis: true,
  });
  const prompts = (a.agent as unknown as { prompts: string[] }).prompts;
  assert.match(prompts[0], /NỀN CHUNG/, "the opening turn needs it directly");
  // Round 1 still sees it, but through the transcript header — exactly once.
  assert.equal((prompts[1].match(/NỀN CHUNG/g) ?? []).length, 1);
});

test("a debate with no material at all still runs", async () => {
  const r = await runDebate({
    topic: "t",
    seats: [seat("a", "p1", () => ok("x")), seat("b", "p2", () => ok("y"))],
    rounds: 0,
    language: "vi",
    maxQuestions: 3,
    skipSynthesis: true,
  });
  assert.equal(r.aborted, undefined);
  assert.doesNotMatch(r.transcript, /Tư liệu riêng theo vai/);
});
