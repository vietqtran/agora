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
import type { Agent, AgentOutcome, FailureKind, ProviderDef, ProviderSpec, Usage } from "./types.ts";
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

// The `--bare` trade-off, straight from `claude --help` on 2.1.301:
//
//   "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings
//    (OAuth and keychain are never read). 3P providers (Bedrock/Vertex/Foundry) use
//    their own credentials."
//
// So the flag that keeps the user's CLAUDE.md, hooks and MCP out of the persona also
// makes an ACCOUNT login unusable — and an account login is the common case. Passing it
// unconditionally would turn every turn into an auth failure on most machines; dropping
// it unconditionally would silently contaminate every persona. Neither is acceptable, so
// we check which credentials this machine actually has and record which way it went.
const API_KEY_VARS = ["ANTHROPIC_API_KEY"];
/** 3P credentials are untouched by --bare, so these count as "key-based" too. */
const THIRD_PARTY_VARS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

function on(v: string | undefined): boolean {
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}

export function keyAuthAvailable(env: NodeJS.ProcessEnv): boolean {
  return API_KEY_VARS.some((k) => !!env[k]) || THIRD_PARTY_VARS.some((k) => on(env[k]));
}

const CONTAMINATION = "persona có thể đã nạp CLAUDE.md/hooks/skills/MCP của dự án";

/** Ask for `--bare`? Explicit config wins; otherwise go by the credentials present. */
export function decideBare(
  configured: boolean | undefined,
  env: NodeJS.ProcessEnv,
): { on: boolean; note: string | null } {
  if (configured === false) return { on: false, note: `lượt này KHÔNG có --bare vì cấu hình đặt "bare": false — ${CONTAMINATION}` };
  if (configured === true) return { on: true, note: null };
  if (keyAuthAvailable(env)) return { on: true, note: null };
  return {
    on: false,
    note:
      "lượt này KHÔNG có --bare vì máy không có ANTHROPIC_API_KEY và --bare thì không đọc " +
      `OAuth/keychain — ${CONTAMINATION}. Muốn có lại lớp cách ly: đặt ANTHROPIC_API_KEY, hoặc "bare": true nếu dùng apiKeyHelper/Bedrock/Vertex`,
  };
}

// Only reachable when --bare WAS passed: either a key exists and is being refused, or the
// user forced the flag on. argplan's retry cannot rescue this — it fires on an unknown
// flag, and this arrives as a well-formed auth error — so the exit has to be named here.
const BARE_AUTH_HINT =
  "--bare không đọc OAuth/keychain (xem `claude --help`), nên tài khoản đăng nhập kiểu OAuth sẽ lỗi auth ở đây: " +
  'đặt ANTHROPIC_API_KEY, hoặc "providers": { "claude": { "bare": false } } (đổi lại persona sẽ nạp context của dự án)';

function bareHint(error: string, kind: FailureKind, bare: boolean): string {
  return kind === "auth" && bare ? `${error} — ${BARE_AUTH_HINT}` : error;
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
      // Decided per turn, like the sandbox probe: `spec.env` is merged into the child's
      // environment, so it settles the credential question alongside the real env.
      const decision = decideBare(spec.bare, { ...process.env, ...(spec.env ?? {}) });
      const bare = decision.on;
      const groups: ArgGroup[] = [
        { args: ["-p", delivery.argvPrompt ?? ""] },
        { args: ["--output-format", "json"] },
        { args: ["--model", model] },
        // Skip auto-discovery of CLAUDE.md, hooks, skills, plugins, MCP servers and
        // auto-memory. A debate participant must be the persona THIS tool handed it:
        // silently absorbing the user's project rules and memories would contaminate
        // the role and make two runs on different machines incomparable.
        // Optional, so an older CLI that never heard of it still produces a turn. Such a
        // run has LOST this isolation, so the loss is named: the retry note says the
        // persona may have absorbed the project's CLAUDE.md, hooks and MCP.
        ...(bare ? [{ args: ["--bare"], optional: true, lost: `cách ly context (--bare) — ${CONTAMINATION}` }] : []),
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
        {
          cwd,
          timeoutMs,
          // Documented as "extra env for the child" — and silently ignored here until now.
          ...(spec.env && { env: spec.env }),
          ...(delivery.stdin !== undefined && { stdin: delivery.stdin }),
        },
        looksFailed,
      );
      if (decision.note) r.notes = [...(r.notes ?? []), decision.note];

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
        const kind = classify(r.stderr);
        return {
          ok: false,
          error: bareHint(`unparsable output (${exitLabel(r)}) ${r.stderr.slice(0, 200)}`, kind, bare),
          kind,
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
      const kind: FailureKind = budget ? "budget" : classify(`${error} ${r.stderr}`);
      return {
        ok: false,
        error: bareHint(error, kind, bare),
        kind,
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
