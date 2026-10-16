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
};

export function flatten(groups: ArgGroup[], includeOptional = true): string[] {
  const out: string[] = [];
  for (const g of groups) {
    if (g.optional && !includeOptional) continue;
    out.push(...g.args);
  }
  return out;
}

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

export type PlannedRun = CliCapture & {
  /** True when the optional flags had to be dropped — surfaced by `doctor`. */
  degraded: boolean;
};

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
): Promise<PlannedRun> {
  const first = await runCli(bin, flatten(groups, true), opts);
  const hasOptional = groups.some((g) => g.optional);
  if (!hasOptional || first.timedOut || !looksFailed(first) || !unsupportedFlag(first)) {
    return { ...first, degraded: false };
  }
  const second = await runCli(bin, flatten(groups, false), opts);
  return { ...second, degraded: true };
}
