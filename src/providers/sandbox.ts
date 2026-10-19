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

/**
 * "Is this an executable file?" — injectable so the branches can be tested on any host.
 * Faking only the platform string would leave the test asserting against the REAL
 * filesystem, i.e. passing on a Mac and failing on the Linux box it is meant to protect.
 */
export type IsExecutable = (path: string) => Promise<boolean>;

const executable: IsExecutable = async (path) => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Probed once per process: PATH does not change under us, and turns run in parallel. */
let probe: Promise<SandboxSupport> | null = null;

async function onPath(cmd: string, env: NodeJS.ProcessEnv, isExec: IsExecutable): Promise<boolean> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    // An unreadable or absent PATH entry is normal, not an error.
    if (dir && (await isExec(join(dir, cmd)))) return true;
  }
  return false;
}

/** `plat` and `isExec` are parameters so every branch is testable on any host. */
export async function detectSandbox(
  env: NodeJS.ProcessEnv = process.env,
  plat: string = platform(),
  isExec: IsExecutable = executable,
): Promise<SandboxSupport> {
  // macOS seatbelt lives at a fixed path and is not always on PATH. A Mac without it
  // falls through to the container runtimes rather than claiming a sandbox it lacks.
  if (plat === "darwin") {
    for (const p of ["/usr/bin/sandbox-exec", "/usr/sbin/sandbox-exec"]) {
      if (await isExec(p)) return { available: true, how: "macOS seatbelt (sandbox-exec)" };
    }
  }
  for (const cmd of ["docker", "podman"]) {
    if (await onPath(cmd, env, isExec)) return { available: true, how: cmd };
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
