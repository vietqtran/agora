// Transport: spawn a real agent CLI, capture its output, classify how it ended.
//
// The rules here are not style choices — each one is a failure mode observed in
// production by the projects this layer is modelled on (see docs/CREDITS.md):
//   * stdin must be IGNORED, not inherited: `codex exec` blocks waiting for EOF.
//   * the child must lead its OWN process group, so a timeout kills the whole tree.
//     Killing only the direct child leaves workers holding the stdout pipe open, so
//     `close` never fires and the orchestrator hangs at ~0% CPU.
//   * `signal` must be reported: when a CLI is killed `code` is null and the signal
//     is the only evidence of why.
//   * exit 126/127 means the shell could not run the binary at all (stale shim,
//     bad PATH) — a setup problem, never an agent failure.

import { spawn } from "node:child_process";

/** Agents think for minutes. Wall-clock cap per turn. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** After SIGTERM on a timed-out group, wait this long, then SIGKILL the group. */
export const KILL_GRACE_MS = 2_000;

export type CliCapture = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
  /**
   * Facts about HOW this invocation ran that the answer itself cannot show: a retry that
   * dropped flags, a sandbox the host could not provide. They live on the capture
   * because every adapter already attaches its capture to every outcome, success or
   * failure — so an isolation guarantee that quietly did not hold cannot slip through
   * one unhandled return path. The audit trail reads these; prompt context never does.
   */
  notes?: string[];
};

export type RunOpts = {
  cwd: string;
  timeoutMs?: number;
  /** Extra env for this child only (e.g. GEMINI_CLI_TRUST_WORKSPACE). */
  env?: Record<string, string>;
  /** Fed to the child's stdin instead of /dev/null. Only for CLIs that need it. */
  stdin?: string;
  /** Called with each stdout chunk, for live progress rendering. */
  onStdout?: (chunk: string) => void;
};

/** How a run ended, for error strings. `exit=null` alone is a dead end; name the signal. */
export function exitLabel(r: CliCapture): string {
  return r.signal ? `signal=${r.signal}` : `exit=${r.code}`;
}

/**
 * exit 126 = found but not executable, 127 = not found. Both mean the binary never
 * ran, so the message must point at PATH/shims rather than blaming the model.
 */
export function spawnFailure(r: CliCapture): string | null {
  if (r.code === 126 || r.code === 127) {
    return `binary not runnable (exit ${r.code}) — check PATH / version-manager shims, or pin "bin" in the config. stderr: ${r.stderr.slice(0, 200)}`;
  }
  return null;
}

export function runCli(cmd: string, args: string[], opts: RunOpts): Promise<CliCapture> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = performance.now();

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true, // own process group => a timeout can kill the whole tree
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;

    // Negative pid signals the GROUP. `detached` put the child in its own group, so
    // this can never reach the orchestrator. ESRCH (already gone) is benign.
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        /* already dead */
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      hardTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    const finish = (cap: Omit<CliCapture, "ms">) => {
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({ ...cap, ms: performance.now() - started });
    };

    // Typed nullable because `stdio` may be "ignore"; it is always "pipe" here.
    child.stdout?.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      opts.onStdout?.(s);
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    // A child that dies before draining stdin makes the write EPIPE; that is the
    // child's exit path, not an orchestrator error, so swallow it and let `close` win.
    child.stdin?.on("error", () => {});
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);

    child.on("error", (e) => finish({ code: null, signal: null, stdout, stderr: String(e), timedOut }));
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr, timedOut }));
  });
}

/** Parse JSONL tolerantly: CLIs interleave non-JSON noise on stdout. */
export function* jsonLines(stdout: string): Generator<Record<string, unknown>> {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") yield v as Record<string, unknown>;
    } catch {
      /* noise */
    }
  }
}
