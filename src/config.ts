// Configuration: layered, so one file can serve a laptop and a fleet of servers.
//
// Precedence, lowest to highest:
//   built-in defaults → ~/.config/agora/config.json → ./agora.config.json → CLI flags
//
// Nothing in the config names a binary path by default. That was the footgun in the
// tools we studied: a committed config with `bin: /opt/homebrew/bin/codex` works on the
// author's Mac and breaks every Linux server that reads it. Here, detection resolves
// binaries at run time, and a pin is an explicit opt-out for one machine.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderSpec } from "./providers/types.ts";

/**
 * Per-role knobs. Generic keys (effort, budget) apply to whichever runtime the role
 * lands on; model names do NOT travel across vendors, so they live under `byProvider`.
 * Without that split, a judge configured as `model: "opus"` silently hands "opus" to
 * Codex the moment Claude is missing from a machine — a config that only works as long
 * as casting happens to pick the vendor the author had in mind.
 */
export type RoleOption = Partial<ProviderSpec> & {
  byProvider?: Record<string, Partial<ProviderSpec>>;
};

export type AgoraConfig = {
  language: string;
  rounds: number;
  timeoutMinutes: number;
  maxQuestions: number;
  /** Debater roles, in presentation order. */
  roles: string[];
  /** Judge role id, or null to end the debate at the cross-examination rounds. */
  judge: string | null;
  /** Hard role→provider pins. Empty means "let the caster decide". */
  cast: Record<string, string>;
  /** Per-provider defaults (model, effort, budget, pinned bin). */
  providers: Record<string, Partial<ProviderSpec>>;
  /** Per-role overrides applied last — e.g. a stronger model for the judge. */
  roleOptions: Record<string, RoleOption>;
  /** Extra runtimes declared by the user; each needs provider:"custom" and a command. */
  custom: ProviderSpec[];
  /** Let one runtime play several roles when nothing else is installed. */
  allowShared: boolean;
  /** Where run artifacts are written, relative to cwd unless absolute. */
  outDir: string;
};

export const DEFAULTS: AgoraConfig = {
  language: "vi",
  rounds: 2,
  timeoutMinutes: 10,
  maxQuestions: 3,
  roles: ["architect", "researcher", "domain-expert"],
  judge: "judge",
  cast: {},
  providers: {
    // A debater on a mid model and a judge on a strong one is the cost/quality split
    // that matters most; both are overridable per role below.
    claude: { model: "sonnet", maxBudgetUsd: 5 },
    codex: {},
    antigravity: {},
    gemini: {},
  },
  roleOptions: {
    // A strong judge over mid-tier debaters is the cost/quality split that pays off
    // most; the model name is scoped to the vendor it belongs to.
    judge: { effort: "high", byProvider: { claude: { model: "opus", maxBudgetUsd: 5 } } },
  },
  custom: [],
  allowShared: true,
  outDir: ".agora/runs",
};

/**
 * Strip // and /* *​/ comments while respecting string literals, so a config can be
 * commented without a YAML dependency. A naive regex would corrupt any string
 * containing "//" — every URL, every Windows path.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let inLine = false;
  let inBlock = false;

  while (i < input.length) {
    const c = input[i];
    const next = input[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 2;
      } else {
        // Keep newlines so error line numbers still point at the right line.
        if (c === "\n") out += c;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      // A backslash escapes the next character, including a quote — consume both or a
      // string ending in \" would be read as still open.
      if (c === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));

export function mergeConfig(base: AgoraConfig, patch: Record<string, unknown>, source: string): AgoraConfig {
  const unknown = Object.keys(patch).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) {
    throw new Error(`${source}: khoá không hợp lệ: ${unknown.join(", ")} (hợp lệ: ${[...KNOWN_KEYS].join(", ")})`);
  }
  const out: AgoraConfig = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) {
      if (k === "judge") out.judge = null; // null is meaningful here: "no judge"
      continue;
    }
    // Objects merge one level deep so a config can set one provider's model without
    // wiping the defaults for every other provider.
    if (k === "providers" || k === "roleOptions" || k === "cast") {
      const prev = base[k] as Record<string, unknown>;
      const next = v as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...prev };
      for (const [pk, pv] of Object.entries(next)) {
        merged[pk] = k === "cast" ? pv : { ...((prev[pk] as object) ?? {}), ...((pv as object) ?? {}) };
      }
      (out as Record<string, unknown>)[k] = merged;
    } else {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "agora", "config.json");
}

export function projectConfigPath(cwd = process.cwd()): string {
  return join(cwd, "agora.config.json");
}

async function readMaybe(path: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    // A missing config is the normal case; anything else (permissions, I/O) must surface.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    return JSON.parse(stripJsonComments(text));
  } catch (e) {
    throw new Error(`${path}: JSON không hợp lệ — ${(e as Error).message}`);
  }
}

export type LoadedConfig = { config: AgoraConfig; sources: string[] };

export async function loadConfig(
  explicitPath?: string,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedConfig> {
  const sources: string[] = ["built-in defaults"];
  let config = DEFAULTS;

  if (explicitPath) {
    // An explicitly named config that cannot be read is an error, never a silent default.
    const patch = await readMaybe(explicitPath);
    if (patch === null) throw new Error(`không đọc được cấu hình: ${explicitPath}`);
    config = mergeConfig(config, patch, explicitPath);
    sources.push(explicitPath);
    return { config, sources };
  }

  for (const path of [userConfigPath(env), projectConfigPath(cwd)]) {
    const patch = await readMaybe(path);
    if (patch) {
      config = mergeConfig(config, patch, path);
      sources.push(path);
    }
  }
  return { config, sources };
}

/** Build the spec for one participant: provider defaults, then per-role overrides. */
export function specFor(
  config: AgoraConfig,
  providerKey: string,
  roleId: string,
  grants: { web: boolean; execute: boolean },
  pinnedBin?: string,
): ProviderSpec {
  const custom = config.custom.find((c) => (c.id ?? c.command) === providerKey);
  const base: Partial<ProviderSpec> = custom ?? config.providers[providerKey] ?? {};
  const { byProvider, ...roleGeneric } = config.roleOptions[roleId] ?? {};
  return {
    ...base,
    ...roleGeneric,
    ...(byProvider?.[providerKey] ?? {}),
    // A custom entry may declare which runtime executes it ("custom" for a real CLI,
    // "mock" for a dry run), so the dry-run path reuses this same resolution instead
    // of growing a second, divergent copy of it.
    provider: custom ? (custom.provider ?? "custom") : providerKey,
    ...(custom && { id: providerKey }),
    ...(pinnedBin && { bin: pinnedBin }),
    web: grants.web,
    execute: grants.execute,
    timeoutMs: config.timeoutMinutes * 60_000,
  };
}
