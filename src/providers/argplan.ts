// Version tolerance for CLI flags.
//
// A debate tool is pinned to no single CLI release, but the CLIs change flags between
// minor versions, and an unknown flag is a hard exit — the whole turn dies for a knob
// we only wanted as a nicety (effort, budget, session suppression). So every adapter
// declares its argv as GROUPS marked required or optional: we run the full argv, and
// if the CLI rejects a flag we retry ONCE with the optional groups dropped.
//
// This is what lets one config work across a fleet of servers with different CLI
// versions, instead of failing on the newest flag the oldest box has never heard of.

import { runCli, type CliCapture, type RunOpts } from "../spawn.ts";

export type ArgGroup = {
  args: string[];
  /** Droppable: a convenience flag, not something the adapter's parsing depends on. */
  optional?: boolean;
  /**
   * What the user LOSES if this group gets dropped — set it only where the loss changes
   * a guarantee (isolation, sandbox, web access), not for comfort flags. Without this,
   * version tolerance quietly becomes "the safety flag went missing and nobody said so".
   */
  lost?: string;
};

export function flatten(groups: ArgGroup[], includeOptional = true): string[] {
  const out: string[] = [];
  for (const g of groups) {
    if (g.optional && !includeOptional) continue;
    out.push(...g.args);
  }
  return out;
}

/**
 * Sandbox requested, host cannot provide one. A distinct family from an unknown flag:
 * the CLI understands `--sandbox` perfectly and fails because docker/podman/seatbelt is
 * missing or dead. An adapter that asks for a sandbox opts into retrying on these, so a
 * host without a container runtime still gets a turn instead of a wall.
 */
const SANDBOX_UNAVAILABLE = [
  /sandbox[^\n]{0,60}(not (found|available|supported|installed)|unavailable|disabled|is required)/i,
  /(failed|unable|could not|cannot)[^\n]{0,40}(start|create|initiali[sz]e|enter|enable)[^\n]{0,20}sandbox/i,
  /sandbox[^\n]{0,40}(failed|error|not running)/i,
  /(docker|podman)[^\n]{0,60}(not (found|installed|running)|unavailable|daemon is not|cannot connect|connection refused)/i,
  /(cannot connect|could not connect|connection refused)[^\n]{0,40}(docker|podman)/i,
  /(no such file or directory|command not found)[^\n]{0,20}(docker|podman|sandbox-exec)/i,
];

const UNSUPPORTED_FLAG = [
  /unknown option/i,
  /unknown argument/i,
  /unrecognized (option|argument)/i,
  /unexpected argument/i,
  /invalid option/i,
  /no such option/i,
  /error: unknown flag/i,
  /flag provided but not defined/i,
];

/**
 * Did the CLI refuse to start because of a flag it does not know?
 * Only consulted on a FAILED capture, so a legitimate mention of these words inside a
 * successful answer can never trigger a pointless retry.
 */
export function unsupportedFlag(r: CliCapture): boolean {
  const hay = `${r.stderr}\n${r.stdout}`.slice(0, 4000);
  return UNSUPPORTED_FLAG.some((re) => re.test(hay));
}

/** Same contract as `unsupportedFlag`: only ever consulted on a FAILED capture. */
export function sandboxUnavailable(r: CliCapture): boolean {
  const hay = `${r.stderr}\n${r.stdout}`.slice(0, 4000);
  return SANDBOX_UNAVAILABLE.some((re) => re.test(hay));
}

/** Retry trigger for adapters whose optional groups include a `--sandbox` request. */
export function flagOrSandbox(r: CliCapture): boolean {
  return unsupportedFlag(r) || sandboxUnavailable(r);
}

export type PlannedRun = CliCapture & {
  /**
   * True when the optional flags had to be dropped. Adapters that put a SAFETY flag in
   * an optional group (claude's `--bare`) are degraded in a way the answer does not
   * show, so this also writes a note onto the capture — which travels all the way to
   * the transcript, `run.json`, the terminal and the web UI.
   */
  degraded: boolean;
};

/** The dropped flags, named, so a note can say what the retry actually gave up. */
function droppedFlags(groups: ArgGroup[]): string[] {
  return groups.filter((g) => g.optional).map((g) => g.args[0] ?? "").filter(Boolean);
}

/**
 * Run `bin` with the planned argv, retrying once without optional groups if the CLI
 * rejected a flag. `looksFailed` decides what counts as a failure worth retrying:
 * adapters know their own success shape (exit 0 alone is not enough for a JSON CLI
 * that can exit 0 while reporting is_error).
 */
export async function runPlanned(
  bin: string,
  groups: ArgGroup[],
  opts: RunOpts,
  looksFailed: (r: CliCapture) => boolean = (r) => r.code !== 0,
  retryWhen: (r: CliCapture) => boolean = unsupportedFlag,
): Promise<PlannedRun> {
  const first = await runCli(bin, flatten(groups, true), opts);
  const hasOptional = groups.some((g) => g.optional);
  if (!hasOptional || first.timedOut || !looksFailed(first) || !retryWhen(first)) {
    return { ...first, degraded: false };
  }
  const second = await runCli(bin, flatten(groups, false), opts);
  const lost = groups.filter((g) => g.optional && g.lost).map((g) => g.lost as string);
  // Name the actual cause: "the CLI rejected a flag" and "this host cannot give you a
  // sandbox" call for different fixes, and the note is the only place the user sees it.
  const cause = unsupportedFlag(first)
    ? "CLI từ chối một cờ"
    : sandboxUnavailable(first)
      ? "máy không cấp được sandbox"
      : "lượt đầu thất bại";
  const note =
    `${cause} nên lượt này đã chạy LẠI không có các cờ tuỳ chọn ` +
    `(${droppedFlags(groups).join(" ")})` +
    (lost.length ? ` — mất: ${lost.join("; ")}` : "");
  return { ...second, degraded: true, notes: [...(second.notes ?? []), note] };
}
