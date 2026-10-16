// Run artifacts on disk.
//
// Every run writes a self-contained directory. The dossier is the thing you read; the
// transcript is the thing you check when the dossier says something surprising; and
// run.json is what makes a run comparable to the next one (which lineup, what it cost,
// which turns failed). Separate files on purpose — the dossier gets pasted into a spec
// or a ticket, and nobody wants 40KB of debate pasted along with it.

import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { DebateResult } from "./debate.ts";
import type { Binding } from "./casting.ts";
import { summarizeCost, turnTitle } from "./transcript.ts";

/** Diacritic-safe slug: "Quản lý khối lượng" → "quan-ly-khoi-luong". */
export function slugify(text: string, maxLen = 48): string {
  const stripped = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining marks
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
  const slug = stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "debate").slice(0, maxLen).replace(/-+$/g, "");
}

/** Sortable, filename-safe local timestamp: 2026-10-16T14-32-05. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export type RunPaths = {
  dir: string;
  transcript: string;
  dossier: string;
  verdict: string;
  meta: string;
};

export async function createRunDir(outDir: string, topic: string, cwd = process.cwd()): Promise<RunPaths> {
  const base = isAbsolute(outDir) ? outDir : join(cwd, outDir);
  const dir = join(base, `${stamp()}-${slugify(topic)}`);
  await mkdir(dir, { recursive: true });
  return {
    dir,
    transcript: join(dir, "transcript.md"),
    dossier: join(dir, "dossier.md"),
    verdict: join(dir, "verdict.md"),
    meta: join(dir, "run.json"),
  };
}

export type RunMeta = {
  topic: string;
  startedAt: string;
  finishedAt: string;
  language: string;
  rounds: number;
  cast: Binding[];
  warnings: string[];
  repoPath?: string;
};

/** Write every artifact the run produced. Returns the files actually written. */
export async function writeRun(paths: RunPaths, result: DebateResult, meta: RunMeta): Promise<string[]> {
  const written: string[] = [];
  const put = async (path: string, body: string) => {
    await writeFile(path, body.endsWith("\n") ? body : `${body}\n`, "utf8");
    written.push(path);
  };

  await put(paths.transcript, result.transcript);
  if (result.verdict) await put(paths.verdict, result.verdict.text);
  if (result.dossier) await put(paths.dossier, result.dossier);

  const cost = summarizeCost(result.turns);
  await put(
    paths.meta,
    JSON.stringify(
      {
        ...meta,
        verdictStatus: result.verdict?.status ?? null,
        aborted: result.aborted ?? null,
        cost,
        questions: result.questionLog,
        turns: result.turns.map((t) => ({
          title: turnTitle(t),
          phase: t.phase,
          round: t.round ?? null,
          role: t.roleId,
          provider: t.provider,
          shared: t.shared,
          ok: t.outcome.ok,
          kind: t.outcome.ok ? null : t.outcome.kind,
          error: t.outcome.ok ? null : t.outcome.error,
          costUsd: t.outcome.costUsd ?? null,
          usage: t.outcome.usage ?? null,
          promptBytes: t.promptBytes,
          agentMs: Math.round(t.agentMs),
          turnMs: Math.round(t.turnMs),
          questionsAsked: t.questions.length,
        })),
      },
      null,
      2,
    ),
  );
  return written;
}
