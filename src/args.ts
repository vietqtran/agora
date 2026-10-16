// Minimal argv parsing. No dependency, because this tool's job is to run on whatever
// server the user already has, and a zero-install binary is part of that promise.

export type Parsed = {
  command: string;
  /** Free arguments after the command. */
  rest: string[];
  flags: Map<string, string[]>;
};

/** Flags that take no value. Everything else consumes the next argv entry. */
const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "health",
  "dry-run",
  "json",
  "no-synthesis",
  "no-shared",
  "force",
  "quiet",
  "verbose",
]);

const ALIASES: Record<string, string> = {
  h: "help",
  v: "version",
  f: "file",
  r: "rounds",
  o: "out",
  c: "config",
  m: "material",
  q: "quiet",
};

export const KNOWN_COMMANDS = ["debate", "doctor", "roles", "init", "help"] as const;

export function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  let command = "";
  // Only the FIRST bare word can be a command. Without this, a topic like
  // "Hệ thống roles và quyền" would have "roles" lifted out of the middle of the
  // sentence and run as a subcommand.
  let sawPositional = false;

  const push = (name: string, value: string) => {
    const prev = flags.get(name);
    if (prev) prev.push(value);
    else flags.set(name, [value]);
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("-") && a !== "-") {
      const raw = a.replace(/^--?/, "");
      // Support --key=value as well as --key value.
      const eq = raw.indexOf("=");
      const name = (eq === -1 ? raw : raw.slice(0, eq)).toLowerCase();
      const resolved = ALIASES[name] ?? name;
      if (eq !== -1) {
        push(resolved, raw.slice(eq + 1));
        continue;
      }
      if (BOOLEAN_FLAGS.has(resolved)) {
        push(resolved, "true");
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        throw new Error(`cờ --${resolved} cần một giá trị`);
      }
      push(resolved, next);
      i++;
      continue;
    }
    // The first bare word is the command only if it IS one; otherwise the whole thing
    // is a topic, so `agora "câu hỏi"` works without typing `debate`.
    if (!sawPositional && (KNOWN_COMMANDS as readonly string[]).includes(a)) {
      command = a;
      sawPositional = true;
      continue;
    }
    sawPositional = true;
    rest.push(a);
  }

  return { command: command || "debate", rest, flags };
}

export function one(p: Parsed, name: string): string | undefined {
  return p.flags.get(name)?.at(-1);
}

export function all(p: Parsed, name: string): string[] {
  return p.flags.get(name) ?? [];
}

export function bool(p: Parsed, name: string): boolean {
  return p.flags.has(name);
}

/**
 * Round presets, so the common choice is a word rather than a guess at a number.
 * The cost of a debate is roughly linear in rounds times seats, which is exactly the
 * thing a user has no intuition for on their first run.
 */
export const ROUND_PRESETS: Record<string, number> = { fast: 1, standard: 2, deep: 4 };

/** `--rounds` accepts a preset name or a raw count. */
export function rounds(p: Parsed): number | undefined {
  const v = one(p, "rounds");
  if (v === undefined) return undefined;
  const preset = ROUND_PRESETS[v.toLowerCase()];
  if (preset !== undefined) return preset;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`--rounds cần một số nguyên >= 0 hoặc một preset (${Object.keys(ROUND_PRESETS).join(", ")}), nhận được "${v}"`);
  }
  return n;
}

export function num(p: Parsed, name: string): number | undefined {
  const v = one(p, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`cờ --${name} cần một con số, nhận được "${v}"`);
  return n;
}

/** Parse repeatable `--pin role=provider` into a map. */
export function pins(p: Parsed): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of all(p, "pin")) {
    const eq = v.indexOf("=");
    if (eq <= 0) throw new Error(`--pin cần dạng role=provider, nhận được "${v}"`);
    out[v.slice(0, eq).trim()] = v.slice(eq + 1).trim();
  }
  return out;
}

export const HELP = `agora — tranh luận có cấu trúc giữa các AI agent CLI bạn đang có

CÁCH DÙNG
  agora "<chủ đề cần nghiên cứu>"     chạy một phiên tranh luận (lệnh mặc định)
  agora debate "<chủ đề>" [tuỳ chọn]
  agora doctor [--health]             xem máy này chạy được những CLI nào
  agora roles                         liệt kê các vai chuyên gia
  agora init [--force]                sinh agora.config.json theo máy hiện tại

TUỲ CHỌN CHO debate
  -f, --file <path>        đọc chủ đề từ file (dùng cho chủ đề dài)
  -m, --material <path>    tư liệu nền cho MỌI vai (lặp lại được; file hoặc URL)
  -m <vai>:<path>          tư liệu RIÊNG chỉ một vai đọc được, vd.
                             -m domain-expert:./quy-trinh.md -m architect:./schema.sql
      --roles a,b,c        chọn các vai tham gia (mặc định theo cấu hình)
      --judge <role|none>  vai chủ tọa, hoặc none để bỏ phán quyết
      --pin role=provider  ghim một vai vào một runtime cụ thể (lặp lại được)
  -r, --rounds <n|preset>  số vòng chất vấn: fast=1, standard=2, deep=4 (mặc định 2)
      --repo <path>        cho các chuyên gia đọc repo này (chỉ đọc, qua worktree tạm)
      --lang <mã>          ngôn ngữ đầu ra (vi, en, ja, ...)
      --timeout <phút>     giới hạn mỗi lượt
      --no-synthesis       dừng sau phán quyết, chưa soạn hồ sơ
      --no-shared          không cho một runtime đóng nhiều vai
      --dry-run            chạy toàn bộ giao thức bằng runtime giả, không tốn token
  -o, --out <dir>          nơi ghi kết quả (mặc định .agora/runs)
  -c, --config <path>      dùng file cấu hình cụ thể
      --json               in kết quả dạng JSON ra stdout
  -q, --quiet              bớt log tiến trình

VÍ DỤ
  agora doctor --health
  agora --dry-run "Phần mềm quản lý tiến độ thi công cần những chức năng gì?"
  agora "Thiết kế module quản lý khối lượng cho ERP xây dựng" --rounds 3
  agora -f ./brief.md -m ./quy-trinh-hien-tai.md --pin domain-expert=antigravity
`;
