// The provider contract.
//
// The central design decision of this tool: a PROVIDER (which CLI runtime executes a
// turn) is fully decoupled from a ROLE (which expert persona the turn plays). Every
// tool we studied hard-wires the two together — "codex is the researcher" lives inside
// the orchestrator — which is exactly why they stop working on a machine that happens
// to have a different set of CLIs installed. Here a role declares an ordered
// PREFERENCE over providers and the caster binds it to whatever is actually present.

import type { CliCapture } from "../spawn.ts";

/** What a runtime can physically do. Roles use this to pick a provider, not vibes. */
export type Capability = {
  /** Can run shell commands — i.e. can gather executable evidence from a repo. */
  execute: boolean;
  /** Has first-class web search / fetch, so it can research live information. */
  web: boolean;
  /** Reports spend in USD (enables a real budget cap, not just a timeout). */
  reportsCost: boolean;
};

export type FailureKind =
  | "timeout"
  | "budget"
  | "not-runnable" // binary missing / shadowed shim — a setup problem
  | "auth" // CLI runs but is not logged in
  | "model" // the requested model is not available to this account
  | "rate-limit" // 429 — the account is being asked for too much at once
  | "empty" // exit 0 with nothing usable
  | "other";

/** Coarse activity signals, where the CLI reports them. Undefined means UNKNOWN. */
export type Usage = {
  turns?: number;
  toolCalls?: number;
  ranCommands?: number;
  tokens?: number;
};

export type AgentOutcome =
  | { ok: true; text: string; costUsd?: number; usage?: Usage; capture?: CliCapture }
  | {
      ok: false;
      error: string;
      kind: FailureKind;
      /** A turn killed mid-flight can still have spent money. Never discard it. */
      costUsd?: number;
      usage?: Usage;
      capture?: CliCapture;
    };

/** User-facing knobs for one participant, from config or CLI flags. */
export type ProviderSpec = {
  provider: string;
  /** Pin the binary when a stale version-manager shim shadows the real install. */
  bin?: string;
  model?: string;
  /** Reasoning effort. Value sets differ per CLI; passed through unvalidated. */
  effort?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /**
   * Claude Code only. `--bare` keeps the user's CLAUDE.md, hooks, skills and MCP out of
   * the persona, so it is ON by default. Turn it off when the CLI reports an auth failure
   * under it: `--bare` is reported upstream (NOT reproduced here) to bypass the
   * OAuth/keychain session, which breaks an account login while an API key keeps working.
   * The cost of turning it off is real — the role then inherits the project's own rules.
   */
  bare?: boolean;
  /**
   * Grant web access for this participant. Off by default so a debate cannot
   * silently reach the network; the researcher role turns it on deliberately.
   */
  web?: boolean;
  /** Grant a shell (read-only commands) so the turn can gather repo evidence. */
  execute?: boolean;
  /**
   * Ask the CLI for an OS/container sandbox where it supports one (the Google CLIs'
   * `--sandbox`). Unset = probe the host and use it if a backend exists. Set it true to
   * demand it on a host we failed to detect, false to keep a container from being spun
   * up at all — either way the turn records which way it went.
   */
  sandbox?: boolean;
  /** Extra env for the child process only. */
  env?: Record<string, string>;

  // --- "custom" provider only (see providers/custom.ts) ---
  /** Registry id, so several custom runtimes can coexist. Defaults to the command. */
  id?: string;
  label?: string;
  vendor?: string;
  command?: string;
  args?: string[];
  /** How the prompt reaches the CLI. "arg" substitutes the {prompt} placeholder. */
  promptMode?: "arg" | "stdin" | "append";
  parse?: "text" | "json" | "jsonl";
  /** Dot path to the answer inside parsed JSON, e.g. "response" or "result.text". */
  textPath?: string;
  /** Scripted replies for the "mock" runtime (tests, --dry-run). */
  script?: Record<string, string>;
};

export type Agent = {
  /** Registry key of the runtime ("claude", "codex", ...). */
  provider: string;
  /** Human label incl. model, e.g. "Claude Code (sonnet)". */
  label: string;
  vendor: string;
  bin: string;
  caps: Capability;
  run(prompt: string, cwd: string): Promise<AgentOutcome>;
};

/** Static metadata + factory for a known CLI runtime. */
export type ProviderDef = {
  key: string;
  label: string;
  vendor: string;
  defaultBin: string;
  /**
   * argv that makes the CLI print its version and exit. This is the FREE presence
   * probe — it costs no tokens and no auth, so `agora doctor` can tell "not
   * installed" apart from "installed but not logged in".
   */
  versionArgs: string[];
  caps: Capability;
  /** Shown when the CLI is missing but a role wanted it. */
  install: string;
  /** Set when upstream has retired the CLI; the caster deprioritises it. */
  deprecated?: string;
  make(spec: ProviderSpec): Agent;
};

/**
 * How a turn ran weaker than advertised: dropped flags, a sandbox the host could not
 * provide. Kept on the capture so no adapter return path can lose it — this accessor is
 * the only thing consumers should need to know about that.
 */
export function outcomeNotes(o: AgentOutcome): string[] {
  return o.capture?.notes ?? [];
}

/** Shared helper: first non-empty trimmed string, or "". */
export function firstText(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

export function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Classify an error string into a FailureKind.
 *
 * Model errors are checked FIRST and deliberately: "The 'gpt-5.5' model is not supported
 * when using Codex with a ChatGPT account" is an account/plan message, so a naive auth
 * check claims it first and sends the user off to re-login — which fixes nothing. The
 * two call for opposite actions, so the more specific pattern has to win.
 */
export function classify(stderr: string, fallback: FailureKind = "other"): FailureKind {
  const s = stderr.toLowerCase();
  if (
    /model .{0,40}(is not supported|not found|does not exist|is not available|no access)/.test(s) ||
    /(unknown|invalid|unsupported) model/.test(s) ||
    /model_not_found/.test(s)
  ) {
    return "model";
  }
  if (/not logged in|unauthenticated|unauthorized|session expired|please (log|sign) in|\blogin\b|\bauth\b/.test(s) && !/author/.test(s)) {
    return "auth";
  }
  // Observed on a real run: two roles sharing one ChatGPT account call the CLI in
  // PARALLEL during the opening phase, and one of them comes back 429. Without this it
  // lands in "empty", whose remedy ("run the command by hand") is useless advice —
  // the fix is to wait, or to stop pointing several roles at one account.
  if (/\b429\b|too many requests|rate.?limit(ed)?|resource.?exhausted|overloaded/.test(s)) {
    return "rate-limit";
  }
  return fallback;
}

/** What to actually do about a failure. Shown by `doctor` next to each failing runtime. */
export function remedy(kind: FailureKind, providerKey: string, bin: string): string {
  switch (kind) {
    case "auth":
      // Claude has a second, non-obvious cause: with `--bare` the CLI never reads OAuth
      // or the keychain (its own --help says so), so a CLI that IS logged in still fails.
      return providerKey === "claude"
        ? `chạy \`${bin}\` trên máy này rồi đăng nhập (/login). Nếu \`${bin}\` báo đã đăng nhập mà vẫn lỗi auth ở đây: đó là --bare (không đọc OAuth/keychain) — đặt ANTHROPIC_API_KEY, hoặc "providers": { "claude": { "bare": false } }`
        : `chạy \`${bin}\` trên máy này rồi đăng nhập (vd. /login), sau đó thử lại`;
    case "model":
      return `model đang yêu cầu không dùng được với tài khoản này — đặt "providers": { "${providerKey}": { "model": "<model hợp lệ>" } } trong agora.config.json`;
    case "not-runnable":
      return `binary không chạy được — kiểm tra PATH, hoặc ghim "providers": { "${providerKey}": { "bin": "/đường/dẫn/thật" } }`;
    case "timeout":
      return `tăng --timeout (phút), hoặc giảm --rounds / bớt tư liệu -m`;
    case "budget":
      return `tăng "maxBudgetUsd" cho ${providerKey} trong cấu hình`;
    case "rate-limit":
      return `tài khoản bị giới hạn tần suất — chờ vài phút rồi chạy lại. Pha mở đầu gọi các vai SONG SONG, nên nếu nhiều vai dùng chung một tài khoản thì giảm số vai, hoặc đưa vai sang CLI khác hãng (\`agora doctor\` cho biết máy có gì)`;
    case "empty":
      return `CLI chạy xong nhưng không trả về nội dung — chạy lại cùng lệnh thủ công để xem CLI nói gì`;
    default:
      return `chạy lại; nếu lặp lại, xem transcript.md để lấy nguyên văn lỗi`;
  }
}
