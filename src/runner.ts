// Run manager: owns in-flight debates and their event streams.
//
// The hard requirement that shapes this module: a browser POSTs to start a run, then
// opens the event stream as a SECOND request. Those two cannot be simultaneous, so any
// event emitted in between would be lost — and the first thing a debate emits is the
// opening phase, i.e. exactly the part the user wanted to watch. So every event is
// BUFFERED per run and replayed to each new subscriber from the start. The stream is a
// log you can join late, not a firehose you must already be holding.

import { cast, type AvailableProvider, type CastResult } from "./casting.ts";
import { specFor, type AgoraConfig } from "./config.ts";
import { runDebate, type DebateEvent, type DebateResult, type Material, type Seat } from "./debate.ts";
import { buildAgent } from "./providers/registry.ts";
import type { Role } from "./roles.ts";
import { createRunDir, writeRun, type RunPaths } from "./store.ts";
import { summarizeCost } from "./transcript.ts";

export type RunStatus = "running" | "done" | "failed";

/** Everything the UI needs about one run, without reading the filesystem. */
export type RunView = {
  id: string;
  status: RunStatus;
  topic: string;
  startedAt: string;
  finishedAt?: string;
  cast: CastResult;
  /** Monotonic; a subscriber replays from 0 and then follows. */
  events: StampedEvent[];
  dir?: string;
  verdictStatus?: string | null;
  dossier?: string | null;
  aborted?: string | null;
  error?: string;
  cost?: ReturnType<typeof summarizeCost>;
};

export type StampedEvent = DebateEvent & { seq: number; at: number };

type Subscriber = (e: StampedEvent) => void;

type RunRecord = {
  view: RunView;
  subscribers: Set<Subscriber>;
  /**
   * Called once the run has SETTLED. Needed as its own signal, not inferable from the
   * events: `status` flips to done/failed only after the last event has already been
   * delivered, so a subscriber watching the event flow alone can never tell that the
   * flow has ended — it just waits forever on a stream nobody will write to again.
   */
  settleListeners: Set<() => void>;
  /** Resolves when the run settles, so a caller can await a run if it wants to. */
  finished: Promise<void>;
};

export type StartRequest = {
  topic: string;
  roles: Role[];
  judgeRole?: Role;
  available: AvailableProvider[];
  config: AgoraConfig;
  /** roleId → provider pin, model and effort chosen in the UI. */
  seatOptions: Record<string, { provider?: string; model?: string; effort?: string }>;
  material?: Material;
  rounds: number;
  language: string;
  repoPath?: string;
  skipSynthesis?: boolean;
};

/** Keep this many finished runs addressable; older ones are on disk anyway. */
export const MAX_RETAINED_RUNS = 40;

export class RunManager {
  private runs = new Map<string, RunRecord>();
  private counter = 0;
  // A plain field, not a constructor parameter property: this project runs TypeScript
  // through Node's strip-only mode, which can erase types but cannot EMIT the implicit
  // assignment a parameter property needs. tsconfig has erasableSyntaxOnly on so the
  // typechecker catches that class of mistake instead of the test run.
  private readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  list(): RunView[] {
    // Newest first: a UI list is read top-down, and the newest run is the one being watched.
    return [...this.runs.values()].map((r) => r.view).reverse();
  }

  get(id: string): RunView | undefined {
    return this.runs.get(id)?.view;
  }

  /**
   * Replay the buffer, then follow. `onSettled` fires exactly once, including for a run
   * that had already finished before this call. Returns an unsubscribe function, or
   * undefined when the id is unknown.
   */
  subscribe(id: string, fn: Subscriber, onSettled?: () => void): (() => void) | undefined {
    const rec = this.runs.get(id);
    if (!rec) return undefined;
    // No await between the replay and the registration below, so no event can slip
    // through the gap.
    for (const e of rec.view.events) fn(e);
    if (rec.view.status !== "running") {
      onSettled?.();
      return () => {};
    }
    rec.subscribers.add(fn);
    if (onSettled) rec.settleListeners.add(onSettled);
    return () => {
      rec.subscribers.delete(fn);
      if (onSettled) rec.settleListeners.delete(onSettled);
    };
  }

  /**
   * Cast the lineup and start the debate. Returns as soon as the run is REGISTERED, not
   * when it finishes — the browser needs the id immediately so it can open the stream.
   */
  start(req: StartRequest): RunView {
    const id = `r${Date.now().toString(36)}-${(++this.counter).toString(36)}`;
    const pins: Record<string, string> = {};
    for (const [roleId, opt] of Object.entries(req.seatOptions)) {
      if (opt.provider) pins[roleId] = opt.provider;
    }

    const castResult = cast({
      roles: req.roles,
      ...(req.judgeRole && { judgeRole: req.judgeRole }),
      available: req.available,
      pins: { ...req.config.cast, ...pins },
      allowShared: req.config.allowShared,
    });

    const view: RunView = {
      id,
      status: "running",
      topic: req.topic,
      startedAt: new Date().toISOString(),
      cast: castResult,
      events: [],
    };

    const rec: RunRecord = { view, subscribers: new Set(), settleListeners: new Set(), finished: Promise.resolve() };
    this.runs.set(id, rec);
    this.evict();

    const emit = (e: DebateEvent) => {
      const stamped: StampedEvent = { ...e, seq: view.events.length, at: Date.now() };
      view.events.push(stamped);
      for (const fn of rec.subscribers) {
        try {
          fn(stamped);
        } catch {
          // A broken client socket must never take down the debate that is paying for tokens.
        }
      }
    };

    rec.finished = this.execute(req, view, castResult, emit)
      .catch((e) => {
        view.status = "failed";
        view.error = String((e as Error).message ?? e);
        view.finishedAt = new Date().toISOString();
        emit({ type: "warn", message: `phiên lỗi: ${view.error}` });
      })
      .finally(() => {
        // After `view` is final, so a listener reading it sees the settled state.
        for (const fn of rec.settleListeners) {
          try {
            fn();
          } catch {
            // A broken client must not turn a finished debate into an unhandled rejection.
          }
        }
        rec.settleListeners.clear();
      });

    return view;
  }

  private async execute(
    req: StartRequest,
    view: RunView,
    castResult: CastResult,
    emit: (e: DebateEvent) => void,
  ): Promise<void> {
    if (castResult.debaters.length === 0) {
      throw new Error("không phân được vai nào cho các runtime hiện có");
    }
    for (const w of castResult.warnings) emit({ type: "warn", message: w });

    const byId = new Map(req.roles.map((r) => [r.id, r]));
    if (req.judgeRole) byId.set(req.judgeRole.id, req.judgeRole);

    const toSeat = (b: (typeof castResult.debaters)[number]): Seat => {
      const role = byId.get(b.roleId);
      if (!role) throw new Error(`vai "${b.roleId}" không tồn tại`);
      const opt = req.seatOptions[b.roleId] ?? {};
      const spec = specFor(req.config, b.provider, b.roleId, b.grants, b.bin);
      // UI choices win over config: the point of the picker is to override per run
      // without editing a file. An empty string means "leave the default alone".
      if (opt.model) spec.model = opt.model;
      if (opt.effort) spec.effort = opt.effort;
      return { role, binding: b, agent: buildAgent(spec) };
    };

    const seats = castResult.debaters.map(toSeat);
    const judgeSeat = castResult.judge ? toSeat(castResult.judge) : undefined;

    const result: DebateResult = await runDebate({
      topic: req.topic,
      ...(req.material && { material: req.material }),
      seats,
      ...(judgeSeat && { judge: judgeSeat }),
      rounds: req.rounds,
      language: req.language,
      maxQuestions: req.config.maxQuestions,
      ...(req.repoPath && { repoPath: req.repoPath }),
      ...(req.skipSynthesis && { skipSynthesis: req.skipSynthesis }),
      onEvent: emit,
    });

    const paths: RunPaths = await createRunDir(req.config.outDir, req.topic, this.cwd);
    await writeRun(paths, result, {
      topic: req.topic,
      startedAt: view.startedAt,
      finishedAt: new Date().toISOString(),
      language: req.language,
      rounds: req.rounds,
      cast: [...castResult.debaters, ...(castResult.judge ? [castResult.judge] : [])],
      warnings: castResult.warnings,
      ...(req.repoPath && { repoPath: req.repoPath }),
      ...(req.material?.sources && { privateMaterial: req.material.sources }),
    });

    view.dir = paths.dir;
    view.verdictStatus = result.verdict?.status ?? null;
    view.dossier = result.dossier ?? null;
    view.aborted = result.aborted ?? null;
    view.cost = summarizeCost(result.turns);
    view.finishedAt = new Date().toISOString();
    // An aborted debate is a legitimate outcome the UI must show in red, not a crash.
    view.status = result.aborted ? "failed" : "done";
  }

  /** Drop the oldest finished runs. Never evicts a run that is still going. */
  private evict(): void {
    if (this.runs.size <= MAX_RETAINED_RUNS) return;
    for (const [id, rec] of this.runs) {
      if (this.runs.size <= MAX_RETAINED_RUNS) break;
      if (rec.view.status === "running") continue;
      this.runs.delete(id);
    }
  }
}
