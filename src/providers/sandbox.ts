// Can this host actually give a CLI a sandbox?
//
// `--sandbox` on the Google CLIs is a REQUEST, not a guarantee: the CLI needs a backend
// to honour it — macOS ships seatbelt (`sandbox-exec`), everywhere else it is docker or
// podman. Passing the flag on a host with neither turns a working turn into a hard
// failure, which is exactly why the Gemini adapter shipped without it and ran
// unsandboxed instead. Neither half of that trade is acceptable on its own, so we probe:
// ask for the sandbox where it can be honoured, and where it cannot, say so in the
// turn's audit note rather than leaving the README to promise something the host cannot
// deliver.
//
// The probe is binary PRESENCE only. A docker binary with a dead daemon still looks
// available here; that case is caught at run time by `sandboxUnavailable` in argplan,
// which retries without the flag. Cheap-and-wrong-loudly beats slow-and-wrong-quietly:
// a `docker info` round trip would add seconds to every turn on every host.

import { access, constants } from "node:fs/promises";
import { platform } from "node:os";
import { delimiter, join } from "node:path";

export type SandboxSupport = {
  available: boolean;
  /** Which backend answered, or why none did. For the audit note. */
  how: string;
};

/** Probed once per process: PATH does not change under us, and turns run in parallel. */
let probe: Promise<SandboxSupport> | null = null;

async function onPath(cmd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      await access(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // Next directory. An unreadable PATH entry is normal, not an error.
    }
  }
  return false;
}

/** `plat` is a parameter so a test can exercise the no-backend branch on any host. */
export async function detectSandbox(
  env: NodeJS.ProcessEnv = process.env,
  plat: string = platform(),
): Promise<SandboxSupport> {
  // macOS seatbelt lives at a fixed path and is not always on PATH.
  if (plat === "darwin") {
    for (const p of ["/usr/bin/sandbox-exec", "/usr/sbin/sandbox-exec"]) {
      try {
        await access(p, constants.X_OK);
        return { available: true, how: "macOS seatbelt (sandbox-exec)" };
      } catch {
        // Fall through to the container runtimes.
      }
    }
  }
  for (const cmd of ["docker", "podman"]) {
    if (await onPath(cmd, env)) return { available: true, how: cmd };
  }
  return {
    available: false,
    how: "không thấy backend sandbox nào (cần sandbox-exec trên macOS, hoặc docker/podman)",
  };
}

export function sandboxSupport(env: NodeJS.ProcessEnv = process.env): Promise<SandboxSupport> {
  probe ??= detectSandbox(env);
  return probe;
}

/** Tests only: the probe is memoised, so a test that changes PATH must clear it. */
export function resetSandboxProbe(): void {
  probe = null;
}

/**
 * Should this participant ask for a sandbox? Explicit config always wins over the probe:
 * a user who knows their host (or who deliberately does not want a container spun up)
 * must not be overruled by a heuristic.
 */
export async function wantSandbox(
  configured: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ on: boolean; note: string | null }> {
  if (configured === false) {
    return { on: false, note: 'lượt này chạy KHÔNG sandbox vì cấu hình đặt "sandbox": false' };
  }
  if (configured === true) return { on: true, note: null };
  const support = await sandboxSupport(env);
  if (support.available) return { on: true, note: null };
  return { on: false, note: `lượt này chạy KHÔNG sandbox: ${support.how}` };
}
