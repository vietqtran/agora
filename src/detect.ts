// Discovery: what can this machine actually run, right now?
//
// This is the feature the user asked for and the one the existing tools lack: a lineup
// is not declared up front and then hoped for, it is DISCOVERED. Two separate
// questions, deliberately answered by two different probes, because conflating them
// produces the single most confusing failure in tools like this ("it says claude is
// broken" when claude is simply not logged in):
//
//   1. PRESENCE — is the binary there and runnable? `--version`. Free, no auth, no
//      tokens, milliseconds. Also catches the stale-shim case (exit 126/127).
//   2. HEALTH — will it answer a prompt? A one-word canary through the REAL adapter,
//      so it fails exactly the way a debate turn would. Costs a few tokens, needs auth.
//
// `agora doctor` runs presence always and health on request.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DISCOVERABLE, providerDef, buildAgent } from "./providers/registry.ts";
import type { Agent, FailureKind, ProviderDef, ProviderSpec } from "./providers/types.ts";
import { truncate } from "./providers/types.ts";

const execFileAsync = promisify(execFile);

/** Version probes must be fast; a hang here would stall startup, not a debate turn. */
export const VERSION_TIMEOUT_MS = 15_000;
/** A canary that can hang for the full turn timeout is useless as a preflight. */
export const CANARY_TIMEOUT_MS = 90_000;

/** Rigid on purpose; we never assert the text equals "pong" — a well-formed success */
/** envelope is the entire question, and asserting the wording makes doctor flaky. */
export const CANARY_PROMPT =
  'Reply with exactly the single word "pong" and nothing else. This is a connectivity check.';

/** Places a globally installed agent CLI tends to land when PATH is incomplete. */
/** Non-login SSH shells routinely miss nvm/homebrew paths, which is exactly how */
/** "it works in my terminal but not from cron" happens. */
function knownBinDirs(): string[] {
  const home = homedir();
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".claude", "local"),
    join(home, ".volta", "bin"),
  ];
}

/** Every path that might hold this binary: what PATH knows, plus the usual suspects. */
export async function candidateBins(bin: string): Promise<string[]> {
  const found: string[] = [];
  try {
    const { stdout } = await execFileAsync("which", ["-a", bin], { timeout: VERSION_TIMEOUT_MS });
    for (const line of stdout.split("\n")) {
      const p = line.trim();
      if (p) found.push(p);
    }
  } catch {
    /* `which` missing or no match — fall through to the known dirs */
  }
  for (const dir of knownBinDirs()) {
    const p = join(dir, bin);
    try {
      await access(p);
      found.push(p);
    } catch {
      /* not here */
    }
  }
  return [...new Set(found)];
}

export type Presence = {
  provider: string;
  label: string;
  vendor: string;
  available: boolean;
  /** The binary that answered `--version`, absolute when resolved off PATH. */
  bin?: string;
  version?: string;
  /** Other installs found — a stale shim shadowing a newer one lives here. */
  shadowed: string[];
  detail: string;
  deprecated?: string;
};

async function probeVersion(bin: string, args: string[]): Promise<{ ok: boolean; version?: string; detail: string }> {
  if (args.length === 0) return { ok: true, detail: "in-process" };
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: VERSION_TIMEOUT_MS });
    const line = (stdout || stderr).split("\n").map((l) => l.trim()).find((l) => l) ?? "";
    return { ok: true, version: truncate(line, 60), detail: truncate(line, 60) };
  } catch (e) {
    const err = e as { code?: number | string; killed?: boolean; stderr?: string };
    if (err.killed) return { ok: false, detail: `--version timed out after ${VERSION_TIMEOUT_MS / 1000}s` };
    if (err.code === "ENOENT") return { ok: false, detail: "not installed" };
    return { ok: false, detail: truncate(String(err.stderr ?? err.code ?? e), 120) };
  }
}

/** Presence-probe one runtime across every candidate binary; first answer wins. */
export async function detectProvider(def: ProviderDef, pinnedBin?: string): Promise<Presence> {
  const base = { provider: def.key, label: def.label, vendor: def.vendor, ...(def.deprecated && { deprecated: def.deprecated }) };
  const bins = pinnedBin ? [pinnedBin] : [def.defaultBin, ...(await candidateBins(def.defaultBin))];
  const tried = [...new Set(bins)];

  let firstDetail = "not installed";
  for (let i = 0; i < tried.length; i++) {
    const r = await probeVersion(tried[i], def.versionArgs);
    if (i === 0) firstDetail = r.detail;
    if (r.ok) {
      return {
        ...base,
        available: true,
        // Only pin a non-PATH path: a working PATH binary needs no override, which
        // keeps a generated config portable to the next machine.
        bin: i === 0 ? def.defaultBin : tried[i],
        ...(r.version && { version: r.version }),
        shadowed: tried.filter((_, k) => k !== i && k !== 0),
        detail: r.detail,
      };
    }
  }
  return { ...base, available: false, shadowed: [], detail: firstDetail };
}

/** Presence-probe every discoverable runtime, in parallel. */
export async function discover(pins: Record<string, string> = {}): Promise<Presence[]> {
  return Promise.all(DISCOVERABLE.map((def) => detectProvider(def, pins[def.key])));
}

export type Health = {
  provider: string;
  label: string;
  ok: boolean;
  detail: string;
  ms: number;
  /** Why it failed, so the caller can name the fix instead of just the symptom. */
  kind?: FailureKind;
  /** The binary that was tried, for the remediation message. */
  bin: string;
};

/**
 * Health-check one spec by running the canary through its real adapter, in a throwaway
 * directory. Isolation matters even here: an agentic CLI canaried inside your project
 * would read your files to answer "pong".
 */
export async function canary(spec: ProviderSpec): Promise<Health> {
  const agent: Agent = buildAgent({ ...spec, timeoutMs: CANARY_TIMEOUT_MS });
  const started = performance.now();
  const dir = await mkdtemp(join(tmpdir(), "agora-canary-"));
  try {
    const r = await agent.run(CANARY_PROMPT, dir);
    return {
      provider: agent.provider,
      label: agent.label,
      bin: agent.bin,
      ok: r.ok,
      detail: r.ok ? truncate(r.text, 80) || "(empty success)" : `${r.kind}: ${truncate(r.error, 100)}`,
      ...(r.ok ? {} : { kind: r.kind }),
      ms: performance.now() - started,
    };
  } catch (e) {
    // A failure to even set up the run is still a doctor finding, not a crash.
    return {
      provider: spec.provider,
      label: spec.provider,
      bin: spec.bin ?? spec.provider,
      ok: false,
      detail: truncate(String(e), 120),
      kind: "other",
      ms: performance.now() - started,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Install hint for a runtime a role wanted but could not get. */
export function installHint(providerKey: string): string {
  return providerDef(providerKey).install;
}
