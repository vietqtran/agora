import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunDir, writeRun, slugify, type RunMeta } from "../src/store.ts";
import type { DebateResult } from "../src/debate.ts";
import type { Turn } from "../src/transcript.ts";

const base = {
  phase: "opening" as const,
  roleId: "architect",
  roleName: "Kiến trúc sư",
  provider: "claude",
  providerLabel: "Claude Code",
  shared: false,
  promptBytes: 100,
  agentMs: 1000,
  turnMs: 1100,
  questions: [],
  unrouted: [],
};

const meta: RunMeta = {
  topic: "Chủ đề thử",
  startedAt: "2026-10-19T00:00:00.000Z",
  finishedAt: "2026-10-19T00:05:00.000Z",
  language: "vi",
  rounds: 1,
  cast: [],
  warnings: [],
};

test("run.json records WHICH guarantees a turn ran without", async () => {
  // run.json is what makes two runs comparable. A turn that lost its sandbox or its
  // context isolation is not comparable to one that did not, so the note has to be a
  // field rather than something a reader has to notice in the markdown.
  const note = "lượt này chạy KHÔNG sandbox: không thấy backend sandbox nào";
  const turns: Turn[] = [
    {
      ...base,
      outcome: {
        ok: true,
        text: "ý kiến",
        capture: { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ms: 5, notes: [note] },
      },
    },
    { ...base, roleId: "researcher", outcome: { ok: true, text: "ý kiến khác" } },
  ];
  const result: DebateResult = { turns, transcript: "# biên bản", questionLog: [] };

  const paths = await createRunDir(await mkdtemp(join(tmpdir(), "agora-store-")), meta.topic);
  const written = await writeRun(paths, result, meta);
  assert.ok(written.includes(paths.meta));

  const json = JSON.parse(await readFile(paths.meta, "utf8"));
  assert.deepEqual(json.turns[0].notes, [note]);
  // Empty array, not null or missing: this run WAS checked and had nothing to report.
  assert.deepEqual(json.turns[1].notes, []);
  assert.equal(json.cost.degradedTurns, 1);
});

test("slugify keeps Vietnamese topics readable as directory names", () => {
  assert.equal(slugify("Quản lý khối lượng"), "quan-ly-khoi-luong");
  assert.equal(slugify("Đấu thầu & hợp đồng"), "dau-thau-hop-dong");
  assert.equal(slugify("   "), "debate");
});
