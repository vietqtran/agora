// In-process runtime that spawns nothing.
//
// It exists so the debate engine is testable and demonstrable on a machine with no
// agent CLI installed or authenticated at all — which is also the state of most CI
// runners and of a fresh server before setup. `agora debate --dry-run` casts the whole
// lineup to mocks, so you can see the full protocol, the cross-examination wiring and
// the artifacts for free before spending a single token.

import type { Agent, AgentOutcome, ProviderDef, ProviderSpec } from "./types.ts";

/** Which phase a prompt belongs to, recovered from the phase marker the engine emits. */
export function phaseOf(prompt: string): string {
  const m = prompt.match(/\[AGORA-PHASE:([a-z-]+)\]/);
  return m ? m[1] : "unknown";
}

/** The role id the engine stamped into the prompt. */
export function roleOf(prompt: string): string {
  const m = prompt.match(/\[AGORA-ROLE:([a-z0-9_-]+)\]/);
  return m ? m[1] : "unknown";
}

/** The addressable peers the engine stamped into the prompt. */
export function peersOf(prompt: string): string[] {
  const m = prompt.match(/\[AGORA-PEERS:([a-z0-9_,-]*)\]/);
  return m && m[1] ? m[1].split(",").filter(Boolean) : [];
}

function canned(prompt: string, label: string): string {
  const phase = phaseOf(prompt);
  const role = roleOf(prompt);
  // Address a real peer so the cross-examination router has something to route.
  const target = peersOf(prompt).find((p) => p !== role) ?? "judge";

  if (phase === "opening") {
    return [
      `## Quan điểm của ${label} (${role})`,
      ``,
      `- Nhận định 1 từ góc nhìn ${role}.`,
      `- Nhận định 2, có đánh đổi rõ ràng.`,
      ``,
      `QUESTIONS`,
      `@${target}: Giả định cốt lõi của bạn có đứng vững khi quy mô tăng 10x không?`,
    ].join("\n");
  }
  if (phase === "cross-exam") {
    return [
      `## Phản biện của ${label}`,
      ``,
      `**Đồng ý:** điểm chính đã được chứng minh.`,
      `**Không đồng ý:** chi phí vận hành bị đánh giá thấp.`,
      ``,
      `QUESTIONS`,
      `@${target}: Bạn định đo lường điều đó bằng chỉ số nào?`,
    ].join("\n");
  }
  if (phase === "verdict") {
    return [
      `STATUS: RESOLVED`,
      ``,
      `## Đã thống nhất`,
      `- Phạm vi giai đoạn 1 được chốt.`,
      ``,
      `## Phán quyết từng điểm`,
      `- Điểm tranh chấp A: chọn phương án của ${label}.`,
    ].join("\n");
  }
  if (phase === "synthesis") {
    return [`# Hồ sơ nghiên cứu (mock)`, ``, `## Bối cảnh`, `...`, ``, `## Hạng mục chức năng`, `1. ...`].join("\n");
  }
  return `(mock ${label}: phase=${phase})`;
}

function make(spec: ProviderSpec): Agent {
  const label = spec.label ?? `Mock${spec.id ? ` ${spec.id}` : ""}`;
  return {
    provider: spec.id ?? "mock",
    label,
    vendor: spec.vendor ?? "mock",
    bin: "(in-process)",
    caps: { execute: false, web: false, reportsCost: false },
    async run(prompt): Promise<AgentOutcome> {
      // A fixed reply keyed on the prompt lets a test assert on exact text; `script`
      // overrides it per phase so a test can also force a failure path.
      const scripted = spec.script?.[phaseOf(prompt)];
      if (scripted === "__FAIL__") return { ok: false, error: "scripted failure", kind: "other" };
      return { ok: true, text: scripted ?? canned(prompt, label) };
    },
  };
}

export const mockProvider: ProviderDef = {
  key: "mock",
  label: "Mock (in-process)",
  vendor: "mock",
  defaultBin: "",
  versionArgs: [],
  caps: { execute: false, web: false, reportsCost: false },
  install: "built in — no install needed",
  make,
};
