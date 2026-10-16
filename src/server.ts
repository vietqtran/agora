// HTTP API + live event stream for the browser UI.
//
// node:http and Server-Sent Events only — no framework, no websocket library. SSE is
// the right fit and not a compromise: the stream is one-directional (server → browser),
// it survives proxies that mangle websockets, and the browser reconnects on its own.
//
// SECURITY, stated plainly because this surface is unusually sharp: anyone who can reach
// this port can spend the operator's model quota and make the server read local files as
// debate material. So the default bind is 127.0.0.1, and binding anywhere else REQUIRES
// a token. That is enforced here rather than left to documentation, because the
// interesting machines to run this on are exactly the ones with a public IP.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgoraConfig } from "./config.ts";
import type { AvailableProvider } from "./casting.ts";
import type { Role } from "./roles.ts";
import type { Presence } from "./detect.ts";
import { materialFromText, type TextMaterial } from "./material.ts";
import { RunManager, type StampedEvent } from "./runner.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Cap request bodies: pasted material is the big one, and 8 MB is generous for text. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Only these names are served out of a run directory. */
const ARTIFACTS = new Set(["dossier.md", "transcript.md", "verdict.md", "run.json"]);

export type ServerDeps = {
  config: AgoraConfig;
  roles: Map<string, Role>;
  /** Re-probed on each /api/state hit so installing a CLI shows up without a restart. */
  discover: () => Promise<Presence[]>;
  toAvailable: (p: Presence[]) => AvailableProvider[];
  runs: RunManager;
};

export type ServeOptions = {
  port: number;
  host: string;
  /** Required for any non-loopback bind; generated if the operator did not supply one. */
  token?: string;
};

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/**
 * Decide the token policy for a bind. Returning a token for a loopback bind would be
 * security theatre; refusing to generate one for a public bind would push the operator
 * toward `--token ""`.
 */
export function resolveToken(opts: ServeOptions): { token?: string; generated: boolean } {
  if (opts.token) return { token: opts.token, generated: false };
  if (isLoopback(opts.host)) return { generated: false };
  return { token: randomBytes(24).toString("base64url"), generated: true };
}

/** Constant-time compare, length-safe. */
function tokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function presentedToken(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  // EventSource cannot set headers, so SSE has to be able to pass it in the query.
  return url.searchParams.get("token") ?? undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    // This API is same-origin only; no browser should be able to call it from a page
    // the operator did not open themselves.
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error(`body quá lớn (> ${MAX_BODY_BYTES} bytes)`);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Shape the UI needs to render the setup form. */
async function statepayload(deps: ServerDeps) {
  const presences = await deps.discover();
  const available = deps.toAvailable(presences);
  const seen = new Set(presences.map((p) => p.provider));

  // Discovered runtimes carry diagnostic detail (version, shadowed installs, retirement
  // notices); DECLARED ones — the `custom` entries in the config — are never probed, so
  // they appear nowhere in `presences`. Listing only the probed ones left the UI's
  // runtime picker empty on exactly the machines that rely on custom CLIs, which is the
  // flexibility this project exists for. Merge both, keyed by provider.
  const providers = [
    ...presences.map((p) => ({
      key: p.provider,
      label: p.label,
      vendor: p.vendor,
      available: p.available,
      version: p.version ?? null,
      detail: p.detail,
      deprecated: p.deprecated ?? null,
      declared: false,
    })),
    ...available
      .filter((a) => !seen.has(a.key))
      .map((a) => ({
        key: a.key,
        label: a.label,
        vendor: a.vendor,
        available: true,
        version: null,
        detail: "khai báo trong cấu hình",
        deprecated: a.deprecated ?? null,
        declared: true,
      })),
  ];

  return {
    providers,
    availableKeys: available.map((a) => a.key),
    roles: [...deps.roles.values()].map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      summary: r.summary,
      prefer: r.prefer,
      needs: r.needs,
      wants: r.wants,
    })),
    defaults: {
      roles: deps.config.roles,
      judge: deps.config.judge,
      rounds: deps.config.rounds,
      language: deps.config.language,
      maxQuestions: deps.config.maxQuestions,
      timeoutMinutes: deps.config.timeoutMinutes,
    },
  };
}

type StartBody = {
  topic?: unknown;
  roles?: unknown;
  judge?: unknown;
  rounds?: unknown;
  language?: unknown;
  repoPath?: unknown;
  skipSynthesis?: unknown;
  seats?: unknown;
  material?: unknown;
};

/** Validate the browser's run request. Every message here is shown in the UI. */
export function parseStartBody(body: StartBody, roles: Map<string, Role>) {
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (!topic) throw new Error("thiếu chủ đề");

  const roleIds = Array.isArray(body.roles) ? body.roles.filter((r): r is string => typeof r === "string") : [];
  if (roleIds.length === 0) throw new Error("chọn ít nhất một vai");
  const missing = roleIds.filter((id) => !roles.has(id));
  if (missing.length) throw new Error(`vai không tồn tại: ${missing.join(", ")}`);

  const judgeId = typeof body.judge === "string" && body.judge ? body.judge : null;
  if (judgeId && !roles.has(judgeId)) throw new Error(`vai chủ tọa không tồn tại: ${judgeId}`);

  const rounds = Number(body.rounds ?? 1);
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 6) {
    // Capped deliberately: cost grows with rounds × seats, and a typo in a browser
    // field should not be able to launch a thirty-turn debate.
    throw new Error("số vòng phải là số nguyên từ 0 đến 6");
  }

  const seatOptions: Record<string, { provider?: string; model?: string; effort?: string }> = {};
  if (body.seats && typeof body.seats === "object") {
    for (const [roleId, raw] of Object.entries(body.seats as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const pick: { provider?: string; model?: string; effort?: string } = {};
      if (typeof o.provider === "string" && o.provider) pick.provider = o.provider;
      if (typeof o.model === "string" && o.model.trim()) pick.model = o.model.trim();
      if (typeof o.effort === "string" && o.effort) pick.effort = o.effort;
      seatOptions[roleId] = pick;
    }
  }

  const materialEntries: TextMaterial[] = [];
  if (Array.isArray(body.material)) {
    for (const raw of body.material) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const text = typeof m.text === "string" ? m.text : "";
      if (!text.trim()) continue;
      const role = typeof m.role === "string" && m.role ? m.role : undefined;
      if (role && !roles.has(role)) throw new Error(`tư liệu gán cho vai không tồn tại: ${role}`);
      materialEntries.push({
        ...(role && { role }),
        label: typeof m.label === "string" && m.label.trim() ? m.label.trim() : "tư liệu dán vào",
        text,
      });
    }
  }

  return {
    topic,
    roleIds,
    judgeId,
    rounds,
    language: typeof body.language === "string" && body.language ? body.language : "vi",
    repoPath: typeof body.repoPath === "string" && body.repoPath.trim() ? body.repoPath.trim() : undefined,
    skipSynthesis: body.skipSynthesis === true,
    seatOptions,
    materialEntries,
  };
}

function sse(res: ServerResponse): (event: string, data: unknown) => void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    // Nginx buffers event-streams by default, which turns a live view into a view that
    // updates once at the end.
    "x-accel-buffering": "no",
  });
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

export function createApp(deps: ServerDeps, token?: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    try {
      // The UI shell itself is unauthenticated on purpose: it is an empty page until it
      // can call the API, and gating it would mean the operator cannot even see where
      // to type the token.
      if (path === "/" || path === "/index.html") {
        const html = await readFile(join(HERE, "ui", "app.html"), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }
      if (path === "/api/ping") {
        json(res, 200, { ok: true, needsToken: Boolean(token) });
        return;
      }

      if (token && !tokenMatches(token, presentedToken(req, url))) {
        json(res, 401, { error: "token không hợp lệ" });
        return;
      }

      if (path === "/api/state" && req.method === "GET") {
        json(res, 200, await statepayload(deps));
        return;
      }

      if (path === "/api/runs" && req.method === "GET") {
        json(res, 200, { runs: deps.runs.list().map(summary) });
        return;
      }

      if (path === "/api/runs" && req.method === "POST") {
        const parsed = parseStartBody((await readBody(req)) as StartBody, deps.roles);
        const presences = await deps.discover();
        const available = deps.toAvailable(presences);
        if (available.length === 0) throw new Error("không có agent CLI nào khả dụng trên máy này");

        const warnings: string[] = [];
        const material = materialFromText(parsed.materialEntries, { warn: (m) => warnings.push(m) });

        const view = deps.runs.start({
          topic: parsed.topic,
          roles: parsed.roleIds.map((id) => deps.roles.get(id)!),
          ...(parsed.judgeId && { judgeRole: deps.roles.get(parsed.judgeId)! }),
          available,
          config: deps.config,
          seatOptions: parsed.seatOptions,
          ...(material && { material }),
          rounds: parsed.rounds,
          language: parsed.language,
          ...(parsed.repoPath && { repoPath: parsed.repoPath }),
          ...(parsed.skipSynthesis && { skipSynthesis: true }),
        });
        json(res, 201, { id: view.id, cast: view.cast, warnings });
        return;
      }

      const runMatch = path.match(/^\/api\/runs\/([A-Za-z0-9_-]+)(\/events|\/artifact)?$/);
      if (runMatch) {
        const [, id, suffix] = runMatch;
        const view = deps.runs.get(id);
        if (!view) {
          json(res, 404, { error: "không tìm thấy phiên" });
          return;
        }

        if (suffix === "/events") {
          const send = sse(res);
          // Heartbeat so an idle proxy does not drop the stream between slow turns —
          // a single agent turn can legitimately take minutes with nothing to report.
          const beat = setInterval(() => res.write(": keepalive\n\n"), 20_000);
          let closed = false;
          let stop: (() => void) | undefined;

          const finish = () => {
            if (closed) return;
            closed = true;
            clearInterval(beat);
            stop?.();
            const final = deps.runs.get(id);
            // The terminal event carries the settled summary, so the browser does not
            // need a follow-up request to learn how the run ended.
            if (final) send("final", summary(final));
            res.end();
          };

          req.on("close", () => {
            closed = true;
            clearInterval(beat);
            stop?.();
          });

          // `subscribe` replays the buffer first, so a browser that connects after the
          // POST still sees the opening phase — and calls `finish` immediately when the
          // run had already settled.
          stop = deps.runs.subscribe(id, (e: StampedEvent) => send("debate", e), finish);
          return;
        }

        if (suffix === "/artifact") {
          const name = url.searchParams.get("name") ?? "dossier.md";
          if (!ARTIFACTS.has(name)) {
            json(res, 400, { error: `tên file không hợp lệ (cho phép: ${[...ARTIFACTS].join(", ")})` });
            return;
          }
          if (!view.dir) {
            json(res, 409, { error: "phiên chưa ghi kết quả" });
            return;
          }
          // Belt and braces: the name is allowlisted above, and the resolved path must
          // still sit inside the run's own directory.
          const file = resolve(view.dir, name);
          if (!file.startsWith(resolve(view.dir))) {
            json(res, 400, { error: "đường dẫn không hợp lệ" });
            return;
          }
          const body = await readFile(file, "utf8");
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
          return;
        }

        json(res, 200, { run: { ...summary(view), events: view.events } });
        return;
      }

      json(res, 404, { error: "không có route này" });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      // A validation failure is the user's typo, not a server fault; anything else is ours.
      const status = /thiếu|không hợp lệ|không tồn tại|chọn ít nhất|phải là|quá lớn|JSON/.test(msg) ? 400 : 500;
      json(res, status, { error: msg });
    }
  };
}

/** Run view without the (potentially large) event buffer. */
function summary(v: ReturnType<RunManager["get"]> & object) {
  const { events, ...rest } = v;
  return { ...rest, eventCount: events.length };
}

export type RunningServer = { url: string; token?: string; close: () => Promise<void> };

export function serve(deps: ServerDeps, opts: ServeOptions): Promise<RunningServer> {
  const { token } = resolveToken(opts);
  const server = createServer((req, res) => {
    void createApp(deps, token)(req, res);
  });
  return new Promise((ok, err) => {
    server.once("error", err);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      ok({
        url: `http://${isLoopback(opts.host) ? "127.0.0.1" : opts.host}:${port}`,
        ...(token && { token }),
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
