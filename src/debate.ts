// The debate engine.
//
// Protocol: opening (independent, parallel) → N cross-examination rounds (routed
// questions) → verdict (judge, transcript-only) → synthesis (the deliverable).
//
// Isolation is a correctness requirement, not hygiene. Every turn runs in a throwaway
// directory, so an agentic CLI cannot read a sibling agent's scratch files and present
// it as independent reasoning — in a debate, contamination destroys the only thing the
// debate was measuring. With a repo, turns run in a DETACHED git worktree of HEAD, so
// evidence-gathering commands that write runtime artifacts land in a copy that dies
// with the turn, never in the user's checkout.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Agent, AgentOutcome } from "./providers/types.ts";
import type { Role } from "./roles.ts";
import type { Binding } from "./casting.ts";
import { buildPrompt, type Phase } from "./prompts.ts";
import { parseQuestions, inbox, renderQuestionLog, type Question } from "./crossexam.ts";
import { renderArtifact, renderContext, renderCostFooter, type Turn } from "./transcript.ts";

const execFileAsync = promisify(execFile);

export type Seat = { role: Role; binding: Binding; agent: Agent };

/**
 * Background documents, split by who may read them.
 *
 * This split is what makes "one agent knows the industry, one knows the codebase" real
 * rather than cosmetic. With a single shared pile, every expert reads the same input and
 * the debate degenerates into paraphrase — agreement that proves nothing because no
 * participant had an independent basis to disagree from. Give each role its own evidence
 * and the disagreements become informative.
 */
export type Material = {
  /** Readable by everyone; recorded once in the transcript header. */
  shared?: string;
  /** roleId → documents only that role sees. Never enters the shared transcript. */
  byRole?: Record<string, string>;
  /** roleId → source names, for the audit trail (contents stay private). */
  sources?: Record<string, string[]>;
};

export type DebateEvent =
  | { type: "phase"; phase: Phase; round?: number; detail: string }
  | { type: "turn-start"; roleId: string; label: string }
  | { type: "turn-end"; roleId: string; label: string; ok: boolean; ms: number; detail: string }
  | { type: "questions"; log: string }
  | { type: "warn"; message: string };

export type DebateInput = {
  topic: string;
  material?: Material;
  seats: Seat[];
  judge?: Seat;
  rounds: number;
  language: string;
  maxQuestions: number;
  /** Read-only repo to ground the debate in. Turns see HEAD via a throwaway worktree. */
  repoPath?: string;
  /** Skip the final dossier (e.g. to inspect the debate before paying for synthesis). */
  skipSynthesis?: boolean;
  onEvent?: (e: DebateEvent) => void;
};

export type DebateResult = {
  turns: Turn[];
  /** Full markdown artifact. */
  transcript: string;
  verdict?: { status: "RESOLVED" | "NEEDS_INPUT" | "FAILED"; text: string };
  dossier?: string;
  /** Set when the debate could not meaningfully proceed. */
  aborted?: string;
  questionLog: Question[];
};

/** git worktree add/remove contend on .git locks; serialize the git calls only. */
let gitLock: Promise<unknown> = Promise.resolve();
function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = gitLock.then(fn, fn);
  gitLock = p.then(
    () => {},
    () => {},
  );
  return p;
}

export type IsolatedRun = { outcome: AgentOutcome; agentMs: number; turnMs: number; promptBytes: number };

/** Run one agent call under isolation, measuring the agent and the overhead separately. */
export async function runIsolated(agent: Agent, prompt: string, repoPath?: string): Promise<IsolatedRun> {
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  const turnStart = performance.now();
  let agentMs = 0;

  const timed = async (cwd: string): Promise<AgentOutcome> => {
    const t0 = performance.now();
    try {
      return await agent.run(prompt, cwd);
    } finally {
      agentMs = performance.now() - t0;
    }
  };

  let outcome: AgentOutcome;
  const dir = await mkdtemp(join(tmpdir(), "agora-turn-"));
  try {
    if (!repoPath) {
      outcome = await timed(dir);
    } else {
      const wt = join(dir, "wt");
      await withGitLock(() => execFileAsync("git", ["-C", repoPath, "worktree", "add", "--detach", wt, "HEAD"]));
      try {
        outcome = await timed(wt);
      } finally {
        await withGitLock(async () => {
          try {
            await execFileAsync("git", ["-C", repoPath, "worktree", "remove", "--force", wt]);
          } catch {
            /* the rm below plus git's own prune cover the remainder */
          }
        });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // Stamped after teardown deliberately: a `return` inside the try would evaluate this
  // before the finally blocks ran, excluding the very overhead it exists to measure.
  return { outcome, agentMs, turnMs: performance.now() - turnStart, promptBytes };
}

export async function runDebate(input: DebateInput): Promise<DebateResult> {
  const { topic, material, seats, judge, rounds, language, maxQuestions, repoPath, onEvent } = input;
  const emit = (e: DebateEvent) => onEvent?.(e);

  const peers = seats.map((s) => s.role.id);
  const nameById = new Map(seats.map((s) => [s.role.id, s.role.name]));
  if (judge) nameById.set(judge.role.id, judge.role.name);
  const nameOf = (id: string) => nameById.get(id) ?? id;

  const turns: Turn[] = [];
  const questionLog: Question[] = [];
  const artifact: string[] = [];
  const context: string[] = [];

  const header = [`# Phiên tranh luận chuyên gia`, ``, `## Chủ đề`, ``, topic].join("\n");
  artifact.push(header);
  context.push(header);
  if (material?.shared) {
    const block = [`## Tư liệu đầu vào (mọi chuyên gia đều đọc)`, ``, material.shared].join("\n");
    artifact.push(block);
    context.push(block);
  }
  // Private material is deliberately kept OUT of `context`: putting it there would hand
  // it to every other agent through the transcript and erase the asymmetry. Its SOURCE
  // names still go into the artifact, so a reader can tell who argued from what.
  const privateSources = Object.entries(material?.sources ?? {}).filter(([, v]) => v.length);
  if (privateSources.length) {
    artifact.push(
      [
        `## Tư liệu riêng theo vai`,
        ``,
        ...privateSources.map(([roleId, srcs]) => `- **${nameOf(roleId)}**: ${srcs.join(", ")}`),
        ``,
        `_(nội dung các tư liệu này không nằm trong biên bản chung; chỉ vai tương ứng đọc được)_`,
      ].join("\n"),
    );
  }

  /** Run one seat, parse its routed questions, and record the turn in both views. */
  const playTurn = async (
    seat: Seat,
    phase: Phase,
    extra: { round?: number; myInbox?: Question[]; transcript?: string; verdict?: string },
  ): Promise<Turn> => {
    // `material` (shared) is only attached to the OPENING turn: from the first
    // cross-examination round onward it is already inside the transcript snapshot, and
    // sending it twice would pay for the same tokens on every later turn.
    const sharedForTurn = phase === "opening" ? material?.shared : undefined;
    const privateForTurn = material?.byRole?.[seat.role.id];
    const prompt = buildPrompt({
      role: seat.role,
      phase,
      topic,
      ...(sharedForTurn && { material: sharedForTurn }),
      ...(privateForTurn && { privateMaterial: privateForTurn }),
      ...(extra.transcript !== undefined && { transcript: extra.transcript }),
      ...(extra.myInbox && { inbox: extra.myInbox }),
      ...(extra.verdict !== undefined && { verdict: extra.verdict }),
      peers,
      nameOf,
      language,
      maxQuestions,
      ...(extra.round !== undefined && { round: extra.round }),
    });

    emit({ type: "turn-start", roleId: seat.role.id, label: `${seat.role.name} · ${seat.binding.providerLabel}` });
    // The verdict and the synthesis must not touch the repo: the judge rules on the
    // transcript alone (so it has to ASK rather than guess), and grounding is the
    // debaters' job. Only they get repoPath.
    const grounded = phase === "opening" || phase === "cross-exam" ? repoPath : undefined;
    const run = await runIsolated(seat.agent, prompt, grounded);

    const parsed = run.outcome.ok
      ? parseQuestions(run.outcome.text, seat.role.id, peers, maxQuestions)
      : { questions: [], unrouted: [] };

    const turn: Turn = {
      phase,
      roleId: seat.role.id,
      roleName: seat.role.name,
      provider: seat.binding.provider,
      providerLabel: seat.binding.providerLabel,
      shared: seat.binding.shared,
      ...(extra.round !== undefined && { round: extra.round }),
      outcome: run.outcome,
      promptBytes: run.promptBytes,
      agentMs: run.agentMs,
      turnMs: run.turnMs,
      questions: parsed.questions,
      unrouted: parsed.unrouted,
    };

    emit({
      type: "turn-end",
      roleId: seat.role.id,
      label: `${seat.role.name} · ${seat.binding.providerLabel}`,
      ok: run.outcome.ok,
      ms: run.agentMs,
      detail: run.outcome.ok
        ? `${run.outcome.text.length} ký tự, ${parsed.questions.length} câu hỏi`
        : `${run.outcome.kind}: ${run.outcome.error.slice(0, 120)}`,
    });
    return turn;
  };

  const record = (t: Turn) => {
    turns.push(t);
    artifact.push(renderArtifact(t));
    context.push(renderContext(t));
    questionLog.push(...t.questions);
  };

  // --- Phase 1: opening statements, in parallel, mutually blind ----------------------
  emit({ type: "phase", phase: "opening", detail: `${seats.length} chuyên gia phát biểu độc lập` });
  const openings = await Promise.all(seats.map((s) => playTurn(s, "opening", {})));
  openings.forEach(record);

  const okCount = openings.filter((t) => t.outcome.ok).length;
  // Two voices is the minimum for a debate. If a lineup of several produced fewer,
  // abort loudly: a "debate" between one survivor and silence yields a plausible-
  // looking artifact with none of the cross-checking that justifies the cost.
  if (seats.length >= 2 && okCount < 2) {
    const failures = openings
      .filter((t) => !t.outcome.ok)
      .map((t) => `${t.roleName}: ${(t.outcome as { error: string }).error}`)
      .join(" | ");
    const aborted = `chỉ ${okCount}/${seats.length} chuyên gia phát biểu được — không thể tranh luận. Lỗi: ${failures}`;
    emit({ type: "warn", message: aborted });
    artifact.push(`## Phiên bị huỷ\n\n> ⚠️ ${aborted}\n`);
    return { turns, transcript: artifact.join("\n"), aborted, questionLog };
  }
  if (seats.length === 1) {
    emit({ type: "warn", message: "chỉ có 1 chuyên gia — đây là phân tích đơn, không có đối chất" });
  }
  if (okCount === 0) {
    const aborted = "không chuyên gia nào phát biểu được";
    artifact.push(`## Phiên bị huỷ\n\n> ⚠️ ${aborted}\n`);
    return { turns, transcript: artifact.join("\n"), aborted, questionLog };
  }

  // --- Phase 2: cross-examination rounds --------------------------------------------
  let pending: Question[] = openings.flatMap((t) => t.questions);
  for (let round = 1; round <= rounds; round++) {
    const log = renderQuestionLog(pending, nameOf);
    if (log) {
      emit({ type: "questions", log });
      artifact.push([`### Câu hỏi được chuyển tới vòng ${round}`, ``, log].join("\n"));
    }
    emit({ type: "phase", phase: "cross-exam", round, detail: `${pending.length} câu hỏi được chuyển tiếp` });

    // Snapshot the context BEFORE the round, so every participant reacts to the same
    // state. Letting turns see each other's output mid-round would make the result
    // depend on which CLI happened to answer fastest.
    const snapshot = context.join("\n");
    const reactions = await Promise.all(
      seats.map((s) =>
        playTurn(s, "cross-exam", { round, transcript: snapshot, myInbox: inbox(pending, s.role.id) }),
      ),
    );
    reactions.forEach(record);
    pending = reactions.flatMap((t) => t.questions);
  }

  // --- Phase 3: the verdict ---------------------------------------------------------
  let verdict: DebateResult["verdict"];
  const debateContext = context.join("\n");
  if (judge) {
    emit({ type: "phase", phase: "verdict", detail: `${judge.binding.providerLabel} chốt phiên` });
    const t = await playTurn(judge, "verdict", { transcript: debateContext });
    record(t);
    verdict = t.outcome.ok
      ? { status: parseVerdictStatus(t.outcome.text), text: t.outcome.text }
      : { status: "FAILED", text: `Lượt phán quyết thất bại: ${t.outcome.error}` };
  }

  // --- Phase 4: the deliverable -----------------------------------------------------
  // Only synthesize on a RESOLVED verdict. On NEEDS_INPUT the dossier is waiting on the
  // user's answers, and writing one anyway would bury the open questions inside a
  // document that reads as settled.
  let dossier: string | undefined;
  const synth = judge ?? seats[0];
  const shouldSynthesize = !input.skipSynthesis && (!judge || verdict?.status === "RESOLVED");
  if (shouldSynthesize) {
    emit({ type: "phase", phase: "synthesis", detail: `${synth.binding.providerLabel} soạn hồ sơ` });
    const t = await playTurn(synth, "synthesis", {
      transcript: debateContext,
      ...(verdict && { verdict: verdict.text }),
    });
    record(t);
    if (t.outcome.ok) dossier = t.outcome.text;
  } else if (judge && verdict?.status === "NEEDS_INPUT") {
    emit({ type: "warn", message: "chủ tọa cần thêm thông tin từ bạn — chưa soạn hồ sơ tổng hợp" });
  }

  artifact.push(renderCostFooter(turns));
  return {
    turns,
    transcript: artifact.join("\n"),
    ...(verdict && { verdict }),
    ...(dossier && { dossier }),
    questionLog,
  };
}

/**
 * Only an explicit NEEDS_INPUT on the first non-empty line routes to the human. A
 * missing or garbled marker on an otherwise successful turn counts as a verdict —
 * blocking a finished debate on a formatting slip helps nobody.
 */
export function parseVerdictStatus(text: string): "RESOLVED" | "NEEDS_INPUT" {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return /^STATUS:\s*NEEDS_INPUT\b/i.test(first) ? "NEEDS_INPUT" : "RESOLVED";
}
