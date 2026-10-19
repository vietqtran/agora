// Two views of the same debate, and they must stay different.
//
// The ARTIFACT view is for the human and the audit trail: it keeps costs, timings,
// failure reasons and the routed-question log, because a transcript that hides what a
// run cost or which turn died is not a record, it is marketing.
//
// The CONTEXT view is what gets fed back into the next agent's prompt: no cost
// footnotes, no raw stderr dumps, no bookkeeping. Those tokens cost money on every
// subsequent turn and, worse, invite the model to start reasoning about the
// orchestrator's plumbing instead of the topic.

import { outcomeNotes, type AgentOutcome } from "./providers/types.ts";
import type { Question } from "./crossexam.ts";
import type { Phase } from "./prompts.ts";

export type Turn = {
  phase: Phase;
  roleId: string;
  roleName: string;
  provider: string;
  providerLabel: string;
  /** Whether this runtime also played another role — a caveat the reader needs. */
  shared: boolean;
  round?: number;
  outcome: AgentOutcome;
  promptBytes: number;
  /** The agent call alone. */
  agentMs: number;
  /** Agent call plus isolation setup/teardown, so overhead stays visible separately. */
  turnMs: number;
  questions: Question[];
  unrouted: Question[];
};

export function turnTitle(t: Turn): string {
  const who = `${t.roleName} · ${t.providerLabel}`;
  if (t.phase === "opening") return `Mở đầu — ${who}`;
  if (t.phase === "cross-exam") return `Chất vấn vòng ${t.round ?? 1} — ${who}`;
  if (t.phase === "verdict") return `Phán quyết — ${who}`;
  return `Hồ sơ tổng hợp — ${who}`;
}

function fmtMs(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} phút` : `${Math.round(ms / 1000)}s`;
}

/** Footer of measurable facts about the turn. Cheap to produce, impossible to guess later. */
function meta(t: Turn): string {
  const bits = [`${fmtMs(t.agentMs)}`];
  if (t.shared) bits.push("runtime dùng chung");
  const o = t.outcome;
  if (o.costUsd !== undefined) bits.push(`$${o.costUsd.toFixed(4)}`);
  if (o.usage?.tokens !== undefined) bits.push(`${o.usage.tokens} tokens`);
  if (o.usage?.ranCommands) bits.push(`${o.usage.ranCommands} lệnh đã chạy`);
  else if (o.usage?.toolCalls) bits.push(`${o.usage.toolCalls} lần gọi tool`);
  return `_(${bits.join(" · ")})_`;
}

/**
 * Turns that ran weaker than advertised. In the ARTIFACT view only: a reader auditing a
 * claim needs to know the sandbox was off or the persona was contaminated, while the
 * next agent's prompt must not start reasoning about our flag handling.
 */
function notesBlock(t: Turn): string {
  const ns = outcomeNotes(t.outcome);
  return ns.length ? `${ns.map((n) => `> ⚠️ HẠ CẤP: ${n}`).join("\n>\n")}\n\n` : "";
}

/** Human/audit view. */
export function renderArtifact(t: Turn): string {
  const title = `## ${turnTitle(t)}`;
  if (!t.outcome.ok) {
    // A failed turn can still have spent money (a timeout kills mid-flight). Reporting
    // it is the difference between an honest cost total and a flattering one.
    const spent = t.outcome.costUsd ? ` _(đã tiêu trước khi lỗi: $${t.outcome.costUsd.toFixed(4)})_` : "";
    return `${title}\n\n${notesBlock(t)}> ⚠️ THẤT BẠI [${t.outcome.kind}]: ${t.outcome.error}${spent}\n`;
  }
  const unrouted = t.unrouted.length
    ? `\n> ℹ️ Đã hỏi vai không có trong phiên: ${t.unrouted.map((q) => `@${q.to}`).join(", ")}\n`
    : "";
  return `${title}\n\n${notesBlock(t)}${t.outcome.text}\n${unrouted}\n${meta(t)}\n`;
}

/** Prompt-context view: clean, cheap, no plumbing. */
export function renderContext(t: Turn): string {
  const title = `## ${turnTitle(t)}`;
  if (!t.outcome.ok) return `${title}\n\n> (chuyên gia này không đưa ra ý kiến ở lượt này)\n`;
  return `${title}\n\n${t.outcome.text}\n`;
}

export type CostSummary = {
  knownCostUsd: number;
  /** Turns whose runtime does not report dollars at all — unknown is not zero. */
  unpricedTurns: number;
  totalMs: number;
  failed: number;
  ok: number;
  /** Turns that ran without a guarantee this tool advertises. Belongs in every total. */
  degradedTurns: number;
};

export function summarizeCost(turns: readonly Turn[]): CostSummary {
  let knownCostUsd = 0;
  let unpricedTurns = 0;
  let totalMs = 0;
  let failed = 0;
  let ok = 0;
  let degradedTurns = 0;
  for (const t of turns) {
    totalMs += t.turnMs;
    if (t.outcome.ok) ok++;
    else failed++;
    if (t.outcome.costUsd !== undefined) knownCostUsd += t.outcome.costUsd;
    else unpricedTurns++;
    if (outcomeNotes(t.outcome).length) degradedTurns++;
  }
  return { knownCostUsd, unpricedTurns, totalMs, failed, ok, degradedTurns };
}

export function renderCostFooter(turns: readonly Turn[]): string {
  const s = summarizeCost(turns);
  const parts = [
    `${s.ok} lượt thành công`,
    ...(s.failed ? [`${s.failed} lượt thất bại`] : []),
    // A degraded turn reads exactly like a clean one in the answer text, so the count
    // goes in the footer next to the money rather than only beside the turn itself.
    ...(s.degradedTurns ? [`**${s.degradedTurns} lượt hạ cấp** (xem ⚠️ HẠ CẤP ở lượt tương ứng)`] : []),
    `tổng thời gian ${fmtMs(s.totalMs)}`,
    `chi phí đã biết $${s.knownCostUsd.toFixed(4)}`,
  ];
  // Say this plainly: a total that silently omits the CLIs which report tokens instead
  // of dollars would read as a complete figure, and it is not one.
  const caveat = s.unpricedTurns
    ? ` — ${s.unpricedTurns} lượt chạy trên CLI không báo giá bằng USD nên **không nằm trong con số trên**`
    : "";
  return `---\n\n_${parts.join(" · ")}${caveat}._\n`;
}
