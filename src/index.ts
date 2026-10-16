#!/usr/bin/env node
// Composition root: parse argv, resolve config, discover runtimes, cast roles, run.
//
// Channel discipline, deliberately: stdout carries the ARTIFACT (the dossier, or JSON
// with --json) and stderr carries PROGRESS. That is what makes `agora "..." > spec.md`
// work, and what lets this be driven by another agent without the progress chatter
// contaminating the output it parses.

import { readFile } from "node:fs/promises";
import { all, bool, HELP, num, one, parseArgs, pins, rounds as roundsFlag, type Parsed } from "./args.ts";
import { DEFAULTS, loadConfig, projectConfigPath, specFor, type AgoraConfig } from "./config.ts";
import { cast, type AvailableProvider, type Binding, type CastResult } from "./casting.ts";
import { canary, discover, installHint, type Presence } from "./detect.ts";
import { remedy } from "./providers/types.ts";
import { loadRoles, type Role } from "./roles.ts";
import { buildAgent, providerDef } from "./providers/registry.ts";
import { runDebate, type DebateEvent, type Seat } from "./debate.ts";
import { loadMaterial } from "./material.ts";
import { createRunDir, writeRun } from "./store.ts";
import { RunManager } from "./runner.ts";
import { isLoopback, resolveToken, serve } from "./server.ts";
import { summarizeCost } from "./transcript.ts";

const VERSION = "0.1.0";

// --- terminal helpers ---------------------------------------------------------------

const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

function log(msg = "") {
  process.stderr.write(`${msg}\n`);
}

function fmtSecs(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${Math.round(ms / 1000)}s`;
}

// --- shared setup -------------------------------------------------------------------

/** CLI flags beat config files; this is where that precedence is actually applied. */
function applyFlags(config: AgoraConfig, p: Parsed): AgoraConfig {
  const out = { ...config };
  const roles = one(p, "roles");
  if (roles) out.roles = roles.split(",").map((s) => s.trim()).filter(Boolean);
  const judge = one(p, "judge");
  if (judge) out.judge = judge === "none" || judge === "off" ? null : judge;
  const r = roundsFlag(p);
  if (r !== undefined) out.rounds = r;
  const timeout = num(p, "timeout");
  if (timeout !== undefined) out.timeoutMinutes = timeout;
  const lang = one(p, "lang");
  if (lang) out.language = lang;
  const outDir = one(p, "out");
  if (outDir) out.outDir = outDir;
  if (bool(p, "no-shared")) out.allowShared = false;
  out.cast = { ...out.cast, ...pins(p) };
  return out;
}

/** Discovered runtimes, as casting input. Custom runtimes are declared, not probed. */
function toAvailable(presences: Presence[], config: AgoraConfig): AvailableProvider[] {
  const out: AvailableProvider[] = [];
  for (const pr of presences) {
    if (!pr.available) continue;
    const def = providerDef(pr.provider);
    out.push({
      key: pr.provider,
      label: pr.label,
      vendor: pr.vendor,
      caps: def.caps,
      ...(pr.version && { version: pr.version }),
      ...(pr.bin && pr.bin !== def.defaultBin && { bin: pr.bin }),
      ...(pr.deprecated && { deprecated: pr.deprecated }),
    });
  }
  for (const spec of config.custom) {
    const key = spec.id ?? spec.command ?? "custom";
    out.push({
      key,
      label: spec.label ?? key,
      vendor: spec.vendor ?? key,
      // A custom runtime's powers are whatever the user declared; we cannot probe them.
      caps: { execute: spec.execute === true, web: spec.web === true, reportsCost: false },
    });
  }
  return out;
}

/**
 * Dry-run lineup: one distinct in-process runtime per seat, with distinct vendors so
 * the diversity rules behave exactly as they would against real CLIs. The point is to
 * exercise the real casting and debate code paths, not a special-cased simulation.
 */
function dryRunSetup(config: AgoraConfig, seats: number): { available: AvailableProvider[]; config: AgoraConfig } {
  const available: AvailableProvider[] = [];
  const custom = [...config.custom];
  for (let i = 1; i <= Math.max(seats, 1); i++) {
    const key = `mock-${i}`;
    available.push({ key, label: `Mock #${i}`, vendor: `mock-${i}`, caps: { execute: true, web: true, reportsCost: false } });
    custom.push({ provider: "mock", id: key, label: `Mock #${i}`, vendor: `mock-${i}` });
  }
  return { available, config: { ...config, custom } };
}

function resolveRoles(config: AgoraConfig, roles: Map<string, Role>): { debaters: Role[]; judge?: Role } {
  const missing = config.roles.filter((id) => !roles.has(id));
  if (missing.length) {
    throw new Error(
      `không tìm thấy vai: ${missing.join(", ")}\n` +
        `các vai có sẵn: ${[...roles.keys()].join(", ")}\n` +
        `(thêm vai mới bằng cách tạo file .md trong ./roles hoặc ~/.config/agora/roles)`,
    );
  }
  const debaters = config.roles.map((id) => roles.get(id)!);
  const judgeRole = config.judge ? roles.get(config.judge) : undefined;
  if (config.judge && !judgeRole) {
    throw new Error(`không tìm thấy vai chủ tọa "${config.judge}" (dùng --judge none để bỏ phán quyết)`);
  }
  return { debaters, ...(judgeRole && { judge: judgeRole }) };
}

function printCast(result: CastResult) {
  log(c.bold("\nPhân vai"));
  const rows = [...result.debaters, ...(result.judge ? [result.judge] : [])];
  const w = Math.max(...rows.map((b) => b.roleName.length), 10);
  for (const b of rows) {
    const flags = [b.grants.web ? "web" : "", b.grants.execute ? "shell" : ""].filter(Boolean).join("+");
    const mark = b.shared ? c.yellow("⚠") : c.green("✓");
    log(`  ${mark} ${b.roleName.padEnd(w)}  ${c.cyan(b.providerLabel)}${flags ? c.dim(` [${flags}]`) : ""}`);
    log(`    ${c.dim(b.reason)}`);
  }
  for (const u of result.unfilled) {
    log(`  ${c.red("✗")} ${u.roleName.padEnd(w)}  ${c.red("không phân được vai")}`);
    log(`    ${c.dim(u.reason)}`);
    for (const key of u.wanted.slice(0, 2)) {
      try {
        log(`    ${c.dim(`cài ${key}: ${installHint(key)}`)}`);
      } catch {
        /* an unknown provider name in a role's prefer list is not fatal here */
      }
    }
  }
  for (const w2 of result.warnings) log(`  ${c.yellow("⚠")} ${c.yellow(w2)}`);
}

// --- commands -----------------------------------------------------------------------

async function cmdDoctor(p: Parsed): Promise<number> {
  const { config, sources } = await loadConfig(one(p, "config"));
  const cfg = applyFlags(config, p);
  log(c.bold("agora doctor"));
  log(c.dim(`cấu hình: ${sources.join(" → ")}`));

  const pinnedBins: Record<string, string> = {};
  for (const [key, spec] of Object.entries(cfg.providers)) if (spec.bin) pinnedBins[key] = spec.bin;

  log(c.bold("\n1. Runtime có mặt trên máy này") + c.dim("  (dò --version, miễn phí)"));
  const presences = await discover(pinnedBins);
  for (const pr of presences) {
    const mark = pr.available ? c.green("✓") : c.red("✗");
    log(`  ${mark} ${pr.label.padEnd(18)} ${pr.available ? c.dim(pr.detail) : c.red(pr.detail)}`);
    if (pr.available && pr.bin !== providerDef(pr.provider).defaultBin) log(`      ${c.dim(`dùng: ${pr.bin}`)}`);
    if (pr.shadowed.length) log(`      ${c.yellow(`cũng tìm thấy: ${pr.shadowed.join(", ")}`)}`);
    if (pr.deprecated) log(`      ${c.yellow(`lưu ý: ${pr.deprecated}`)}`);
    if (!pr.available) log(`      ${c.dim(`cài: ${installHint(pr.provider)}`)}`);
  }

  const available = toAvailable(presences, cfg);
  if (available.length === 0) {
    log(c.red("\nKhông có runtime nào khả dụng. Cài ít nhất 2 CLI khác hãng để tranh luận có giá trị."));
    log(c.dim('Thử giao thức mà không tốn token: agora --dry-run "chủ đề của bạn"'));
    return 1;
  }

  const roles = await loadRoles();
  const { debaters, judge } = resolveRoles(cfg, roles);
  const result = cast({ roles: debaters, ...(judge && { judgeRole: judge }), available, pins: cfg.cast, allowShared: cfg.allowShared });
  printCast(result);

  if (!bool(p, "health")) {
    log(c.dim("\n(thêm --health để kiểm tra đăng nhập bằng một prompt thật, tốn ít token)"));
    return result.unfilled.length ? 1 : 0;
  }

  log(c.bold("\n2. Runtime có trả lời được không") + c.dim("  (prompt canary thật, cần đã đăng nhập)"));
  const seats = [...result.debaters, ...(result.judge ? [result.judge] : [])];
  // One canary per distinct (runtime, MODEL) pair — not merely per runtime. Roles pin
  // different models on the same CLI (a strong judge over mid-tier debaters), and a
  // model the account cannot use fails on its own. Deduping by runtime alone would
  // health-check whichever seat happened to be last and call the rest fine.
  const specs = new Map<string, ReturnType<typeof specFor>>();
  for (const b of seats) {
    const spec = specFor(cfg, b.provider, b.roleId, b.grants, b.bin);
    specs.set(`${b.provider}::${spec.model ?? "(mặc định)"}`, spec);
  }
  const healths = await Promise.all([...specs.values()].map((spec) => canary(spec)));
  let bad = 0;
  for (const h of healths) {
    const mark = h.ok ? c.green("✓") : c.red("✗");
    if (!h.ok) bad++;
    log(`  ${mark} ${h.label.padEnd(26)} ${c.dim(fmtSecs(h.ms).padStart(5))}  ${h.ok ? c.dim(h.detail) : c.red(h.detail)}`);
    if (!h.ok && h.kind) log(`      ${c.yellow("→ cách sửa: ")}${c.dim(remedy(h.kind, h.provider, h.bin))}`);
  }
  log(`\n${healths.length - bad}/${healths.length} runtime trả lời được — ${bad === 0 ? c.green("SẴN SÀNG") : c.red("CHƯA SẴN SÀNG")}`);
  return bad === 0 && result.unfilled.length === 0 ? 0 : 1;
}

async function cmdRoles(p: Parsed): Promise<number> {
  const roles = await loadRoles();
  const { config } = await loadConfig(one(p, "config"));
  log(c.bold(`Các vai chuyên gia (${roles.size})`));
  for (const role of roles.values()) {
    const active = config.roles.includes(role.id) || config.judge === role.id;
    log(`\n  ${active ? c.green("●") : c.dim("○")} ${c.bold(role.id)} ${c.dim(`— ${role.name}`)}`);
    if (role.summary) log(`    ${role.summary}`);
    log(
      c.dim(
        `    loại: ${role.kind} · ưu tiên: ${role.prefer.join(" > ") || "(không)"}` +
          `${role.needs.length ? ` · bắt buộc: ${role.needs.join(",")}` : ""}` +
          `${role.wants.length ? ` · mong muốn: ${role.wants.join(",")}` : ""}`,
      ),
    );
    log(c.dim(`    nguồn: ${role.source}`));
  }
  log(c.dim(`\n● = đang dùng theo cấu hình hiện tại. Thêm vai mới: tạo file .md trong ./roles`));
  return 0;
}

async function cmdInit(p: Parsed): Promise<number> {
  const path = projectConfigPath();
  const presences = await discover();
  const availableKeys = presences.filter((pr) => pr.available).map((pr) => pr.provider);

  const providers: AgoraConfig["providers"] = {};
  for (const pr of presences) {
    if (!pr.available) continue;
    const def = providerDef(pr.provider);
    const base = { ...(DEFAULTS.providers[pr.provider] ?? {}) };
    // Pin a binary ONLY when PATH did not resolve it: a pinned path is the thing that
    // makes a committed config unusable on the next machine.
    if (pr.bin && pr.bin !== def.defaultBin) base.bin = pr.bin;
    providers[pr.provider] = base;
  }

  const config = {
    language: DEFAULTS.language,
    rounds: DEFAULTS.rounds,
    timeoutMinutes: DEFAULTS.timeoutMinutes,
    roles: DEFAULTS.roles,
    judge: DEFAULTS.judge,
    providers,
    roleOptions: DEFAULTS.roleOptions,
    allowShared: DEFAULTS.allowShared,
  };

  const { writeFile, access, copyFile } = await import("node:fs/promises");
  if (!bool(p, "force")) {
    try {
      await access(path);
      await copyFile(path, `${path}.bak`);
      log(c.dim(`đã sao lưu cấu hình cũ → ${path}.bak`));
    } catch {
      /* nothing to back up */
    }
  }
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  log(`${c.green("✓")} đã ghi ${path}`);
  log(c.dim(`  runtime phát hiện được: ${availableKeys.join(", ") || "(không có)"}`));
  if (availableKeys.length < 2) {
    log(c.yellow(`  ⚠ cần ít nhất 2 CLI khác hãng để tranh luận thực sự độc lập`));
  }
  log(c.dim(`\nBước tiếp: agora doctor --health`));
  return 0;
}

async function cmdDebate(p: Parsed): Promise<number> {
  const { config: loaded, sources } = await loadConfig(one(p, "config"));
  let cfg = applyFlags(loaded, p);
  const quiet = bool(p, "quiet");
  const asJson = bool(p, "json");

  const file = one(p, "file");
  const topic = (file ? await readFile(file, "utf8") : p.rest.join(" ")).trim();
  if (!topic) {
    log(c.red("thiếu chủ đề.") + ` Ví dụ: agora "Phần mềm ERP xây dựng cần những module gì?"`);
    log(c.dim("hoặc: agora --file ./brief.md"));
    return 2;
  }

  const roles = await loadRoles();
  const { debaters, judge } = resolveRoles(cfg, roles);

  const dryRun = bool(p, "dry-run");
  let available: AvailableProvider[];
  if (dryRun) {
    const setup = dryRunSetup(cfg, debaters.length + (judge ? 1 : 0));
    available = setup.available;
    cfg = setup.config;
    log(c.yellow("chế độ --dry-run: dùng runtime giả, không gọi CLI thật, không tốn token"));
  } else {
    const pinnedBins: Record<string, string> = {};
    for (const [key, spec] of Object.entries(cfg.providers)) if (spec.bin) pinnedBins[key] = spec.bin;
    available = toAvailable(await discover(pinnedBins), cfg);
  }

  if (available.length === 0) {
    log(c.red("không tìm thấy agent CLI nào trên máy này."));
    log(c.dim(`chạy "agora doctor" để xem chi tiết, hoặc "agora --dry-run" để thử giao thức.`));
    return 1;
  }

  const castResult = cast({
    roles: debaters,
    ...(judge && { judgeRole: judge }),
    available,
    pins: cfg.cast,
    allowShared: cfg.allowShared,
  });
  if (!quiet) {
    log(c.dim(`cấu hình: ${sources.join(" → ")}`));
    printCast(castResult);
  }
  if (castResult.debaters.length === 0) {
    log(c.red("\nkhông phân được vai nào — không thể tranh luận."));
    return 1;
  }

  // Bind each seat to a built agent. The spec is resolved per ROLE, so two roles on the
  // same runtime can still differ in model, effort and granted capabilities.
  const toSeat = (b: Binding): Seat => {
    const role = roles.get(b.roleId)!;
    const spec = specFor(cfg, b.provider, b.roleId, b.grants, b.bin);
    return { role, binding: b, agent: buildAgent(spec) };
  };
  const seats = castResult.debaters.map(toSeat);
  const judgeSeat = castResult.judge ? toSeat(castResult.judge) : undefined;

  // Every role in THIS debate, judge included, can be addressed by a -m prefix.
  const addressable = new Set([...castResult.debaters.map((b) => b.roleId), ...(castResult.judge ? [castResult.judge.roleId] : [])]);
  const material = await loadMaterial(all(p, "material"), addressable, {
    ...(quiet ? {} : { warn: (m) => log(`${c.yellow("⚠")} ${c.yellow(m)}`), info: (m) => log(c.dim(`    ${m}`)) }),
  });
  const repoPath = one(p, "repo");

  const onEvent = (e: DebateEvent) => {
    if (quiet) return;
    if (e.type === "phase") {
      const label = { opening: "Mở đầu", "cross-exam": `Chất vấn vòng ${e.round}`, verdict: "Phán quyết", synthesis: "Tổng hợp" }[e.phase];
      log(`\n${c.bold(`▸ ${label}`)} ${c.dim(e.detail)}`);
    } else if (e.type === "turn-start") {
      log(c.dim(`  … ${e.label}`));
    } else if (e.type === "turn-end") {
      const mark = e.ok ? c.green("✓") : c.red("✗");
      log(`  ${mark} ${e.label} ${c.dim(`(${fmtSecs(e.ms)}) ${e.detail}`)}`);
    } else if (e.type === "questions") {
      log(c.dim(e.log.split("\n").map((l) => `    ${l}`).join("\n")));
    } else if (e.type === "warn") {
      log(`  ${c.yellow("⚠")} ${c.yellow(e.message)}`);
    }
  };

  const startedAt = new Date().toISOString();
  const result = await runDebate({
    topic,
    ...(material && { material }),
    seats,
    ...(judgeSeat && { judge: judgeSeat }),
    rounds: cfg.rounds,
    language: cfg.language,
    maxQuestions: cfg.maxQuestions,
    ...(repoPath && { repoPath }),
    skipSynthesis: bool(p, "no-synthesis"),
    onEvent,
  });

  const paths = await createRunDir(cfg.outDir, topic);
  const written = await writeRun(paths, result, {
    topic,
    startedAt,
    finishedAt: new Date().toISOString(),
    language: cfg.language,
    rounds: cfg.rounds,
    cast: [...castResult.debaters, ...(castResult.judge ? [castResult.judge] : [])],
    warnings: castResult.warnings,
    ...(repoPath && { repoPath }),
    ...(material?.sources && { privateMaterial: material.sources }),
  });

  const cost = summarizeCost(result.turns);
  if (!quiet) {
    log(c.bold("\n▸ Kết quả"));
    for (const w of written) log(`  ${c.green("✓")} ${w}`);
    log(
      c.dim(
        `  ${cost.ok} lượt OK${cost.failed ? `, ${cost.failed} lượt lỗi` : ""} · ` +
          `${fmtSecs(cost.totalMs)} · chi phí đã biết $${cost.knownCostUsd.toFixed(4)}` +
          `${cost.unpricedTurns ? ` (+${cost.unpricedTurns} lượt không báo giá USD)` : ""}`,
      ),
    );
    if (result.verdict) log(`  ${c.dim(`trạng thái phán quyết: ${result.verdict.status}`)}`);
    if (result.verdict?.status === "NEEDS_INPUT") {
      log(c.yellow(`\n  ⚠ Chủ tọa cần bạn trả lời các câu hỏi trong ${paths.verdict}`));
      log(c.dim(`    sau đó chạy lại kèm: -m ${paths.verdict} -m <file-trả-lời-của-bạn>`));
    }
  }

  // stdout = the artifact channel.
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          topic,
          dir: paths.dir,
          verdict: result.verdict ?? null,
          dossier: result.dossier ?? null,
          aborted: result.aborted ?? null,
          cast: castResult,
          cost,
          questions: result.questionLog,
        },
        null,
        2,
      )}\n`,
    );
  } else if (result.dossier) {
    process.stdout.write(`${result.dossier}\n`);
  }

  if (result.aborted) return 1;
  return cost.failed > 0 && cost.ok === 0 ? 1 : 0;
}

async function cmdServe(p: Parsed): Promise<number> {
  const { config, sources } = await loadConfig(one(p, "config"));
  const cfg = applyFlags(config, p);
  const roles = await loadRoles();
  const host = one(p, "host") ?? "127.0.0.1";
  const port = num(p, "port") ?? 7777;
  const tokenArg = one(p, "token");

  const pinnedBins: Record<string, string> = {};
  for (const [key, spec] of Object.entries(cfg.providers)) if (spec.bin) pinnedBins[key] = spec.bin;

  const { token, generated } = resolveToken({ host, port, ...(tokenArg && { token: tokenArg }) });
  const running = await serve(
    {
      config: cfg,
      roles,
      discover: () => discover(pinnedBins),
      toAvailable: (ps) => toAvailable(ps, cfg),
      runs: new RunManager(),
    },
    { host, port, ...(token && { token }) },
  );

  log(c.bold("agora serve"));
  log(c.dim(`cấu hình: ${sources.join(" → ")}`));
  log(`\n  ${c.green("▸")} ${c.bold(running.url)}`);
  if (token) {
    log(`  ${c.yellow("token:")} ${token}`);
    if (generated) {
      // Say why, not just what: a token nobody understands gets pasted into a chat
      // log, and this one is a key to the operator's model quota.
      log(
        c.dim(
          `  (tự sinh vì bạn bind ra ngoài localhost — bất kỳ ai mở được cổng này đều có thể\n` +
            `   tiêu quota model của bạn và cho agent đọc file trên máy, nên cần token)`,
        ),
      );
    }
    log(c.dim(`  mở: ${running.url}  rồi dán token vào ô hiện ra`));
  } else if (isLoopback(host)) {
    log(c.dim(`  chỉ máy này truy cập được. Mở ra ngoài: --host 0.0.0.0 (sẽ tự sinh token)`));
  }
  log(c.dim(`\n  Ctrl-C để dừng.`));

  // Hold the process open; the HTTP server owns the lifetime from here.
  await new Promise<void>((resolve) => {
    const stop = () => {
      log(c.dim("\nđang dừng…"));
      void running.close().then(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

// --- dispatch -----------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (e) {
    log(c.red(`${(e as Error).message}`));
    return 2;
  }

  if (bool(p, "version")) {
    process.stdout.write(`agora ${VERSION}\n`);
    return 0;
  }
  if (bool(p, "help") || p.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    if (p.command === "doctor") return await cmdDoctor(p);
    if (p.command === "roles") return await cmdRoles(p);
    if (p.command === "init") return await cmdInit(p);
    if (p.command === "serve") return await cmdServe(p);
    return await cmdDebate(p);
  } catch (e) {
    log(c.red(`\nlỗi: ${(e as Error).message}`));
    if (bool(p, "verbose")) log(c.dim(String((e as Error).stack ?? "")));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
