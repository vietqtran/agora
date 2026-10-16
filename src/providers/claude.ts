// Claude Code adapter. Emits the richest envelope of any CLI here: one JSON object
// with the answer, the dollar cost, turn count and refused permissions.
//
// Two classification rules are counter-intuitive and both are load-bearing:
//   1. Trust `is_error`, NOT `subtype`. On failure `subtype` can still read "success"
//      while `is_error` flips true.
//   2. On budget exhaustion there is no `result` string at all — the message lives in
//      the `errors` array and `subtype` becomes "error_max_budget_usd". For THAT case
//      subtype is the reliable discriminator. Read every place, most specific first.

import { runPlanned, type ArgGroup } from "./argplan.ts";
import { deliverPrompt } from "./delivery.ts";
import { spawnFailure, exitLabel, DEFAULT_TIMEOUT_MS } from "../spawn.ts";
import type { Agent, AgentOutcome, ProviderDef, ProviderSpec, Usage } from "./types.ts";
import { classify } from "./types.ts";

const READ_TOOLS = ["Read", "Glob", "Grep"];
const WEB_TOOLS = ["WebSearch", "WebFetch"];
// Read-only shell: enough to inspect a repo and run its existing tests, never mutate.
const SHELL_TOOLS = [
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(npm test *)",
  "Bash(pytest *)",
  "Bash(bundle exec rspec *)",
];

function allowedTools(spec: ProviderSpec): string {
  const t = [...READ_TOOLS];
  if (spec.web) t.push(...WEB_TOOLS);
  if (spec.execute) t.push(...SHELL_TOOLS);
  return t.join(",");
}

/**
 * Cost + activity from the envelope, usable even on a turn we killed. A timeout that
 * lands mid-flight has still spent real money; parsing before giving up is the
 * difference between an honest cost report and a dead turn recorded as free.
 */
function envelopeMeta(stdout: string): { costUsd?: number; usage: Usage } | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const usage: Usage = {};
  if (typeof j.num_turns === "number") usage.turns = j.num_turns;
  const cost = typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined;
  return { ...(cost !== undefined && { costUsd: cost }), usage };
}

function make(spec: ProviderSpec): Agent {
  const bin = spec.bin ?? "claude";
  const model = spec.model ?? "sonnet";
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    provider: "claude",
    label: `Claude Code (${model})`,
    vendor: "anthropic",
    bin,
    caps: { execute: spec.execute === true, web: spec.web === true, reportsCost: true },
    async run(prompt, cwd): Promise<AgentOutcome> {
      const delivery = deliverPrompt(prompt, spec.promptMode === "stdin" ? "stdin" : undefined);
      const groups: ArgGroup[] = [
        { args: ["-p", delivery.argvPrompt ?? ""] },
        { args: ["--output-format", "json"] },
        { args: ["--model", model] },
        // Skip auto-discovery of CLAUDE.md, hooks, skills, plugins, MCP servers and
        // auto-memory. A debate participant must be the persona THIS tool handed it:
        // silently absorbing the user's project rules and memories would contaminate
        // the role and make two runs on different machines incomparable.
        { args: ["--bare"], optional: true },
        { args: ["--allowedTools", allowedTools(spec)] },
        // A research debate must never edit the user's files. Required, not optional:
        // if this flag cannot be set we would rather the turn fail than run unguarded.
        { args: ["--disallowedTools", "Edit,Write,NotebookEdit"] },
        // Headless: deny anything outside the allowlist instead of blocking on a prompt.
        { args: ["--permission-mode", "dontAsk"] },
        // Niceties — dropped automatically on a CLI that does not know them.
        { args: ["--no-session-persistence"], optional: true },
        ...(spec.maxBudgetUsd ? [{ args: ["--max-budget-usd", String(spec.maxBudgetUsd)], optional: true }] : []),
        ...(spec.effort ? [{ args: ["--effort", spec.effort], optional: true }] : []),
      ];

      // Exit 0 is not success on its own: the envelope can report is_error with code 0.
      const looksFailed = (r: { code: number | null; stdout: string }) => {
        if (r.code !== 0) return true;
        try {
          return JSON.parse(r.stdout).is_error === true;
        } catch {
          return true;
        }
      };

      const r = await runPlanned(
        bin,
        groups,
        { cwd, timeoutMs, ...(delivery.stdin !== undefined && { stdin: delivery.stdin }) },
        looksFailed,
      );

      if (r.timedOut) {
        const meta = envelopeMeta(r.stdout);
        return { ok: false, error: `timeout after ${Math.round(r.ms / 1000)}s`, kind: "timeout", ...(meta ?? {}), capture: r };
      }
      const spawnErr = spawnFailure(r);
      if (spawnErr) return { ok: false, error: spawnErr, kind: "not-runnable", capture: r };

      let j: Record<string, unknown>;
      try {
        j = JSON.parse(r.stdout);
      } catch {
        return {
          ok: false,
          error: `unparsable output (${exitLabel(r)}) ${r.stderr.slice(0, 200)}`,
          kind: classify(r.stderr),
          capture: r,
        };
      }

      const usage: Usage = {};
      if (typeof j.num_turns === "number") usage.turns = j.num_turns;
      // An absent key means UNKNOWN cost; an explicit `undefined` would claim we know.
      const cost = typeof j.total_cost_usd === "number" ? { costUsd: j.total_cost_usd } : {};

      if (r.code === 0 && j.is_error === false) {
        const text = String(j.result ?? "").trim();
        if (!text) return { ok: false, error: "empty answer", kind: "empty", ...cost, usage, capture: r };
        return { ok: true, text, ...cost, usage, capture: r };
      }

      const budget = j.subtype === "error_max_budget_usd";
      const error = Array.isArray(j.errors) && j.errors.length
        ? j.errors.join("; ")
        : typeof j.result === "string" && j.result
          ? j.result
          : `is_error=${j.is_error} subtype=${j.subtype}`;
      return {
        ok: false,
        error,
        kind: budget ? "budget" : classify(`${error} ${r.stderr}`),
        ...cost,
        usage,
        capture: r,
      };
    },
  };
}

export const claudeProvider: ProviderDef = {
  key: "claude",
  label: "Claude Code",
  vendor: "anthropic",
  defaultBin: "claude",
  versionArgs: ["--version"],
  // Capability ceiling of the runtime, not of a given participant: a spec decides
  // which of these to actually switch on.
  caps: { execute: true, web: true, reportsCost: true },
  install: "npm install -g @anthropic-ai/claude-code   (then: claude  → /login)",
  make,
};
