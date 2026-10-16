// The escape hatch, and the reason this tool does not go stale.
//
// Every orchestrator we studied ships a fixed list of supported CLIs, so the day you
// install a new one — opencode, cursor-agent, qwen-code, aider, pi, copilot, a company
// -internal wrapper — you are waiting on someone else's release. A `custom` provider is
// a declaration instead: name the command, say where the prompt goes and where the
// answer comes back, and it is a first-class debate participant.
//
//   { "provider": "custom", "id": "opencode", "label": "OpenCode",
//     "command": "opencode", "args": ["run", "--format", "json", "{prompt}"],
//     "promptMode": "arg", "parse": "json", "textPath": "response" }

import { runCli, jsonLines, spawnFailure, exitLabel, DEFAULT_TIMEOUT_MS } from "../spawn.ts";
import type { Agent, AgentOutcome, ProviderDef, ProviderSpec } from "./types.ts";
import { classify } from "./types.ts";

const PROMPT_TOKEN = "{prompt}";

/** Read a dot path out of parsed JSON. Returns "" for anything non-string. */
export function dotPath(obj: unknown, path: string): string {
  if (!path) return typeof obj === "string" ? obj : "";
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return "";
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : typeof cur === "number" ? String(cur) : "";
}

/** Build argv, substituting the prompt placeholder where the user put it. */
export function buildArgs(args: string[], prompt: string, mode: ProviderSpec["promptMode"]): string[] {
  if (mode === "stdin") return args.filter((a) => a !== PROMPT_TOKEN);
  const hasToken = args.some((a) => a.includes(PROMPT_TOKEN));
  if (hasToken) return args.map((a) => a.split(PROMPT_TOKEN).join(prompt));
  // No placeholder and not stdin: the prompt is the final positional argument.
  return [...args, prompt];
}

/** Pull the answer out of whatever shape the CLI emits. */
export function extractText(stdout: string, parse: ProviderSpec["parse"], textPath?: string): string {
  if (parse === "json") {
    try {
      return dotPath(JSON.parse(stdout), textPath ?? "").trim();
    } catch {
      return "";
    }
  }
  if (parse === "jsonl") {
    // Streamed events: the answer is the LAST line that actually carries one, so
    // trailing bookkeeping events cannot blank out a good reply.
    let last = "";
    for (const ev of jsonLines(stdout)) {
      const v = dotPath(ev, textPath ?? "").trim();
      if (v) last = v;
    }
    return last;
  }
  return stdout.trim();
}

function make(spec: ProviderSpec): Agent {
  const command = spec.command ?? spec.bin;
  if (!command) throw new Error(`custom provider "${spec.id ?? "?"}" needs a "command"`);
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const parse = spec.parse ?? "text";

  return {
    provider: spec.id ?? command,
    label: spec.label ?? `${command}${spec.model ? ` (${spec.model})` : ""}`,
    vendor: spec.vendor ?? "custom",
    bin: command,
    // A custom runtime's real powers are unknown to us, so we report what the user
    // declared. Over-declaring only affects role preference, never safety: the engine
    // still runs every turn in a throwaway directory.
    caps: { execute: spec.execute === true, web: spec.web === true, reportsCost: false },
    async run(prompt, cwd): Promise<AgentOutcome> {
      const args = buildArgs(spec.args ?? [], prompt, spec.promptMode);
      const r = await runCli(command, args, {
        cwd,
        timeoutMs,
        ...(spec.env && { env: spec.env }),
        ...(spec.promptMode === "stdin" && { stdin: prompt }),
      });

      if (r.timedOut) return { ok: false, error: `timeout after ${Math.round(r.ms / 1000)}s`, kind: "timeout", capture: r };
      const spawnErr = spawnFailure(r);
      if (spawnErr) return { ok: false, error: spawnErr, kind: "not-runnable", capture: r };

      const text = extractText(r.stdout, parse, spec.textPath);
      if (r.code === 0 && text) return { ok: true, text, capture: r };
      const error = `${exitLabel(r)} ${(r.stderr || r.stdout).slice(0, 200)}`.trim();
      return { ok: false, error, kind: classify(error, "empty"), capture: r };
    },
  };
}

export const customProvider: ProviderDef = {
  key: "custom",
  label: "Custom CLI",
  vendor: "custom",
  defaultBin: "",
  versionArgs: ["--version"],
  caps: { execute: true, web: true, reportsCost: false },
  install: 'declare it in agora.config.json with { "provider": "custom", "command": "..." }',
  make,
};
