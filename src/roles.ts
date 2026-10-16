// Roles: the expert personas, loaded from markdown files so a user can add a seat at
// the table without touching TypeScript.
//
// A role declares WHAT IT NEEDS, not which CLI to use:
//   prefer: an ordered wish list of runtimes (best fit first)
//   needs:  capabilities it cannot do its job without — an unmet need blocks the cast
//   wants:  capabilities to enable when the runtime it gets happens to have them
// The caster (casting.ts) turns that into a binding against whatever is installed.
// Hard-coding "the researcher is codex" is precisely the inflexibility we are fixing.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RoleNeed = "web" | "execute";

export type Role = {
  id: string;
  name: string;
  /** Ordered runtime preference, best fit first. May be empty ("anything will do"). */
  prefer: string[];
  /** Capabilities the role is useless without — an unmet need blocks the binding. */
  needs: RoleNeed[];
  /** Capabilities to switch on when the chosen runtime happens to offer them. */
  wants: RoleNeed[];
  /** One-line description, shown by `agora roles`. */
  summary: string;
  /** "judge" roles are cast separately from the debaters. */
  kind: "debater" | "judge";
  /** Persona instructions, injected verbatim into every prompt for this role. */
  body: string;
  /** Where it was loaded from, so `agora roles` can show which copy won. */
  source: string;
};

const HERE = dirname(fileURLToPath(import.meta.url));

/** Role search path, LOWEST precedence first: builtin → user → project. */
export function roleDirs(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return [join(HERE, "..", "roles"), join(base, "agora", "roles"), join(cwd, "roles")];
}

/**
 * Minimal frontmatter: `key: value` lines between two `---` fences, then the body.
 * Deliberately not a YAML parser — the schema is five flat keys, and a real parser
 * would be a dependency on every server this has to run on.
 */
export function parseRoleFile(text: string, source: string, fallbackId: string): Role {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const head = m ? m[1] : "";
  const body = (m ? m[2] : text).trim();

  const meta = new Map<string, string>();
  head.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) throw new Error(`${source}: cannot parse frontmatter line ${i + 1}: "${line.trim()}"`);
    meta.set(kv[1].toLowerCase(), kv[2].trim());
  });

  const list = (key: string): string[] =>
    (meta.get(key) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const caps = (key: string): RoleNeed[] => {
    const bad = list(key).filter((n) => n !== "web" && n !== "execute");
    if (bad.length) throw new Error(`${source}: unknown ${key} ${bad.join(", ")} (known: web, execute)`);
    return list(key) as RoleNeed[];
  };
  const needs = caps("needs");
  const wants = caps("wants");

  const kindRaw = meta.get("kind") ?? "debater";
  if (kindRaw !== "debater" && kindRaw !== "judge") {
    throw new Error(`${source}: kind must be "debater" or "judge" (got "${kindRaw}")`);
  }

  const id = meta.get("id") ?? fallbackId;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`${source}: id must be lowercase letters, digits and hyphens (got "${id}")`);
  }
  if (!body) throw new Error(`${source}: role body is empty — there are no persona instructions to send`);

  return {
    id,
    name: meta.get("name") ?? id,
    prefer: list("prefer"),
    needs,
    wants,
    summary: meta.get("summary") ?? "",
    kind: kindRaw,
    body,
    source,
  };
}

/** Load every role on the search path. Later directories override earlier ones by id. */
export async function loadRoles(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<Map<string, Role>> {
  const roles = new Map<string, Role>();
  for (const dir of roleDirs(cwd, env)) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue; // an absent directory on the search path is normal, not an error
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".md")) continue;
      const path = join(dir, name);
      const text = await readFile(path, "utf8");
      const role = parseRoleFile(text, path, name.replace(/\.md$/, ""));
      roles.set(role.id, role);
    }
  }
  return roles;
}
