// Codex CLI adapter. `codex exec --json` streams JSONL to stdout and narration to
// stderr. The final answer is the LAST `item.completed` whose item is an
// `agent_message`; success additionally requires a `turn.completed` with no
// `turn.failed` / `error` event — exit 0 alone is not enough.
//
// Counting rule that is easy to get wrong: count `item.completed` ONLY. `item.started`
// carries the same `item.type`, so counting both double-reports every tool call.

import { runPlanned, type ArgGroup } from "./argplan.ts";
import { deliverPrompt } from "./delivery.ts";
import { jsonLines, spawnFailure, exitLabel, DEFAULT_TIMEOUT_MS } from "../spawn.ts";
import type { Agent, AgentOutcome, ProviderDef, ProviderSpec, Usage } from "./types.ts";
import { classify } from "./types.ts";

// Item types that are real tool invocations. `agent_message`, `reasoning`, `todo_list`
// and `error` are narration — counting them would make toolCalls meaningless.
const TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "collab_tool_call", "web_search"]);

function make(spec: ProviderSpec): Agent {
  const bin = spec.bin ?? "codex";
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = spec.model;

  return {
    provider: "codex",
    label: `Codex CLI (${model ?? "account default"})`,
    vendor: "openai",
    bin,
    // `-s read-only` is an OS-enforced sandbox around a real shell, so execute is
    // always physically available; web access rides on the same sandbox.
    caps: { execute: true, web: spec.web === true, reportsCost: false },
    async run(prompt, cwd): Promise<AgentOutcome> {
      // `codex exec -` takes the FULL prompt from stdin (a bare pipe alongside a prompt
      // argument would instead append it as a separate <stdin> block).
      const delivery = deliverPrompt(prompt, spec.promptMode === "stdin" ? "stdin" : undefined);
      const groups: ArgGroup[] = [
        { args: ["exec", "--json"] },
        // OS-level sandbox: the agent may read and run commands but cannot write.
        { args: ["-s", "read-only"] },
        // Debates run in throwaway dirs that are not git repos.
        { args: ["--skip-git-repo-check"], optional: true },
        // No rollout files: this orchestrator owns the conversation memory.
        { args: ["--ephemeral"], optional: true },
        ...(model ? [{ args: ["-m", model] }] : []),
        // Codex has no --effort flag; effort is a config override.
        ...(spec.effort ? [{ args: ["-c", `model_reasoning_effort="${spec.effort}"`], optional: true }] : []),
        // Web access is a sandbox setting, not a tool flag.
        ...(spec.web ? [{ args: ["-c", "tools.web_search=true"], optional: true }] : []),
        { args: [delivery.viaStdin ? "-" : prompt] },
      ];

      const r = await runPlanned(bin, groups, {
        cwd,
        timeoutMs,
        ...(delivery.stdin !== undefined && { stdin: delivery.stdin }),
      });
      if (r.timedOut) return { ok: false, error: `timeout after ${Math.round(r.ms / 1000)}s`, kind: "timeout", capture: r };
      const spawnErr = spawnFailure(r);
      if (spawnErr) return { ok: false, error: spawnErr, kind: "not-runnable", capture: r };

      let text = "";
      let turnCompleted = false;
      let failure = "";
      let toolCalls = 0;
      let ranCommands = 0;
      let tokens: number | undefined;

      for (const ev of jsonLines(r.stdout)) {
        const item = ev.item as Record<string, unknown> | undefined;
        if (ev.type === "item.completed" && item?.type === "agent_message") {
          text = String(item.text ?? "");
        } else if (ev.type === "item.completed" && typeof item?.type === "string" && TOOL_ITEMS.has(item.type)) {
          toolCalls++;
          if (item.type === "command_execution") ranCommands++;
        } else if (ev.type === "turn.completed") {
          turnCompleted = true;
          const u = ev.usage as Record<string, unknown> | undefined;
          const total = u?.total_tokens ?? u?.input_tokens;
          if (typeof total === "number") tokens = total;
        } else if (ev.type === "turn.failed") {
          const err = ev.error as Record<string, unknown> | undefined;
          failure ||= String(err?.message ?? "turn.failed");
        } else if (ev.type === "error") {
          failure ||= String(ev.message ?? "error event");
        }
      }

      const usage: Usage = { toolCalls, ranCommands, ...(tokens !== undefined && { tokens }) };
      if (r.code === 0 && turnCompleted && !failure && text.trim()) {
        // No costUsd: a ChatGPT-account login reports tokens, never dollars.
        return { ok: true, text: text.trim(), usage, capture: r };
      }
      const error = failure || `${exitLabel(r)} ${r.stderr.slice(0, 200)}`.trim();
      return { ok: false, error, kind: text.trim() ? "other" : classify(error, "empty"), usage, capture: r };
    },
  };
}

export const codexProvider: ProviderDef = {
  key: "codex",
  label: "Codex CLI",
  vendor: "openai",
  defaultBin: "codex",
  versionArgs: ["--version"],
  caps: { execute: true, web: true, reportsCost: false },
  install: "npm install -g @openai/codex   (then: codex  → /login)",
  make,
};
