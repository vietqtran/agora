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
   * Grant web access for this participant. Off by default so a debate cannot
   * silently reach the network; the researcher role turns it on deliberately.
   */
  web?: boolean;
  /** Grant a shell (read-only commands) so the turn can gather repo evidence. */
  execute?: boolean;
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

/** Classify a generic stderr/exit pair into a FailureKind. */
export function classify(stderr: string, fallback: FailureKind = "other"): FailureKind {
  const s = stderr.toLowerCase();
  if (/not logged in|unauthenticated|unauthorized|login|auth/.test(s) && !/author/.test(s)) return "auth";
  return fallback;
}
