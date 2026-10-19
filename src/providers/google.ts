// The two Google runtimes, in one file because they are the same seat in a debate.
//
// IMPORTANT CONTEXT: Gemini CLI was retired for consumer tiers on 2026-06-18 and
// replaced by Antigravity CLI (`agy`), a from-scratch rewrite with a different binary,
// config layout and quota model. `gemini` still works on Gemini Code Assist
// Standard/Enterprise licences and via GEMINI_API_KEY / Vertex, so both adapters ship:
// the caster prefers `agy` and falls back to `gemini` only where it is still live.

import { flagOrSandbox, runPlanned, type ArgGroup } from "./argplan.ts";
import { wantSandbox } from "./sandbox.ts";
import { argvTooLongHint, deliverPrompt, isArgvTooLong } from "./delivery.ts";
import { spawnFailure, exitLabel, DEFAULT_TIMEOUT_MS } from "../spawn.ts";
import type { Agent, AgentOutcome, ProviderDef, ProviderSpec, Usage } from "./types.ts";
import { classify } from "./types.ts";

// --- Antigravity (`agy`) -------------------------------------------------------------
// Text-only: there is no --output-format, stdout IS the answer. So nothing about tool
// activity is observable — usage stays UNDEFINED (unknown), never a fabricated zero.

function makeAgy(spec: ProviderSpec): Agent {
  const bin = spec.bin ?? "agy";
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = spec.model;

  return {
    provider: "antigravity",
    label: `Antigravity (${model ?? "default"})`,
    vendor: "google",
    bin,
    caps: { execute: true, web: spec.web === true, reportsCost: false },
    async run(prompt, cwd): Promise<AgentOutcome> {
      // Print mode is agentic and may auto-run terminal commands, so the sandbox is the
      // only thing standing between this turn and the user's files. Asked for whenever
      // the host can honour it; when it cannot, the turn says so instead of pretending.
      const sandbox = await wantSandbox(spec.sandbox);
      const groups: ArgGroup[] = [
        // Optional because an older/newer binary may not know the flag — and a run that
        // drops it is UNSANDBOXED, which is why the loss is named rather than swallowed.
        ...(sandbox.on ? [{ args: ["--sandbox"], optional: true, lost: "sandbox (--sandbox) — lượt này không bị OS chặn ghi" }] : []),
        // agy's own print timeout defaults shorter than ours; align them or it gives up
        // mid-thought and we never learn why.
        { args: ["--print-timeout", `${Math.max(1, Math.ceil(timeoutMs / 60_000))}m`], optional: true },
        ...(model ? [{ args: ["--model", model] }] : []),
        { args: ["-p", prompt] },
      ];

      const r = await runPlanned(bin, groups, { cwd, timeoutMs }, undefined, flagOrSandbox);
      if (sandbox.note) r.notes = [...(r.notes ?? []), sandbox.note];
      if (r.timedOut) return { ok: false, error: `timeout after ${Math.round(r.ms / 1000)}s`, kind: "timeout", capture: r };
      // agy has no documented stdin prompt form, so a prompt the OS refuses needs an
      // explanation the user can act on rather than a bare E2BIG.
      if (isArgvTooLong(r.stderr)) {
        return { ok: false, error: argvTooLongHint(prompt, "Antigravity (agy)"), kind: "not-runnable", capture: r };
      }
      const spawnErr = spawnFailure(r);
      if (spawnErr) return { ok: false, error: spawnErr, kind: "not-runnable", capture: r };

      const text = r.stdout.trim();
      if (r.code === 0 && text) return { ok: true, text, capture: r };
      const error = `${exitLabel(r)} ${r.stderr.slice(0, 200)}`.trim();
      return { ok: false, error, kind: classify(error, text ? "other" : "empty"), capture: r };
    },
  };
}

export const antigravityProvider: ProviderDef = {
  key: "antigravity",
  label: "Antigravity CLI",
  vendor: "google",
  defaultBin: "agy",
  versionArgs: ["--version"],
  caps: { execute: true, web: true, reportsCost: false },
  install: "see https://antigravity.google  (binary: agy)",
  make: makeAgy,
};

// --- Gemini CLI (legacy) -------------------------------------------------------------
// `--output-format json` returns one object: { session_id?, response?, stats?, error?,
// warnings? }. Exit codes: 0 ok · 1 general/API · 42 input error · 53 turn limit.

function makeGemini(spec: ProviderSpec): Agent {
  const bin = spec.bin ?? "gemini";
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = spec.model;

  return {
    provider: "gemini",
    label: `Gemini CLI (${model ?? "auto"})`,
    vendor: "google",
    bin,
    caps: { execute: spec.execute === true, web: spec.web === true, reportsCost: false },
    async run(prompt, cwd): Promise<AgentOutcome> {
      const delivery = deliverPrompt(prompt, spec.promptMode === "stdin" ? "stdin" : undefined);
      const sandbox = await wantSandbox(spec.sandbox);
      const groups: ArgGroup[] = [
        // -p forces non-interactive. A bare positional prompt stays INTERACTIVE in a
        // TTY, which is how a scripted run ends up hanging on a REPL forever.
        { args: ["-p", delivery.argvPrompt ?? ""] },
        { args: ["--output-format", "json"] },
        ...(model ? [{ args: ["-m", model] }] : []),
        // Pairs with yolo below and must be read together: yolo removes the human from
        // every tool call, so the sandbox becomes the only remaining boundary. Asking
        // for just one of the two is the configuration this adapter used to ship with.
        ...(sandbox.on ? [{ args: ["--sandbox"], optional: true, lost: "sandbox (--sandbox) — không còn lớp chặn ghi nào ở mức OS" }] : []),
        // Unattended runs must not block on a tool-approval prompt. The trade is real:
        // this auto-approves EVERY tool call, and the throwaway cwd does not bound where
        // a write lands — only the sandbox above does.
        { args: ["--approval-mode", "yolo"], optional: true, lost: "tự duyệt tool (--approval-mode yolo) — lượt có thể bị chặn ở bước xin phép" },
      ];

      const r = await runPlanned(
        bin,
        groups,
        {
          cwd,
          timeoutMs,
          // The folder-trust gate will otherwise refuse or hang on an untrusted dir.
          env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
          ...(delivery.stdin !== undefined && { stdin: delivery.stdin }),
        },
        undefined,
        flagOrSandbox,
      );
      if (sandbox.note) r.notes = [...(r.notes ?? []), sandbox.note];

      if (r.timedOut) return { ok: false, error: `timeout after ${Math.round(r.ms / 1000)}s`, kind: "timeout", capture: r };
      const spawnErr = spawnFailure(r);
      if (spawnErr) return { ok: false, error: spawnErr, kind: "not-runnable", capture: r };

      let j: Record<string, unknown> | null = null;
      try {
        j = JSON.parse(r.stdout);
      } catch {
        // --output-format may be unsupported on an old build; plain stdout is still an
        // answer, so degrade to text rather than throwing the turn away.
        const text = r.stdout.trim();
        if (r.code === 0 && text) return { ok: true, text, capture: r };
        const error = `${exitLabel(r)} ${r.stderr.slice(0, 200)}`.trim();
        return { ok: false, error, kind: classify(error, "empty"), capture: r };
      }

      const stats = j?.stats as Record<string, unknown> | undefined;
      const usage: Usage = {};
      if (typeof stats?.total_tokens === "number") usage.tokens = stats.total_tokens;
      if (typeof stats?.tool_calls === "number") usage.toolCalls = stats.tool_calls;

      const err = j?.error as Record<string, unknown> | undefined;
      const text = String(j?.response ?? "").trim();
      if (r.code === 0 && !err && text) return { ok: true, text, usage, capture: r };

      const error = String(err?.message ?? "") || `${exitLabel(r)} ${r.stderr.slice(0, 200)}`.trim();
      // 53 = turn limit exceeded: the model stopped early, not a transport failure.
      const kind = r.code === 53 ? "other" : classify(error, text ? "other" : "empty");
      return { ok: false, error, kind, usage, capture: r };
    },
  };
}

export const geminiProvider: ProviderDef = {
  key: "gemini",
  label: "Gemini CLI",
  vendor: "google",
  defaultBin: "gemini",
  versionArgs: ["--version"],
  caps: { execute: true, web: true, reportsCost: false },
  install: "npm install -g @google/gemini-cli   (retired for consumer tiers — prefer agy)",
  deprecated: "retired for consumer tiers on 2026-06-18; replaced by Antigravity CLI (agy)",
  make: makeGemini,
};
